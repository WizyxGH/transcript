/**
 * Tests for Pipeline Versioning & Structured OCR backward compatibility:
 * - Schema columns (pipeline_version, structured_text)
 * - saveOcrResult support for v2
 * - handleEntry / handlePage / handleProgress / handleIssues endpoints
 * - Reprocessing filters (issues?needs_repass=1)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { sqliteAdapter, saveOcrResult, registerIssuePages } = require('../searchdb');
const core = require('../searchcore');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE page (
      id            INTEGER PRIMARY KEY,
      entrycode     TEXT,
      issuecode     TEXT NOT NULL,
      country       TEXT,
      languagecode  TEXT,
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
      state         TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      pipeline_version INTEGER NOT NULL DEFAULT 1,
      structured_text  TEXT,
      reviewed      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch()),
      updated_at    INTEGER DEFAULT (unixepoch()),
      UNIQUE (issuecode, archive, pagename)
    );

    CREATE VIRTUAL TABLE page_fts USING fts5(
      text,
      tokenize = "unicode61 remove_diacritics 2"
    );
  `);
  return db;
}

test('pipeline versioning: schema defaults to v1 and saveOcrResult supports v2 structured data', () => {
  const db = createTestDb();
  registerIssuePages(db, 'it/TL 3704', '/scans/it_TL_3704.cbz', ['p1.jpg', 'p2.jpg']);

  // Page 1: OCR v1 (flat text only)
  saveOcrResult(db, 1, {
    text: 'TOPOLINO E IL MISTERO',
    confidence: 0.95,
    nBoxes: 5,
    engine: 'paddle',
    ms: 120,
    width: 800,
    height: 1200,
  });

  const p1 = db.prepare('SELECT * FROM page WHERE id = 1').get();
  assert.equal(p1.pipeline_version, 1);
  assert.equal(p1.structured_text, null);

  // Page 2: OCR v2 (structured OCR with dialogue, panels and speakers)
  const structuredMock = JSON.stringify({
    page: 'p2.jpg',
    panel_count: 2,
    panels: [
      {
        panel_index: 1,
        characters_present: ['DD'],
        elements: [{ type: 'speech', text: 'CIAO PAPERINO', speaker: 'DD' }],
      },
    ],
  });

  saveOcrResult(db, 2, {
    text: 'CIAO PAPERINO',
    confidence: 0.98,
    nBoxes: 2,
    engine: 'paddle+vision',
    ms: 350,
    width: 800,
    height: 1200,
    pipeline_version: 2,
    structured_text: structuredMock,
  });

  const p2 = db.prepare('SELECT * FROM page WHERE id = 2').get();
  assert.equal(p2.pipeline_version, 2);
  assert.equal(p2.structured_text, structuredMock);
});

test('API endpoints: backward compatibility for flat text search and structured payload delivery', async () => {
  const db = createTestDb();
  const adapter = sqliteAdapter(db);
  registerIssuePages(db, 'it/TL 3704', '/scans/it_TL_3704.cbz', ['p1.jpg', 'p2.jpg']);

  const structuredMock = JSON.stringify({
    panels: [{ panel_index: 1, elements: [{ speaker: 'DD', text: 'CIAO PAPERINO' }] }],
  });

  saveOcrResult(db, 1, {
    text: 'TOPOLINO E IL MISTERO',
    confidence: 0.95,
    nBoxes: 5,
    engine: 'paddle',
    ms: 120,
    pipeline_version: 1,
  });

  saveOcrResult(db, 2, {
    text: 'CIAO PAPERINO',
    confidence: 0.98,
    nBoxes: 2,
    engine: 'paddle+vision',
    ms: 350,
    pipeline_version: 2,
    structured_text: structuredMock,
  });

  // 1. Search works seamlessly on both v1 and v2 pages via FTS5
  const searchV1 = await core.handleSearch(adapter, { q: 'mistero' });
  assert.equal(searchV1.body.total, 1);
  assert.equal(searchV1.body.hits[0].id, 1);

  const searchV2 = await core.handleSearch(adapter, { q: 'paperino' });
  assert.equal(searchV2.body.total, 1);
  assert.equal(searchV2.body.hits[0].id, 2);

  // 2. /entry returns pipeline_version and structured_text
  const entryRes = await core.handleEntry(adapter, { code: 'it/TL 3704' });
  assert.equal(entryRes.status, 200);
  const pages = entryRes.body.entries[0].pages;
  assert.equal(pages[0].pipeline_version, 1);
  assert.equal(pages[0].structured_text, null);
  assert.equal(pages[1].pipeline_version, 2);
  assert.equal(pages[1].structured_text, structuredMock);

  // 3. /page returns pipeline_version and structured_text
  const page1Res = await core.handlePage(adapter, { id: 1 });
  assert.equal(page1Res.body.pipeline_version, 1);
  assert.equal(page1Res.body.structured_text, null);

  const page2Res = await core.handlePage(adapter, { id: 2 });
  assert.equal(page2Res.body.pipeline_version, 2);
  assert.equal(page2Res.body.structured_text, structuredMock);

  // 4. /progress reports pipeline breakdown and reprocess needs
  const progressRes = await core.handleProgress(adapter);
  assert.equal(progressRes.body.pipeline_version_latest, 2);
  assert.equal(progressRes.body.pipeline_v1, 1);
  assert.equal(progressRes.body.pipeline_v2, 1);
  assert.equal(progressRes.body.reprocess_needed, 1);

  // 5. /issues reports pending_repass and filters with needs_repass=1
  const issuesAll = await core.handleIssues(adapter, {});
  assert.equal(issuesAll.body.length, 1);
  assert.equal(issuesAll.body[0].pending_repass, 1);

  const issuesRepass = await core.handleIssues(adapter, { needs_repass: '1' });
  assert.equal(issuesRepass.body.length, 1);

  // Upgrade page 1 to v2: pending_repass drops to 0
  db.prepare('UPDATE page SET pipeline_version = 2 WHERE id = 1').run();
  const issuesRepassAfter = await core.handleIssues(adapter, { needs_repass: '1' });
  assert.equal(issuesRepassAfter.body.length, 0);
});
