/**
 * server/hosted.js
 * Copy of the search index on Turso, read by the hosted API (apps/transcript/worker)
 * so search works while this PC is off.
 *
 * Direction is one way: this machine OCRs and owns search.sqlite; the hosted
 * database only receives. Every change to a page is queued by SQLite triggers
 * (hosted_dirty), whoever made it — Node scripts or the Python OCR worker — and
 * pushed in batches by syncHosted(). A row re-queued while being pushed keeps its
 * new sequence number and is pushed again on the next pass, never lost.
 *
 * Only OCR'd pages (state 'done') are copied: Turso bills every row written and
 * the free plan allows 10 M a month, shared with other projects; the 500 000
 * registered-but-unread pages would cost half a million writes for nothing.
 * Counts of pending pages reach the API through the precomputed statistics.
 * Also not copied: where the page lives on this machine (archive, pagename),
 * OCR timings and error messages.
 *
 * Config (process.env → Archiving-Helper's .env, see config.js):
 *   TRANSCRIPT_TURSO_URL         libsql://<db>-<org>.turso.io
 *   TRANSCRIPT_TURSO_TOKEN       full-access token (this machine writes)
 *   TRANSCRIPT_TURSO_READ_TOKEN  read-only token, given to the Worker at deploy
 *   TRANSCRIPT_SYNC_MS           how often the API server pushes (default 60000)
 */
const { config } = require('./config');
const core = require('./searchcore');

const HOSTED_URL = config('TRANSCRIPT_TURSO_URL', null);
const HOSTED_TOKEN = config('TRANSCRIPT_TURSO_TOKEN', null);
const HOSTED_READ_TOKEN = config('TRANSCRIPT_TURSO_READ_TOKEN', null);
const SYNC_MS = Number(config('TRANSCRIPT_SYNC_MS', 60000));
const STATS_PUSH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours to preserve Turso write quotas
let lastStatsPushTime = 0;

/** Columns copied to the hosted page table, in order. */
const HOSTED_COLUMNS = [
  'id', 'entrycode', 'storycode', 'issuecode', 'country', 'languagecode', 'title', 'kind', 'pageno',
  'width', 'height', 'text', 'confidence', 'n_boxes', 'ocr_engine', 'state', 'reviewed', 'updated_at',
];

const HOSTED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS page (
     id INTEGER PRIMARY KEY, entrycode TEXT, storycode TEXT, issuecode TEXT NOT NULL, country TEXT,
     languagecode TEXT, title TEXT, kind TEXT, pageno INTEGER NOT NULL, width INTEGER,
     height INTEGER, text TEXT, confidence REAL, n_boxes INTEGER, ocr_engine TEXT,
     state TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS idx_page_entry ON page(entrycode)',
  'CREATE INDEX IF NOT EXISTS idx_page_issue ON page(issuecode)',
  // The hosted database bills every row read: /search/entry resolves codes with
  // REPLACE(…, ' ', ''), which would scan the whole table without these.
  "CREATE INDEX IF NOT EXISTS idx_page_entry_flat ON page(REPLACE(entrycode, ' ', ''))",
  "CREATE INDEX IF NOT EXISTS idx_page_issue_flat ON page(REPLACE(issuecode, ' ', ''))",
  // Own copy of the text (not external content): a page is replaced by rowid
  // without knowing its old text, which external-content FTS5 needs.
  `CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
     text, tokenize = "unicode61 remove_diacritics 2")`,
  // Precomputed progress/issues: counting 500 000 rows per request would be billed
  // as 500 000 rows read each time.
  'CREATE TABLE IF NOT EXISTS stats (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)',
  `CREATE TABLE IF NOT EXISTS api_key (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, key_hash TEXT NOT NULL UNIQUE,
     origins TEXT NOT NULL DEFAULT '*', created_at INTEGER DEFAULT (unixepoch()),
     revoked_at INTEGER)`,
];

/** Columns whose change must reach the hosted copy (an error message does not). */
const WATCHED = HOSTED_COLUMNS.filter((c) => c !== 'id' && c !== 'updated_at');
const NEXT_SEQ = '(SELECT COALESCE(MAX(seq), 0) + 1 FROM hosted_dirty)';

