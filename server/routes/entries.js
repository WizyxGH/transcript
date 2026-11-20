/**
 * server/routes/entries.js
 * Returns entries for a given issue, with full scan URLs and transcription status
 * 
 * Scan URL construction:
 *   sitecode='webusers'    → https://inducks.org/{url}
 *   sitecode='thumbnails'  → https://thumbnails.inducks.org/{url}
 *   sitecode='thumbnails2' → https://thumbnails.inducks.org/{url}
 *   other                  → skip or use direct url field if already full URL
 */
const express = require('express');
const router = express.Router();
const { getCoaDb, getTranscriptionsDb } = require('../db');

// Build outducks path from sitecode + url — exact logic from DucksManager issue-details/index.ts
// Rules (lines 114-118):
//   url starts with digit    → prefix = 'webusers/webusers'
//   url starts with 'webusers' → prefix = 'webusers'
//   else                       → prefix = sitecode.replace(/thumbnails2?/, '')
// → fullPath = `${prefix}/${url}`
// → access via: https://inducks.org/hr.php?normalsize=1&image=https://outducks.org/${fullPath}
function buildOutducksPath(sitecode, url) {
  if (!url) return null;
  let prefix;
  if (/^\d/.test(url)) {
    prefix = 'webusers/webusers';
  } else if (url.startsWith('webusers')) {
    prefix = 'webusers';
  } else {
    prefix = (sitecode || '').replace(/thumbnails2?/, '');
  }
  return `${prefix}/${url}`.replace(/\/+/g, '/').replace(/^\//, '');
}

function buildScanUrl(sitecode, url) {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const outducksPath = buildOutducksPath(sitecode, url);
  // Inducks' own gateway (works without a session for public scans), served
  // through our same-origin proxy so the browser can both display and OCR it.
  return `/api/scan?url=${encodeURIComponent(`https://inducks.org/hr.php?normalsize=1&image=https://outducks.org/${outducksPath}`)}`;
}

/**
 * GET /api/issues/entries?code=eg%2FSM+1781
 */
router.get('/entries', (req, res) => {
  try {
    const db = getCoaDb();
    const tdb = getTranscriptionsDb();
    const issuecode = req.query.code;
    if (!issuecode) return res.status(400).json({ error: 'Missing code query param' });

    const entries = db.prepare(`
      SELECT 
        e.entrycode,
        e.storyversioncode,
        e.title,
        e.reallytitle,
        e.languagecode,
        e.position,
        e.part,
        e.printedhero
      FROM inducks_entry e
      WHERE e.issuecode = ?
      ORDER BY e.position, e.entrycode
    `).all(issuecode);

    // Get all scan URLs for these entries (all pages, best quality per page)
    const entryCodes = entries.map(e => `'${e.entrycode.replace(/'/g, "''")}'`).join(',');
    let urlMap = {};
    if (entryCodes.length > 0) {
      const urls = db.prepare(`
        SELECT entrycode, sitecode, url, pagenumber, public
        FROM inducks_entryurl
        WHERE entrycode IN (${entryCodes})
          AND public = 'Y'
        ORDER BY
          CAST(pagenumber AS INTEGER),
          CASE sitecode WHEN 'webusers' THEN 0 WHEN 'thumbnails2' THEN 2 WHEN 'thumbnails' THEN 3 ELSE 1 END
      `).all();
      // For each (entrycode, pagenumber) keep only the first (= best quality) URL
      const pagesSeen = new Set();
      for (const u of urls) {
        const pageKey = `${u.entrycode}#${u.pagenumber}`;
        if (pagesSeen.has(pageKey)) continue; // already have best URL for this page
        const fullUrl = buildScanUrl(u.sitecode, u.url);
        if (!fullUrl) continue;
        pagesSeen.add(pageKey);
        if (!urlMap[u.entrycode]) urlMap[u.entrycode] = [];
        urlMap[u.entrycode].push({ url: fullUrl, sitecode: u.sitecode, page: u.pagenumber });
      }
    }

    // Get transcriptions
    const transcriptMap = {};
    tdb.prepare('SELECT entrycode, title, ocr_raw, validated FROM transcriptions').all()
      .forEach(t => { transcriptMap[t.entrycode] = t; });

    const result = entries.map(e => {
      const scans = urlMap[e.entrycode] || [];
      const transcript = transcriptMap[e.entrycode];
      const needsTitle = !e.title || e.title.trim() === '' || e.reallytitle !== 'Y';
      // reallytitle='Y' means this IS the real printed title, 'N' means it's a transcription from another language

      return {
        entrycode: e.entrycode,
        storyversioncode: e.storyversioncode,
        languagecode: e.languagecode,
        inducks_title: e.title || null,
        reallytitle: e.reallytitle,
        position: e.position,
        part: e.part,
        printedhero: e.printedhero,
        scan_urls: scans.map(s => s.url),
        sitecodes: scans.map(s => s.sitecode),
        has_scan: scans.length > 0,
        needs_title: needsTitle,
        transcription: transcript ? {
          title: transcript.title,
          ocr_raw: transcript.ocr_raw,
          validated: !!transcript.validated,
        } : null,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/issues/info?code=eg%2FSM+1781
 */
router.get('/info', (req, res) => {
  try {
    const db = getCoaDb();
    const issuecode = req.query.code;
    if (!issuecode) return res.status(400).json({ error: 'Missing code query param' });

    const issue = db.prepare(`
      SELECT i.*, p.title AS pub_title, p.languagecode AS pub_languagecode, p.countrycode AS pub_countrycode
      FROM inducks_issue i
      JOIN inducks_publication p ON p.publicationcode = i.publicationcode
      WHERE i.issuecode = ?
    `).get(issuecode);

    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    res.json(issue);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
