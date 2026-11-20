/**
 * server/routes/scan.js
 * Scan proxy: GET /api/scan?url=<hr.php or outducks URL>
 *
 * Inducks serves public scans through its hr.php gateway
 * (https://inducks.org/hr.php?normalsize=1&image=https://outducks.org/<path>),
 * which works without a session for public images but has no CORS headers, so
 * the browser could show them but never read the pixels for OCR. This proxy
 * fetches the bytes once (disk cache in data/scans/), serves them same-origin,
 * and is reused by the OCR route.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../db');

const CACHE = path.join(DATA_DIR, 'scans');
fs.mkdirSync(CACHE, { recursive: true });

const ALLOWED = /^https:\/\/(inducks\.org|outducks\.org|res\.cloudinary\.com)\//;

async function fetchScan(url) {
  if (!ALLOWED.test(url)) throw new Error('URL not allowed (inducks.org / outducks.org / cloudinary only)');
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const file = path.join(CACHE, key);
  if (fs.existsSync(file) && fs.existsSync(file + '.type')) {
    return { buffer: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') };
  }
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://inducks.org/' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching scan`);
  const type = r.headers.get('content-type') || 'image/jpeg';
  if (!type.startsWith('image/')) throw new Error(`Not an image (${type}) - login may be required for this scan`);
  const buffer = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buffer);
  fs.writeFileSync(file + '.type', type);
  return { buffer, type };
}

router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    const { buffer, type } = await fetchScan(String(url));
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
module.exports.fetchScan = fetchScan;