/** Install the change queue on the local database; first install queues every page. */
function ensureLocalQueue(db) {
  const existed = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'hosted_dirty'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_dirty (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_hosted_dirty_seq ON hosted_dirty(seq);
    CREATE TRIGGER IF NOT EXISTS hosted_page_insert AFTER INSERT ON page BEGIN
      INSERT OR REPLACE INTO hosted_dirty (id, seq) VALUES (NEW.id, ${NEXT_SEQ});
    END;
    CREATE TRIGGER IF NOT EXISTS hosted_page_update AFTER UPDATE OF ${WATCHED.join(', ')} ON page BEGIN
      INSERT OR REPLACE INTO hosted_dirty (id, seq) VALUES (NEW.id, ${NEXT_SEQ});
    END;
    CREATE TRIGGER IF NOT EXISTS hosted_page_delete AFTER DELETE ON page BEGIN
      INSERT OR REPLACE INTO hosted_dirty (id, seq) VALUES (OLD.id, ${NEXT_SEQ});
    END;
  `);
  if (!existed) db.exec("INSERT OR IGNORE INTO hosted_dirty (id, seq) SELECT id, 0 FROM page WHERE state = 'done'");
}

/** Same rule as the local index: trusted OCR, or a human correction. */
function indexable(page, floor) {
  return page.state === 'done' && String(page.text || '').trim() !== ''
    && (page.reviewed === 1 || Number(page.confidence) >= floor);
}

/**
 * Statements replacing one page, or removing it when it is gone or no longer
 * OCR'd (deleting an absent row writes nothing).
 */
function pageStatements(id, page, floor) {
  const stmts = [{ sql: 'DELETE FROM page_fts WHERE rowid = ?', args: [id] }];
  if (!page || page.state !== 'done') {
    stmts.push({ sql: 'DELETE FROM page WHERE id = ?', args: [id] });
    return stmts;
  }
  const cols = HOSTED_COLUMNS;
  stmts.push({
    sql: `INSERT INTO page (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
          ON CONFLICT (id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
    args: cols.map((c) => page[c] ?? null),
  });
  if (indexable(page, floor)) {
    stmts.push({ sql: 'INSERT INTO page_fts (rowid, text) VALUES (?, ?)', args: [id, page.text] });
  }
  return stmts;
}

/** Push the precomputed progress and issue list the Worker serves. */
async function pushStats(local, remote, floor) {
  const adapter = require('./searchdb').sqliteAdapter(local);
  const now = Math.floor(Date.now() / 1000);
  const values = {
    progress: await core.progress(adapter, floor),
    issues: await core.issues(adapter, floor),
    meta: { confidence_floor: floor, synced_at: now },
  };
  await remote.batch(Object.entries(values).map(([name, value]) => ({
    sql: 'INSERT OR REPLACE INTO stats (name, value, updated_at) VALUES (?, ?, ?)',
    args: [name, JSON.stringify(value), now],
  })), 'write');
}

/**
 * Push every queued page, then the statistics if anything changed.
 * Returns { pushed, remaining } — remaining > 0 only when `maxBatches` stopped it.
 */
async function syncHosted(local, remote, { floor, batchSize = 400, maxBatches = Infinity, forceStats = false, log = () => {} } = {}) {
  ensureLocalQueue(local);
  await remote.batch(HOSTED_SCHEMA.map((sql) => ({ sql, args: [] })), 'write');

  const next = local.prepare(`
    SELECT d.id AS qid, d.seq AS qseq, p.*
    FROM hosted_dirty d LEFT JOIN page p ON p.id = d.id
    ORDER BY d.seq, d.id LIMIT ?
  `);
  const done = local.prepare('DELETE FROM hosted_dirty WHERE id = ? AND seq = ?');
  const ack = local.transaction((rows) => { for (const r of rows) done.run(r.qid, r.qseq); });

  let pushed = 0;
  for (let b = 0; b < maxBatches; b++) {
    const rows = next.all(batchSize);
    if (!rows.length) break;
    const stmts = rows.flatMap((r) => pageStatements(r.qid, r.id == null ? null : r, floor));
    await remote.batch(stmts, 'write');
    ack(rows);
    pushed += rows.length;
    log(`  ${pushed} pages poussées`);
  }
  const remaining = local.prepare('SELECT COUNT(*) AS n FROM hosted_dirty').get().n;
  const now = Date.now();
  const minInterval = process.env.NODE_ENV === 'test' ? 0 : STATS_PUSH_INTERVAL_MS;
  if (pushed && (forceStats || (now - lastStatsPushTime >= minInterval))) {
    await pushStats(local, remote, floor);
    lastStatsPushTime = now;
  }
  return { pushed, remaining };
}

/** Turso client for this machine (full access). */
function hostedClient({ url = HOSTED_URL, authToken = HOSTED_TOKEN } = {}) {
  if (!url) {
    throw new Error('TRANSCRIPT_TURSO_URL is not set (Archiving-Helper .env); run scripts/hosted-setup.js first');
  }
  const { createClient } = require('@libsql/client');
  return createClient({ url, authToken });
}

module.exports = {
  HOSTED_URL, HOSTED_TOKEN, HOSTED_READ_TOKEN, SYNC_MS,
  HOSTED_COLUMNS, HOSTED_SCHEMA,
  ensureLocalQueue, indexable, pageStatements, pushStats, syncHosted, hostedClient,
};
