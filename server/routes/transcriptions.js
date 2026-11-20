/**
 * server/routes/transcriptions.js
 * Save & retrieve manual/OCR-validated transcriptions
 * Uses query params to avoid Express 5 path issues with slashes in issue/entry codes
 */
const express = require('express');
const router = express.Router();
const { getTranscriptionsDb, getCoaDb } = require('../db');

/**
 * GET /api/transcriptions?code=eg%2FSM+1781A
 */
router.get('/', (req, res) => {
  const tdb = getTranscriptionsDb();
  const entrycode = req.query.code;
  if (!entrycode) return res.status(400).json({ error: 'Missing code query param' });
  const row = tdb.prepare('SELECT * FROM transcriptions WHERE entrycode = ?').get(entrycode);
  res.json(row || null);
});

/**
 * POST /api/transcriptions
 * Body: { entrycode, title, ocr_raw?, validated? }
 */
router.post('/', (req, res) => {
  const tdb = getTranscriptionsDb();
  const { entrycode, title, ocr_raw, validated } = req.body;
  if (!entrycode || title === undefined) {
    return res.status(400).json({ error: 'Missing entrycode or title' });
  }

  tdb.prepare(`
    INSERT INTO transcriptions (entrycode, title, ocr_raw, validated, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(entrycode) DO UPDATE SET
      title = excluded.title,
      ocr_raw = excluded.ocr_raw,
      validated = excluded.validated,
      updated_at = excluded.updated_at
  `).run(entrycode, title.trim(), ocr_raw || null, validated ? 1 : 0);

  res.json({ ok: true });
});

/**
 * DELETE /api/transcriptions?code=eg%2FSM+1781A
 */
router.delete('/', (req, res) => {
  const tdb = getTranscriptionsDb();
  const entrycode = req.query.code;
  if (!entrycode) return res.status(400).json({ error: 'Missing code query param' });
  tdb.prepare('DELETE FROM transcriptions WHERE entrycode = ?').run(entrycode);
  res.json({ ok: true });
});

module.exports = router;
