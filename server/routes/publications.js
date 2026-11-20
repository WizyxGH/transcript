/**
 * server/routes/publications.js
 * Lists publications/issues that have entries with missing titles AND scan URLs
 * Also includes incompletely indexed issues
 */
const express = require('express');
const router = express.Router();
const { getCoaDb, getTranscriptionsDb } = require('../db');

/**
 * GET /api/publications
 * Returns publications with candidate issues (missing titles + scan available)
 * Query params: ?search=... &country=...
 */
router.get('/', (req, res) => {
  try {
    const db = getCoaDb();
    const { search, country } = req.query;

    let where = '';
    const params = [];

    if (search) {
      where += ` AND (p.publicationcode LIKE ? OR p.title LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
    if (country) {
      where += ` AND p.publicationcode LIKE ?`;
      params.push(`${country}/%`);
    }

    const sql = `
      SELECT 
        p.publicationcode,
        p.title AS pub_title,
        SUBSTR(p.publicationcode, 1, INSTR(p.publicationcode, '/') - 1) AS country,
        COUNT(DISTINCT i.issuecode) AS issue_count,
        COUNT(DISTINCT CASE 
          WHEN (e.title IS NULL OR e.title = '') AND eu.entrycode IS NOT NULL 
          THEN e.entrycode 
        END) AS missing_titles_with_scan,
        COUNT(DISTINCT e.entrycode) AS total_entries
      FROM inducks_publication p
      JOIN inducks_issue i ON i.publicationcode = p.publicationcode
      JOIN inducks_entry e ON e.issuecode = i.issuecode
      LEFT JOIN inducks_entryurl eu ON eu.entrycode = e.entrycode
      WHERE 1=1 ${where}
      GROUP BY p.publicationcode
      HAVING missing_titles_with_scan > 0
      ORDER BY missing_titles_with_scan DESC
      LIMIT 500
    `;

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/publications/top-issues
 * Returns a list of 20 random issues that need transcription
 */
router.get('/top-issues', (req, res) => {
  try {
    const db = getCoaDb();
    const sql = `
      SELECT i.issuecode, p.title as pub_title
      FROM inducks_issue i
      JOIN inducks_publication p ON i.publicationcode = p.publicationcode
      JOIN inducks_entry e ON e.issuecode = i.issuecode
      JOIN inducks_entryurl eu ON eu.entrycode = e.entrycode AND eu.sitecode IN ('webusers', 'thumbnails', 'thumbnails2', 'thumbnails3')
      WHERE (e.title IS NULL OR e.title = '' OR e.reallytitle != 'Y')
      GROUP BY i.issuecode
      ORDER BY p.title ASC, i.issuecode ASC
      LIMIT 100
    `;
    const rows = db.prepare(sql).all();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/publications/issues?pub=FR/MM
 * Returns issues for a publication with missing title stats
 * Using query param to avoid path-to-regexp issues with slashes
 */
router.get('/issues', (req, res) => {
  try {
    const db = getCoaDb();
    const tdb = getTranscriptionsDb();
    const pubcode = req.query.pub;
    if (!pubcode) return res.status(400).json({ error: 'Missing pub query param' });

    const issues = db.prepare(`
      SELECT 
        i.issuecode,
        i.title AS issue_title,
        i.fullyindexed,
        COUNT(e.entrycode) AS total_entries,
        COUNT(CASE WHEN (e.title IS NULL OR e.title = '') THEN 1 END) AS missing_titles,
        COUNT(CASE WHEN (e.title IS NULL OR e.title = '') AND eu.entrycode IS NOT NULL THEN 1 END) AS missing_with_scan
      FROM inducks_issue i
      LEFT JOIN inducks_entry e ON e.issuecode = i.issuecode
      LEFT JOIN inducks_entryurl eu ON eu.entrycode = e.entrycode
      WHERE i.publicationcode = ?
      GROUP BY i.issuecode
      HAVING missing_with_scan > 0 OR i.fullyindexed = 'N'
      ORDER BY i.issuecode
    `).all(pubcode);

    const result = issues.map(issue => ({
      ...issue,
      status: issue.fullyindexed === 'Y' ? 'complete' : 
              issue.fullyindexed === 'N' ? 'incomplete' : 'unknown'
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
