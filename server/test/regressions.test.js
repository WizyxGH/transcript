/**
 * Regression tests for the transcript server and its OCR worker.
 *
 * Each test pins a bug that already happened:
 * - TelDrive was reached through a hard-coded host that no longer existed
 *   (teldrive.wizyx.blitz.cloud, 404) instead of Archiving-Helper's .env;
 * - a storage outage turned every queued page into "failed";
 * - a memory spike in Paddle took the whole machine's commit;
 * - the supervisor must restart crashes but not loop on a setup error.
 *
 * Run: npm test   (from apps/transcript/server)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '../../..');

/** Load config.js in a fresh process with only the given .env as Archiving-Helper's. */
function loadConfig(envFileContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-cfg-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, envFileContent);
  const env = { ...process.env, ARCHIVING_HELPER_ENV: envFile };
  delete env.TELDRIVE_API_HOST;
  delete env.TELDRIVE_PUBLIC_URL;
  try {
    const out = execFileSync(process.execPath, ['-e', `
      const c = require(${JSON.stringify(path.join(SERVER, 'config.js'))});
      process.stdout.write(JSON.stringify({ local: c.TELDRIVE_LOCAL_URL, public: c.TELDRIVE_PUBLIC_URL }));
    `], { env, encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('TelDrive addresses come from Archiving-Helper\'s .env', () => {
  const cfg = loadConfig('TELDRIVE_API_HOST=http://teldrive:8080\nTELDRIVE_PUBLIC_URL="https://drive.example"\n');
  assert.deepEqual(cfg, { local: 'http://teldrive:8080', public: 'https://drive.example' });
});

test('no TelDrive key means no address, not a guessed default', () => {
  assert.deepEqual(loadConfig('OTHER=1\n'), { local: null, public: null });
});

test('no TelDrive host or Tailscale IP is hard-coded', () => {
  const STALE_HOST = /teldrive\.wizyx\.blitz\.cloud/;
  // 100.64.0.0/10: the CGNAT range Tailscale assigns addresses from.
  const TAILSCALE_IP = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test', '__pycache__'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|py|md)$/.test(entry.name)) files.push(full);
    }
  };
  walk(SERVER);
  const workflows = path.join(REPO, '.github', 'workflows');
  if (fs.existsSync(workflows)) {
    for (const f of fs.readdirSync(workflows)) files.push(path.join(workflows, f));
  }
  const offenders = files.filter((f) => {
    const text = fs.readFileSync(f, 'utf8');
    return STALE_HOST.test(text) || TAILSCALE_IP.test(text);
  }).map((f) => path.relative(REPO, f));
  assert.deepEqual(offenders, []);
});

// ── ocr_worker.py ────────────────────────────────────────────────────────────

/** Python with Pillow (imported by ocr_worker at module level), or null. */
function findPython() {
  for (const [cmd, args] of [['py', ['-3.12']], ['py', ['-3']], ['python', []]]) {
    const r = spawnSync(cmd, [...args, '-c', 'import PIL'], { stdio: 'ignore' });
    if (r.status === 0) return { cmd, args };
  }
  return null;
}
const python = findPython();

/** Run Python against ocr_worker; the last stdout line is returned. */
function worker(code) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  delete env.PYTHONPATH;
  const out = execFileSync(python.cmd, [...python.args, '-c', `import ocr_worker as w\n${code}`], {
    cwd: SERVER, env, encoding: 'utf8',
  });
  return out.trim().split(/\r?\n/).pop();
}

test('memory exhaustion is recognised, other errors are not', { skip: !python }, () => {
  assert.equal(worker(`
cases = [
  "Unable to allocate 2.23 MiB for an array with shape (960, 608) and data type int32",
  "ResourceExhaustedError: Out of memory error on GPU 0",
  "CUDNN_STATUS_ALLOC_FAILED",
  "Page 'x.jpg' not found in unpacked archive",
]
print([w._is_cuda_oom(Exception(c)) for c in cases])`), '[True, True, True, False]');
});

