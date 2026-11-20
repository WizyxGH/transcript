/**
 * scripts/start.js — everything the PC side needs, in one command.
 *
 *   node scripts/start.js            (or double-click apps/transcript/start.cmd)
 *
 * 1. Scan library (T:, TelDrive): if it is not reachable, run Archiving-Helper's
 *    `mount_drive.py remount` and wait for it (TelDrive sleeps; waking takes 1–2 min).
 * 2. API server (node index.js, port 3001): local search + the push of new pages
 *    to the hosted copy every TRANSCRIPT_SYNC_MS, when TRANSCRIPT_TURSO_URL is set.
 * 3. OCR worker (py -3.12 -u ocr_worker.py --continuous): supervised, resumes
 *    where it stopped.
 * 4. Indexing (index-library.js then segment-library.js), once: registers the archives
 *    added since the last run (those already known are skipped in 0 ms).
 *
 * API and OCR are kept alive: if one stops, the cause goes to its log and it is started
 * again. Every part writes a timestamped log in LOG_DIR (config.js): the console goes
 * away with its window, and an OCR that stopped mid-morning left no trace of why.
 * A part already running is not started twice. Ctrl+C stops what this script started.
 * The public API itself runs on Cloudflare and needs nothing from here.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { SCAN_LIBRARY, AH_ENV, LOG_DIR, config } = require('../config');

const SERVER = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3001);
const PYTHON = config('TRANSCRIPT_PYTHON', 'py -3.12').split(/\s+/);
const MOUNT_SCRIPT = path.resolve(path.dirname(AH_ENV), '..', 'mount-drive', 'mount_drive.py');
const MOUNT_WAIT_MS = 4 * 60 * 1000;

// Restarting a kept-alive part: quickly after a long run, backing off while it keeps
// dying at once (broken install, port taken) so it does not spin.
const RESTART_MIN_MS = 30 * 1000;
const RESTART_MAX_MS = 10 * 60 * 1000;
const HEALTHY_RUN_MS = 5 * 60 * 1000;

const children = new Set();
let stopping = false;

const stamp = () => new Date().toLocaleTimeString('fr-FR', { hour12: false });
const say = (msg) => console.log(`${stamp()} [start] ${msg}`);

/** Delay before restarting a part that ran `ranMs`, the previous delay being `previousMs`. */
function restartDelayMs(ranMs, previousMs = 0) {
  if (ranMs >= HEALTHY_RUN_MS || !previousMs) return RESTART_MIN_MS;
  return Math.min(previousMs * 2, RESTART_MAX_MS);
}

/** Append-only log of one part, one file per day: logs/ocr-2026-10-31.log. */
function logFile(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  return fs.createWriteStream(path.join(LOG_DIR, `${name}-${day}.log`), { flags: 'a' });
}

async function apiRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/search/progress`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ids of running processes whose command line matches `pattern` (Windows).
 * The PowerShell doing the lookup carries the pattern in its own command line: it
 * is left out, or `index-library|segment-library` always found "itself" running.
 */
function running(pattern) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' -and $_.ProcessId -ne ${process.pid} -and $_.Name -notmatch '^(powershell|pwsh)\.exe$' } | ForEach-Object { $_.ProcessId }`,
  ], { encoding: 'utf8' });
  return (r.stdout || '').split(/\s+/).filter(Boolean);
}

/** Readable within a few seconds? A dead mount hangs instead of failing. */
function libraryReachable() {
  const r = spawnSync(process.execPath, ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(SCAN_LIBRARY)}) ? 0 : 1)`],
    { timeout: 10000 });
  return r.status === 0;
}

async function ensureLibrary() {
  if (libraryReachable()) return say(`bibliothèque OK : ${SCAN_LIBRARY}`);
  if (!fs.existsSync(MOUNT_SCRIPT)) {
    return say(`bibliothèque introuvable (${SCAN_LIBRARY}) et ${MOUNT_SCRIPT} absent : l'OCR attendra le montage`);
  }
  say(`bibliothèque injoignable : réveil de TelDrive et remontage (${path.basename(MOUNT_SCRIPT)} remount)…`);
  spawnSync(PYTHON[0], [...PYTHON.slice(1), MOUNT_SCRIPT, 'remount'], { stdio: 'inherit' });
  const until = Date.now() + MOUNT_WAIT_MS;
  while (Date.now() < until) {
    if (libraryReachable()) return say('bibliothèque montée');
    await new Promise((r) => setTimeout(r, 10000));
  }
  say("bibliothèque toujours injoignable : l'OCR laisse les pages en attente et reprendra seul");
}

/**
 * Start one part. Its output goes to the console and to its log, every line stamped.
 * `keepAlive`: start it again whenever it stops. `then`: run once it has exited.
 */
function launch(name, cmd, args, { keepAlive = false, then = null } = {}, previousDelay = 0) {
  const log = logFile(name);
  const write = (out, line) => {
    const stamped = `${stamp()} [${name}] ${line}\n`;
    out.write(stamped);
    log.write(stamped);
  };
  write(process.stdout, `lancement : ${path.basename(cmd)} ${args.join(' ')}`);
  const started = Date.now();
  const child = spawn(cmd, args, { cwd: SERVER, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  children.add(child);
  const prefix = (stream, out) => {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) write(out, line);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('error', (err) => write(process.stderr, `impossible de lancer : ${err.message}`));
  child.on('exit', (code, signal) => {
    children.delete(child);
    const ran = Date.now() - started;
    write(process.stdout, `arrêté (code ${code}${signal ? `, signal ${signal}` : ''}) après ${Math.round(ran / 1000)} s`);
    log.end();
    if (stopping) return;
    if (then) then(code);
    if (!keepAlive) return;
    const delay = restartDelayMs(ran, previousDelay);
    say(`${name} relancé dans ${Math.round(delay / 1000)} s`);
    setTimeout(() => !stopping && launch(name, cmd, args, { keepAlive, then }, delay), delay);
  });
}

async function main() {
  await ensureLibrary();

  if (await apiRunning()) say(`API déjà en route sur le port ${PORT}`);
  else launch('api', process.execPath, ['index.js'], { keepAlive: true });

  const workers = running('ocr_worker\\.py');
  if (workers.length) say(`OCR déjà en route (pid ${workers.join(', ')})`);
  else launch('ocr', PYTHON[0], [...PYTHON.slice(1), '-u', 'ocr_worker.py', '--continuous'], { keepAlive: true });

  if (running('index-library|segment-library').length) say('indexation déjà en route');
  else {
    launch('index', process.execPath, ['scripts/index-library.js'], {
      then: () => launch('index', process.execPath, ['scripts/segment-library.js']),
    });
  }

  if (!children.size) return say('tout tourne déjà, rien à lancer');
  say(`Ctrl+C pour arrêter ce qui a été lancé ici · logs : ${LOG_DIR}`);
}

process.on('SIGINT', () => {
  stopping = true;
  for (const c of children) c.kill();
  process.exit(0);
});

if (require.main === module) {
  main().catch((e) => { console.error('start failed:', e.message); process.exit(1); });
}

module.exports = { running, restartDelayMs, RESTART_MIN_MS, RESTART_MAX_MS, HEALTHY_RUN_MS };
