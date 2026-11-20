/**
 * server/routes/ocr.js
 * OCR of a scan, server-side with tesseract.js (no Python needed).
 *
 * The scan is fetched through the same proxy the browser uses (/api/scan),
 * so anything the UI can display can be transcribed. Set PADDLE_URL
 * (e.g. http://127.0.0.1:3002/ocr) to route through a local PaddleOCR
 * server instead - better on CJK/Arabic, see paddle_server.py.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const { DATA_DIR } = require('../db');
const { fetchScan } = require('./scan');

const TESSDATA = path.join(DATA_DIR, 'tessdata'); // language packs are downloaded here once
fs.mkdirSync(TESSDATA, { recursive: true });

// UI language code -> tesseract traineddata code. Inducks language codes (fr, en, de...) map directly.
const LANGS = [
  { code: 'en', tess: 'eng', name: 'English' },
  { code: 'fr', tess: 'fra', name: 'French' },
  { code: 'de', tess: 'deu', name: 'German' },
  { code: 'it', tess: 'ita', name: 'Italian' },
  { code: 'es', tess: 'spa', name: 'Spanish' },
  { code: 'pt', tess: 'por', name: 'Portuguese' },
  { code: 'nl', tess: 'nld', name: 'Dutch' },
  { code: 'da', tess: 'dan', name: 'Danish' },
  { code: 'sv', tess: 'swe', name: 'Swedish' },
  { code: 'no', tess: 'nor', name: 'Norwegian' },
  { code: 'fi', tess: 'fin', name: 'Finnish' },
  { code: 'pl', tess: 'pol', name: 'Polish' },
  { code: 'cs', tess: 'ces', name: 'Czech' },
  { code: 'hu', tess: 'hun', name: 'Hungarian' },
  { code: 'ro', tess: 'ron', name: 'Romanian' },
  { code: 'tr', tess: 'tur', name: 'Turkish' },
  { code: 'el', tess: 'ell', name: 'Greek' },
  { code: 'ru', tess: 'rus', name: 'Russian' },
  { code: 'ar', tess: 'ara', name: 'Arabic', dir: 'rtl' },
  { code: 'ja', tess: 'jpn', name: 'Japanese' },
  { code: 'zh', tess: 'chi_sim', name: 'Chinese (simplified)' },
  { code: 'ko', tess: 'kor', name: 'Korean' },
  { code: 'vi', tess: 'vie', name: 'Vietnamese' },
  { code: 'id', tess: 'ind', name: 'Indonesian' },
];
const tessOf = (code) => (LANGS.find((l) => l.code === code || l.tess === code) || LANGS[0]).tess;

// One worker per language, created lazily and kept warm.
const workers = new Map();
async function getWorker(tess) {
  if (!workers.has(tess)) {
    workers.set(tess, createWorker(tess, 1, { cachePath: TESSDATA, logger: () => {} }));
  }
  return workers.get(tess);
}

/**
 * POST /api/ocr
 * Body: { url: string, lang?: string }
 * Response: { text, confidence, words: [{ text, confidence, bbox }] }
 */
router.post('/', async (req, res) => {
  const { url, lang } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const started = Date.now();
  try {
    const { buffer } = await fetchScan(url);

    if (process.env.PADDLE_URL) {
      const tempPath = path.join(DATA_DIR, 'temp_ocr.jpg');
      fs.writeFileSync(tempPath, buffer);
      const r = await fetch(process.env.PADDLE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_path: tempPath, lang: lang || 'en' }) });
      if (!r.ok) throw new Error(`PaddleOCR ${r.status}`);
      return res.json({ ...(await r.json()), engine: 'paddle', ms: Date.now() - started });
    }

    const worker = await getWorker(tessOf(lang || 'en'));
    const { data } = await worker.recognize(buffer);
    const words = (data.words || []).map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }));
    console.log(`[OCR] ${tessOf(lang || 'en')} conf=${data.confidence?.toFixed?.(1)} ${Date.now() - started}ms "${(data.text || '').slice(0, 60).replace(/\n/g, ' ')}"`);
    res.json({ text: data.text, confidence: data.confidence, scale: 1, words, engine: 'tesseract', ms: Date.now() - started });
  } catch (err) {
    console.error('[OCR] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/ocr/languages */
router.get('/languages', (req, res) => {
  res.json(LANGS.map(({ code, name, dir }) => ({ code, name, ...(dir ? { dir } : {}) })));
});

module.exports = router;