test('storage probe: readable file yes, missing file no, hung read no', { skip: !python }, () => {
  assert.equal(worker(`
import time, builtins
here = w._storage_responds(w.__file__)
missing = w._storage_responds(w.__file__ + ".missing")
# A dead network mount does not fail, it hangs: simulate it.
def hung_open(*a, **k):
    time.sleep(30)
w.open = hung_open
t = time.time()
hung = w._storage_responds("T:/whatever.cbr", timeout=1)
print(here, missing, hung, round(time.time() - t) <= 2)`), 'True False False True');
});

test('supervisor restarts crashes but not setup errors or a finished queue', { skip: !python }, () => {
  assert.equal(worker(`
print([
  w.should_restart(w.EXIT_CODE_GPU_OOM, 5),   # memory exhausted: always
  w.should_restart(3221226505, 600),          # native crash mid-run
  w.should_restart(1, 2),                     # dies at start: setup error
  w.should_restart(0, 600),                   # queue drained
])`), '[True, True, False, False]');
});

test('memory cap turns an oversized allocation into MemoryError', { skip: !python || process.platform !== 'win32' }, () => {
  assert.equal(worker(`
import numpy as np
w._cap_own_memory(1500)
try:
    np.ones(2000 * 1024 * 1024 // 8)
    print("allocated")
except MemoryError as e:
    print("capped", w._is_cuda_oom(e))`), 'capped True');
});

test('OCR pauses while the machine is short of memory, then resumes', { skip: !python }, () => {
  assert.equal(worker(`
readings = iter([500, 900, 2500])          # MB free: low, low, enough
slept = []
waits = w.wait_for_free_commit(2000, free=lambda: next(readings), sleep=slept.append, poll_s=7)
unknown = w.wait_for_free_commit(2000, free=lambda: None, sleep=slept.append)
print(waits, slept, unknown, w.free_commit_mb() is None or w.free_commit_mb() > 0)`), '2 [7, 7] 0 True');
});

test('a page that exhausts memory twice is given up, not retried forever', { skip: !python }, () => {
  assert.equal(worker(`
import sqlite3
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE page (id INTEGER PRIMARY KEY, state TEXT, error TEXT, updated_at INTEGER)")
db.execute("INSERT INTO page VALUES (1, 'pending', NULL, 0), (2, 'pending', NULL, 0)")
err = MemoryError("Unable to allocate 7.17 MiB")
first = w.record_oom(db, 1, err)
after_first = db.execute("SELECT state, error FROM page WHERE id = 1").fetchone()
second = w.record_oom(db, 1, err)
after_second = db.execute("SELECT state FROM page WHERE id = 1").fetchone()[0]
# A success in between (store() clears error) resets the count.
w.record_oom(db, 2, err)
db.execute("UPDATE page SET error = NULL WHERE id = 2")
again = w.record_oom(db, 2, err)
# The machine as a whole was short of memory: not the page's fault, nothing counted.
db.execute("INSERT INTO page VALUES (3, 'pending', 'oom-attempts:1', 0)")
short = w.record_oom(db, 3, err, machine_short=True)
after_short = db.execute("SELECT state, error FROM page WHERE id = 3").fetchone()
print(first, after_first, second, after_second, again, short, after_short)`),
  "False ('pending', 'oom-attempts:1') True failed False False ('pending', 'oom-attempts:1')");
});

