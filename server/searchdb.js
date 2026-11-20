/**
 * server/searchdb.js
 * The search database: OCR'd page text + the FTS5 index over it.
 *
 * One row per (entry, page). A keyword hit therefore resolves to an entrycode and
 * a page number, which is what the UI needs to answer "found in which entries".
 *
 * OCR is a one-off pass over the library; this database is its durable result, so
 * a page is never OCR'd twice and searching costs nothing per query.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./db');

const { DATABASE_DIR, SCRATCH_DIR } = require('./config');
const core = require('./searchcore');
const SEARCH_DB = process.env.SEARCH_DB || path.join(DATABASE_DIR, 'search.sqlite');

// A page whose mean OCR confidence is below this is not trusted enough to index:
// it would put words in the results that the scan does not contain.
const CONFIDENCE_FLOOR = Number(process.env.OCR_CONFIDENCE_FLOOR || core.DEFAULT_CONFIDENCE_FLOOR);

let _db = null;

function getSearchDb() {
  if (_db) return _db;
  _db = new Database(SEARCH_DB);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('mmap_size = 536870912'); // 512 MB memory-mapped I/O
  _db.pragma('cache_size = -64000'); // 64 MB cache
  _db.pragma('temp_store = MEMORY');
  _db.pragma('busy_timeout = 60000');
  _db.exec(`
    -- One OCR'd page. entrycode is nullable because the library gives us a whole
    -- issue at a time and the story split inside it is detected later.
    CREATE TABLE IF NOT EXISTS page (
      id            INTEGER PRIMARY KEY,
      entrycode     TEXT,
      issuecode     TEXT NOT NULL,
      country       TEXT,
      languagecode  TEXT,
      -- Inducks title of the entry, denormalised at segmentation time.
      -- Fetching it per query cost ~21 ms per lookup: the Inducks database is
      -- 1.2 GB on a slow disk and every read misses the cache. A title is
      -- metadata that changes only when the library is re-indexed, so it is
      -- stored next to the page that belongs to it.
      title         TEXT,
      storycode     TEXT,
      kind          TEXT,
      pageno        INTEGER NOT NULL,
      archive       TEXT NOT NULL,
      pagename      TEXT NOT NULL,
      width         INTEGER,
      height        INTEGER,
      text          TEXT,
      confidence    REAL,
      n_boxes       INTEGER,
      ocr_engine    TEXT,
      ocr_ms        INTEGER,
      -- 'pending' = queued, 'done' = OCR'd, 'failed' = gave up (kept, not retried forever)
      state         TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      -- pipeline_version: 1 = simple text OCR, 2 = structured dialogue + panels + speakers
      pipeline_version INTEGER NOT NULL DEFAULT 1,
      structured_text  TEXT,
      -- set when a human has corrected the OCR text; corrections outrank the OCR
      reviewed       INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch()),
      updated_at    INTEGER DEFAULT (unixepoch()),
      UNIQUE (issuecode, archive, pagename)
    );

    CREATE INDEX IF NOT EXISTS idx_page_entry   ON page(entrycode);
    CREATE INDEX IF NOT EXISTS idx_page_story   ON page(storycode);
    CREATE INDEX IF NOT EXISTS idx_page_issue   ON page(issuecode);
    CREATE INDEX IF NOT EXISTS idx_page_state   ON page(state);
    CREATE INDEX IF NOT EXISTS idx_page_pending ON page(state, issuecode, pageno);
    CREATE INDEX IF NOT EXISTS idx_page_version ON page(state, pipeline_version);

    -- Full-text index over the recognised text only. 'pending' pages are absent,
    -- so results never contain a page that has not been read yet.
    CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
      text,
      content = 'page',
      content_rowid = 'id',
      tokenize = "unicode61 remove_diacritics 2"
    );
  `);

  // Migrations for existing databases
  const existingCols = _db.pragma('table_info(page)').map((c) => c.name);
  if (!existingCols.includes('pipeline_version')) {
    _db.exec('ALTER TABLE page ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 1');
  }
  if (!existingCols.includes('structured_text')) {
    _db.exec('ALTER TABLE page ADD COLUMN structured_text TEXT');
  }

  return _db;
}

/**
 * Rebuild the FTS index from the page table. Cheap enough to run after a batch
 * (seconds for a hundred thousand rows) and exact: it is derived, never patched.
 */
