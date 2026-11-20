/**
 * server/routes/search.js
 * Keyword search over the OCR'd pages of the personal scan library.
 *
 * Routes:
 *   GET  /api/search?q=tondeuse          → hits, each pointing at issue + page
 *   GET  /api/search?q=…&entries=1      → grouped by entry ("found in which entries")
 *   GET  /api/search/entry?code=…        → every page of one entry, in order
 *   GET  /api/search/progress            → state of the OCR pass
 *   GET  /api/search/page?id=123         → one page's text + review
 *   POST /api/search/page                → save a corrected transcription
 *   GET  /api/search/page/image?id=123   → the scan itself, for side-by-side review
 *   GET  /api/search/issues              → indexed issues, with OCR status
 *
 * The GET routes are searchcore.js's ROUTES, shared with the hosted API
 * (apps/transcript/worker); only what needs this machine stays here: the scans
 * (T:), the Inducks database (storycodes) and writes.
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { SCRATCH_DIR } = require('../config');
const { getSearchDb, sqliteAdapter, saveReview, CONFIDENCE_FLOOR } = require('../searchdb');
const { ROUTES } = require('../searchcore');
const { extractPage } = require('../library');
const { getCoaDb } = require('../db');

let adapter = null;
const db = () => adapter || (adapter = sqliteAdapter(getSearchDb()));

/** Storycode → its entries, from the Inducks database (absent on the hosted API). */
function findStory(storycode) {
  try {
    return getCoaDb().prepare(`
      SELECT e.entrycode, e.issuecode, e.title
      FROM inducks_storyversion sv
      JOIN inducks_entry e ON sv.storyversioncode = e.storyversioncode
      WHERE REPLACE(sv.storycode, ' ', '') = ?
    `).all(storycode.replace(/\s+/g, ''));
  } catch {
    return null;                 // Inducks database unavailable: fall through
  }
}

const OPTIONS = {
  confidenceFloor: CONFIDENCE_FLOOR,
  findStory,
  imageUrl: (id) => `/api/search/page/image?id=${id}`,
  // Local-only fields: where the page lives on this machine.
  extraPageFields: ['pagename', 'archive', 'error'],
};

for (const [route, handle] of Object.entries(ROUTES)) {
  router.get(route || '/', async (req, res) => {
    try {
      const out = await handle(db(), req.query, OPTIONS);
      res.status(out.status).type(out.type);
      res.send(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * GET /api/search/page/image?id=N — the scan itself.
 * Extracted from the archive on demand into a temp dir and removed afterwards, so
 * the review screen can show the page next to its transcription.
 */
router.get('/page/image', async (req, res) => {
  const db = getSearchDb();
  const id = parseInt(req.query.id, 10);
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const page = db.prepare('SELECT * FROM page WHERE id = ?').get(id);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const tmp = fs.mkdtempSync(path.join(SCRATCH_DIR, 'review-'));
  try {
    const file = extractPage(page.archive, page.pagename, tmp);
    const ext = path.extname(file).toLowerCase() || '.jpg';
    res.set('Content-Type', ext === '.png' ? 'image/png' : 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=600');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    // The response streams asynchronously; clean up once it has been sent.
    res.on('finish', () => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }
});

/**
 * POST /api/search/page — save a corrected transcription.
 * The correction outranks the OCR: the page is flagged reviewed so a later OCR
 * run will not overwrite it.
 */
router.post('/page', (req, res) => {
  try {
    const db = getSearchDb();
    const { id, text } = req.body || {};
    if (!id || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing id or text' });
    }
    saveReview(db, parseInt(id, 10), text);
    res.json({ ok: true, id: parseInt(id, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;