test('an archive with no readable page is an error, not an empty issue', () => {
  const { listPages } = require('../library');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-lib-'));
  try {
    // TelDrive-encrypted bytes: UnRAR exits 0 and lists nothing.
    const encrypted = path.join(dir, 'be_MMN_99.cbr');
    fs.writeFileSync(encrypted, Buffer.concat([Buffer.from('TELDRIVE\0\0'), Buffer.alloc(4096, 7)]));
    // An empty zip: just the end-of-central-directory record.
    const empty = path.join(dir, 'xx_EMPTY_1.cbz');
    fs.writeFileSync(empty, Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18)]));

    assert.throws(() => listPages(empty), /no image page found/);
    // TelDrive-encrypted bytes: rejected from their header, before UnRAR is even run.
    assert.throws(() => listPages(encrypted), /TelDrive-encrypted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor waits for room for a whole worker before every launch', { skip: !python }, () => {
  assert.equal(worker(`
exits = iter([w.EXIT_CODE_GPU_OOM, 0])      # memory exhausted once, then queue drained
waited, clock = [], iter(range(0, 10000, 100))
rc = w.supervise(["worker"], call=lambda c: next(exits), wait=waited.append,
                 now=lambda: next(clock), sleep=lambda s: None)
need = w.MIN_FREE_COMMIT_MB + w.MEMORY_LIMIT_MB
print(rc, waited == [need, need], need > w.MIN_FREE_COMMIT_MB)`), '0 True True');
});

test('story pages: one definition, both vocabularies, same in Python and JS', { skip: !python }, () => {
  const { storyPageSql } = require('../searchdb');
  const py = worker('print(w.story_page_sql())');
  assert.equal(py, storyPageSql(), 'ocr_worker.story_page_sql() drifted from searchdb.storyPageSql()');

  // 'story' (segmentation.js) was invisible to the old filter: 12 588 pages skipped.
  assert.equal(worker(`
import sqlite3
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE page (id INTEGER, kind TEXT, title TEXT)")
db.executemany("INSERT INTO page VALUES (?, ?, ?)", [
  (1, "n", "T"), (2, "story", "T"), (3, "k", None), (4, None, "T"),
  (5, "editorial", "Edito"), (6, "c", None), (7, None, None), (8, "", "T")])
ids = [r[0] for r in db.execute("SELECT id FROM page WHERE " + w.story_page_sql() + " ORDER BY id")]
print(ids)`), '[1, 2, 3, 4, 8]');
});

test('OCR reads every page by default, stories only on request', { skip: !python }, () => {
  assert.equal(worker(`
import inspect
print(inspect.signature(w.pending_pages).parameters["stories_only"].default)`), 'False');
});

test('extraction failing for lack of memory is not blamed on the archive', { skip: !python }, () => {
  assert.equal(worker(`
import subprocess
def cpe(rc): return subprocess.CalledProcessError(rc, ["UnRAR.exe"])
class PagefileTooSmall(OSError): winerror = 1455
print([
  w._is_resource_failure(cpe(3221225794)),   # 0xC0000142 as Python reports it (seen for real)
  w._is_resource_failure(cpe(-1073741502)),  # same status, signed
  w._is_resource_failure(MemoryError()),
  w._is_resource_failure(PagefileTooSmall()),
  w._is_resource_failure(cpe(3)),            # UnRAR CRC error: a genuinely bad archive
  w._is_resource_failure(FileNotFoundError("page missing")),
])`), '[True, True, True, True, False, False]');
});

