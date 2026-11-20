/**
 * server/db.js
 * SQLite connection & schema initialization
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Inducks data: reuse InducksButBetter's SQLite (same ISV tables) instead of
// downloading the ISV again (inducks.org now sits behind Anubis, which blocks
// plain downloads). INDUCKS_SQLITE overrides; data/coa.sqlite is the legacy fallback.
//
// better-sqlite3 cannot open a .gz, so the uncompressed database is needed. The
// build leaves one in public/datas/ (`db:build --keep-sqlite`), but that is 1.2 GB
// The uncompressed database is 1.2 GB and C: has only a few GB free, so it is
// unpacked onto D: (INDUCKS_DB_DIR) rather than into the repo — the
// `public/datas/inducks.sqlite` left by `db:build --keep-sqlite` is what filled C:.
// Only the ~300 MB .gz stays in the repo, and that is what the deploy publishes.
const { DATABASE_DIR } = require('./config');
const INDUCKS_DB_DIR = DATABASE_DIR;
const IBB_DATAS = path.join(__dirname, '..', '..', 'InducksButBetter', 'public', 'datas');
const SHARED_ROOT_SQLITE = path.resolve(__dirname, '../../../data/inducks-db/inducks.sqlite');
const CANDIDATES = [
  path.join(INDUCKS_DB_DIR, 'inducks.sqlite'),   // D:\inducks-db ou TRANSCRIPT_DB_DIR
  SHARED_ROOT_SQLITE,                            // data/inducks-db/inducks.sqlite racine monorepo
  path.join(IBB_DATAS, 'inducks.sqlite'),          // left by db:build --keep-sqlite
];
const DB_PATH = process.env.INDUCKS_SQLITE
  || CANDIDATES.find((p) => fs.existsSync(p))
  || path.join(DATA_DIR, 'coa.sqlite');
const TRANSCRIPTIONS_PATH = path.join(DATA_DIR, 'transcriptions.sqlite');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// A silent fallback here reads like "the Inducks tables are empty" further down, which is
// a confusing way to learn that the database was never built. Say it once, at startup.
if (!process.env.INDUCKS_SQLITE
    && !CANDIDATES.some((p) => fs.existsSync(p))
    && fs.existsSync(path.join(IBB_DATAS, 'inducks.sqlite.gz'))) {
  console.warn(
    `[transcript] only the compressed database was found in InducksButBetter/public/datas.\n` +
      `[transcript] better-sqlite3 needs it uncompressed. Unpack it with:\n` +
            `[transcript]   node scripts/unpack-inducks-db.js\n` +
      `[transcript] or rebuild it next to the .gz:\n` +
      `[transcript]   pnpm --filter @disney/inducks-but-better db:build --keep-sqlite`
  );
}

let _db = null;
let _tdb = null;

function getCoaDb() {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true }); // read-only: no journal/pragma writes
    _db.pragma('foreign_keys = ON');
    _db.pragma('mmap_size = 1073741824'); // 1 GB memory-mapped I/O
    _db.pragma('cache_size = -64000'); // 64 MB cache
    _db.pragma('temp_store = MEMORY');
  }
  return _db;
}

function getTranscriptionsDb() {
  if (!_tdb) {
    _tdb = new Database(TRANSCRIPTIONS_PATH);
    _tdb.pragma('journal_mode = WAL');
    _tdb.exec(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        entrycode TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        ocr_raw TEXT,
        validated INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS progress (
        issuecode TEXT PRIMARY KEY,
        status TEXT DEFAULT 'pending',
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `);
  }
  return _tdb;
}

module.exports = { getCoaDb, getTranscriptionsDb, DB_PATH, DATA_DIR };