function rebuildFts(db = getSearchDb()) {
  const t0 = Date.now();
  db.exec("INSERT INTO page_fts(page_fts) VALUES('rebuild')");
  db.exec(`INSERT INTO page_fts(page_fts) VALUES('optimize')`);
  return Date.now() - t0;
}

/**
 * Register the pages of an issue so they can be queued for OCR.
 * Idempotent: re-running on the same archive updates nothing that already exists.
 */
function registerIssuePages(db, issuecode, archivePath, pages, { entrycode = null, country = null, languagecode = null } = {}) {
  const stmt = db.prepare(`
    INSERT INTO page (entrycode, issuecode, country, languagecode, pageno, archive, pagename, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT (issuecode, archive, pagename) DO NOTHING
  `);
  const tx = db.transaction(() => {
    let added = 0;
    pages.forEach((pagename, i) => {
      const info = stmt.run(entrycode, issuecode, country, languagecode, i + 1, archivePath, pagename);
      added += info.changes;
    });
    return added;
  });
  return tx();
}

/** Store the OCR result for one page and put its text into the index. */
function saveOcrResult(db, pageId, { text, confidence, nBoxes, engine, ms, width, height, pipeline_version = 1, structured_text = null }) {
  const row = db.prepare('SELECT reviewed FROM page WHERE id = ?').get(pageId);
  if (!row) throw new Error(`page ${pageId} not found`);

  // With an external-content FTS5 table, delete old index tokens before updating the content row.
  if (!row.reviewed) {
    try {
      db.prepare('DELETE FROM page_fts WHERE rowid = ?').run(pageId);
    } catch {}
  }

  db.prepare(`
    UPDATE page SET text = ?, confidence = ?, n_boxes = ?, ocr_engine = ?, ocr_ms = ?,
                    width = ?, height = ?, pipeline_version = ?, structured_text = ?,
                    state = 'done', error = NULL, updated_at = unixepoch()
    WHERE id = ?
  `).run(text || '', confidence, nBoxes, engine, ms, width || null, height || null, pipeline_version, structured_text || null, pageId);

  // A reviewed page keeps the corrected text; re-running the OCR must not undo it.
  if (row.reviewed) return;
  if (text && text.trim() && confidence >= CONFIDENCE_FLOOR) {
    try {
      db.prepare('INSERT INTO page_fts (rowid, text) VALUES (?, ?)').run(pageId, text);
    } catch {
      try { db.exec("INSERT INTO page_fts(page_fts) VALUES('rebuild')"); } catch {}
    }
  }
}

/** Replace a page's text with a human correction, and reindex it. */
function saveReview(db, pageId, text) {
  const row = db.prepare('SELECT confidence FROM page WHERE id = ?').get(pageId);
  if (!row) throw new Error(`page ${pageId} not found`);
  db.prepare(`
    UPDATE page SET text = ?, reviewed = 1, state = 'done', updated_at = unixepoch()
    WHERE id = ?
  `).run(text, pageId);
  db.prepare('DELETE FROM page_fts WHERE rowid = ?').run(pageId);
  db.prepare('INSERT INTO page_fts (rowid, text) VALUES (?, ?)').run(pageId, text);
}

/** Mark a page as unreadable (blank, corrupt) so the queue moves on. */
function markPageFailed(db, pageId, error) {
  db.prepare(`
    UPDATE page SET state = 'failed', error = ?, updated_at = unixepoch() WHERE id = ?
  `).run(String(error || '').slice(0, 500), pageId);
}

/**
 * Adapter giving searchcore.js its async view of a better-sqlite3 database.
 * Prepared statements are cached: the same few queries run on every request.
 */
function sqliteAdapter(db) {
  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql); cache.set(sql, st); }
    return st;
  };
  return {
    all: async (sql, params = []) => prep(sql).all(...params),
    get: async (sql, params = []) => prep(sql).get(...params),
  };
}

/** Progress of the OCR pass (async: the logic lives in searchcore.js). */
function progress(db = getSearchDb()) {
  return core.progress(sqliteAdapter(db), CONFIDENCE_FLOOR);
}

module.exports = {
  SEARCH_DB,
  SCRATCH_DIR,
  CONFIDENCE_FLOOR,
  STORY_KINDS: core.STORY_KINDS,
  storyPageSql: core.storyPageSql,
  sqliteAdapter,
  getSearchDb,
  rebuildFts,
  registerIssuePages,
  saveOcrResult,
  saveReview,
  markPageFailed,
  progress,
};