test('zip pages are listed from the archive tail only, encrypted files rejected up front', () => {
  const L = require('../library');

  // Minimal zip: a stored file of 200 KB of padding, then 3 entries, so the central
  // directory sits outside the first 66 KB but listZipEntries must still find it.
  const files = [['p10.jpg', Buffer.alloc(200000, 1)], ['p2.jpg', Buffer.from('b')], ['notes.txt', Buffer.from('c')]];
  const locals = []; const cds = []; let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); cds.push(cd, n); offset += 30 + n.length + data.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(3, 8);
  eocd.writeUInt16LE(3, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...locals, cdBuf, eocd]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  try {
    const f = path.join(dir, 'x.cbz');
    fs.writeFileSync(f, zip);
    assert.deepEqual(L.listZipEntries(f).map((e) => e.name), L.parseCentralDirectory(zip).map((e) => e.name));
    assert.deepEqual(L.listPages(f), ['p2.jpg', 'p10.jpg']);
    assert.equal(L.readZipEntry(zip, 'p2.jpg').toString(), 'b');


    const enc = path.join(dir, 'y.cbr');
    fs.writeFileSync(enc, Buffer.concat([Buffer.from('TELDRIVE'), Buffer.alloc(64)]));
    assert.throws(() => L.listPages(enc), /TelDrive-encrypted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a storage hiccup (EIO) is retried, a genuinely bad file is not', () => {
  const { listPagesRetrying } = require('../library');
  const err = (code) => Object.assign(new Error(code), { code });
  const quiet = console.warn; console.warn = () => {};
  try {
    let calls = 0; const slept = [];
    const flaky = () => { calls++; if (calls < 2) throw err('EIO'); return ['p1.jpg']; };
    assert.deepEqual(listPagesRetrying('x.cbz', { read: flaky, sleepMs: (ms) => slept.push(ms), delayMs: 5 }), ['p1.jpg']);
    assert.deepEqual([calls, slept], [2, [5]]);

    calls = 0;
    const alwaysEio = () => { calls++; throw err('EIO'); };
    assert.throws(() => listPagesRetrying('x.cbz', { read: alwaysEio, sleepMs: () => {}, attempts: 3 }), /EIO/);
    assert.equal(calls, 3);

    calls = 0;
    const encrypted = () => { calls++; throw new Error('TelDrive-encrypted file'); };
    assert.throws(() => listPagesRetrying('x.cbr', { read: encrypted, sleepMs: () => assert.fail('slept') }), /encrypted/);
    assert.equal(calls, 1);
  } finally {
    console.warn = quiet;
  }
});

test('a story printed in several issues comes back as its Inducks entries, pages kept apart', async () => {
  const Database = require('better-sqlite3');
  const { sqliteAdapter } = require('../searchdb');
  const { ROUTES } = require('../searchcore');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE page (id INTEGER PRIMARY KEY, entrycode TEXT, storycode TEXT, issuecode TEXT, languagecode TEXT,
    pageno INTEGER, confidence REAL, reviewed INTEGER, n_boxes INTEGER, text TEXT, state TEXT,
    width INTEGER, height INTEGER, kind TEXT, title TEXT)`);
  const add = db.prepare(`INSERT INTO page (entrycode, issuecode, languagecode, pageno, text, state, kind)
    VALUES (?, ?, ?, ?, ?, 'done', 'n')`);
  // Same pagenos in both issues: merged, they could not be told apart.
  for (const n of [12, 13]) add.run('fr/JMC    5a', 'fr/JMC    5', 'fr', n, `fr ${n}`);
  for (const n of [12, 13]) add.run('fr/JM 3244a', 'fr/JM 3244', 'fr', n, `jm ${n}`);
  add.run('fr/JM 3244b', 'fr/JM 3244', 'fr', 14, 'other story');

  const findStory = () => [   // Inducks order, local titles
    { entrycode: 'fr/JM 3244a', issuecode: 'fr/JM 3244', title: 'Duel au paintball!' },
    { entrycode: 'fr/JMC    5a', issuecode: 'fr/JMC    5', title: 'Duel au paintball (Compil)' },
    { entrycode: 'it/TL 2000a', issuecode: 'it/TL 2000', title: 'not owned' },
  ];
  const out = await ROUTES['/entry'](sqliteAdapter(db), { storycode: 'FC JM 3244' }, { findStory });
  const body = out.body;
  assert.equal(body.storycode, 'FC JM 3244');
  assert.deepEqual(body.entries.map((e) => [e.entrycode, e.title, e.pages.map((p) => p.text)]), [
    ['fr/JM 3244a', 'Duel au paintball!', ['jm 12', 'jm 13']],
    ['fr/JMC    5a', 'Duel au paintball (Compil)', ['fr 12', 'fr 13']],
  ]);
  assert.equal(body.pageCount, 4);

  // An issue on its own is the same shape: one entry per story it contains.
  const issue = (await ROUTES['/entry'](sqliteAdapter(db), { code: 'fr/JM 3244' }, {})).body;
  assert.deepEqual(issue.entries.map((e) => e.entrycode), ['fr/JM 3244a', 'fr/JM 3244b']);
});

test('extraction time allowed grows with the archive size (a flat 60 s failed 200 MB archives)', { skip: !python }, () => {
  assert.equal(worker(`
print([round(w.extract_timeout_s(n)) for n in (0, 50e6, 200e6, 1e9)])`), '[180, 280, 580, 2180]');
});

test('coverage groups issues by their Inducks publication, not by cutting the issuecode', () => {
  const { groupByPublication } = require('../routes/health');
  const issue = (issuecode, total, done) => ({ issuecode, country: 'x', total_pages: total, done_pages: done, pending_pages: total - done, conf_sum: done * 0.9 });
  const pubOf = new Map([
    ['lu/LW600305', { publicationcode: 'lu/LW', title: 'Lustige Woche' }],   // no space before the number
    ['lu/LW600224', { publicationcode: 'lu/LW', title: 'Lustige Woche' }],
    ['it/TL 1000', { publicationcode: 'it/TL', title: 'Topolino' }],
  ]);
  const rows = groupByPublication([issue('lu/LW600305', 20, 0), issue('lu/LW600224', 16, 4), issue('it/TL 1000', 198, 188), issue('zz/UNKNOWN 1', 5, 0)], pubOf);
  assert.deepEqual(rows.map((r) => [r.publication, r.issues, r.total_pages, r.done_pages, r.first_issue]), [
    ['it/TL', 1, 198, 188, 'it/TL 1000'],
    ['lu/LW', 2, 36, 4, 'lu/LW600224'],
    ['zz/UNKNOWN 1', 1, 5, 0, 'zz/UNKNOWN 1'],    // not in Inducks: kept, under its own code
  ]);
  assert.equal(rows[1].completion_rate, '11.1%');
});

test('start.js restarts a stopped part, backing off while it keeps dying at once', () => {
  const { restartDelayMs, RESTART_MIN_MS, RESTART_MAX_MS, HEALTHY_RUN_MS } = require('../scripts/start');
  assert.equal(restartDelayMs(HEALTHY_RUN_MS + 1, 0), RESTART_MIN_MS);              // first stop
  assert.equal(restartDelayMs(2000, RESTART_MIN_MS), RESTART_MIN_MS * 2);           // died at once: back off
  assert.equal(restartDelayMs(2000, RESTART_MAX_MS), RESTART_MAX_MS);               // capped
  assert.equal(restartDelayMs(HEALTHY_RUN_MS, RESTART_MAX_MS), RESTART_MIN_MS);     // ran well: reset
});

test('watchdog: a silent worker is killed and restarted, a live one is left alone', { skip: !python }, () => {
  assert.equal(worker(`
import sys, time
silent = [sys.executable, "-c", "import time; time.sleep(120)"]
alive = [sys.executable, "-c", "import os, time, pathlib; [(pathlib.Path(os.environ['OCR_HEARTBEAT_FILE']).touch(), time.sleep(0.5)) for _ in range(6)]"]
t = time.time()
rc_silent = w.run_watched(silent, stall_s=2, poll_s=0.5, kill_wait_s=10, unstick=lambda: None)
took = time.time() - t
rc_alive = w.run_watched(alive, stall_s=2, poll_s=0.5, kill_wait_s=10, unstick=lambda: None)
print([rc_silent == w.EXIT_CODE_STALLED, took < 30, rc_alive, w.should_restart(w.EXIT_CODE_STALLED, 5)])`), '[True, True, 0, True]');
});

test('OCR and API use the same search database, never D: (scans only)', { skip: !python }, () => {
  const { DATABASE_DIR } = require('../config');
  const py = worker('print(w.SEARCH_DB)');
  assert.equal(path.resolve(py).toLowerCase(), path.resolve(DATABASE_DIR, 'search.sqlite').toLowerCase());
  assert.doesNotMatch(py, /^D:/i);
});
