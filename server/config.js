/**
 * server/config.js
 * Machine-specific paths, read from Archiving-Helper's centralised config.
 *
 * Archiving-Helper already owns "where things live on this machine" — its
 * src/core/config.mjs resolves TARGET_ARCHIVE_PATH (the scan library) from
 * process.env, then download-files/.env, then a default. This app is CommonJS and
 * cannot import that ESM module, so it reads the same two sources with the same
 * precedence instead of inventing a second set of hard-coded paths.
 *
 * Why it matters here: C: has only a few GB free, and both the uncompressed Inducks
 * database (1.2 GB) and the growing search index belong off it.
 *
 * Precedence, per key: process.env → Archiving-Helper's .env → default below.
 */
const fs = require('fs');
const path = require('path');

// server → transcript → apps → DisneyComicsHub → Sites → Projets: Archiving-Helper
// sits in Projets/Automatisations, a sibling of Sites. ocr_worker.py derives the
// same path the same way; ARCHIVING_HELPER_ENV overrides both.
const ROOT = path.resolve(__dirname, '../../../../..');
const AH_ENV_CANDIDATES = [
  process.env.ARCHIVING_HELPER_ENV,
  path.join(ROOT, 'Automatisations', 'Archiving-Helper', 'tools', 'download-files', '.env'),
  path.join(ROOT, 'Automatisations', 'Archiving-Helper', 'download-files', '.env'),
].filter(Boolean);
const AH_ENV = AH_ENV_CANDIDATES.find((p) => fs.existsSync(p)) || AH_ENV_CANDIDATES[0];

let dotEnv = null;

/** Archiving-Helper's .env, read once and only if it exists. */
function readDotEnv() {
  if (dotEnv !== null) return dotEnv;
  dotEnv = {};
  try {
    for (const rawLine of fs.readFileSync(AH_ENV, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      // Quotes are stripped so TARGET_ARCHIVE_PATH="D:\Mon Dossier" works.
      const value = line.slice(i + 1).trim().replace(/^["'](.*)["']$/, '$1');
      if (key) dotEnv[key] = value;
    }
  } catch {
    dotEnv = {};                 // no .env: the defaults are enough
  }
  return dotEnv;
}

/** First non-empty value among process.env, the .env, then the fallback. */
function config(key, fallback) {
  for (const candidate of [process.env[key], readDotEnv()[key]]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return fallback;
}

/**
 * The scan library — TARGET_ARCHIVE_PATH in Archiving-Helper.
 * Archives are named <cc>_<CODE>_<num>.cbr and live under country directories.
 */
const SCAN_LIBRARY = config('TARGET_ARCHIVE_PATH', String.raw`D:\Duckburg Archives\Disney comics`);

/**
 * Where mutable, bulky data lives: the uncompressed Inducks database (1.2 GB) and
 * search.sqlite. Off C: on purpose. TRANSCRIPT_DB_DIR overrides.
 *
 * D: is not always mounted. Defaulting to it regardless left the server looking in a
 * directory that cannot exist while the unpack script wrote elsewhere, so the fallback
 * is decided here, once, for every consumer (db.js, unpack-inducks-db.js).
 */
const DEFAULT_DB_DIR = path.resolve(__dirname, '../../../data/inducks-db');
// Never D:: it holds scans only. Preferring D:\inducks-db whenever it was plugged in sent
// the OCR (which had its own copy of this rule) to an old database while the API read
// the real one. ocr_worker.py mirrors this default; a test keeps the two identical.
const DATABASE_DIR = config('TRANSCRIPT_DB_DIR', DEFAULT_DB_DIR);

/**
 * Scratch space for unpacked scan pages. Same drive as the library, so a scan is
 * read from and written to the same volume. SCRATCH_DIR overrides.
 */
const SCRATCH_DIR = config('SCRATCH_DIR', SCAN_LIBRARY);

/**
 * TelDrive addresses, from Archiving-Helper's .env (keys documented in its
 * .env.example). No fallback here on purpose: the defaults live once, in
 * Archiving-Helper's src/core/config.py, and a second copy is how this app ended up
 * pinging a host that no longer existed. Missing key = feature off.
 *   local  — direct Tailscale address (MagicDNS name), what the T: mount uses
 *   public — Cloudflare address; the only one that wakes the sleeping host
 */
const TELDRIVE_LOCAL_URL = config('TELDRIVE_API_HOST', null);
const TELDRIVE_PUBLIC_URL = config('TELDRIVE_PUBLIC_URL', null);
/** How often the server pings the public address so the host does not fall asleep. */
const TELDRIVE_KEEPALIVE_MS = 3 * 60 * 1000;

/**
 * Where scripts/start.js writes one timestamped log per part (api, ocr, index).
 * Its console vanishes with its window: without files, a stopped OCR left no trace.
 * Program logs, not data: kept next to the code, out of the scan and database folders.
 */
const LOG_DIR = config('TRANSCRIPT_LOG_DIR', path.resolve(__dirname, 'logs'));

module.exports = {
  ROOT, AH_ENV, config, SCAN_LIBRARY, DATABASE_DIR, SCRATCH_DIR, LOG_DIR,
  TELDRIVE_LOCAL_URL, TELDRIVE_PUBLIC_URL, TELDRIVE_KEEPALIVE_MS,
};