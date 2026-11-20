/**
 * server/routes/exports.js
 * Saves each story/article as its own Markdown file on disk.
 *
 * Structure:  data/exports/{country}/{pub_slug}/{entrycode_slug}.md
 *
 * Routes:
 *   POST /api/exports/entry?code=fr%2FMM+1234A   → 1 file for 1 article
 *   POST /api/exports/issue?code=fr%2FMM+1234    → 1 file per article in the issue
 *   POST /api/exports/publication?pub=fr%2FMM    → 1 file per article in the publication
 *   GET  /api/exports                             → list exported files
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getCoaDb, getTranscriptionsDb, DATA_DIR } = require('../db');

const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

/** Sanitize a string so it's safe as a directory / filename fragment */
function slugify(str) {
  return (str || '').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan URL helpers (same logic as entries.js)
// ─────────────────────────────────────────────────────────────────────────────
function buildOutducksPath(sitecode, url) {
  if (!url) return null;
  let prefix;
  if (/^\d/.test(url))               prefix = 'webusers/webusers';
  else if (url.startsWith('webusers')) prefix = 'webusers';
  else                                prefix = (sitecode || '').replace(/thumbnails2?/, '');
  return `${prefix}/${url}`.replace(/\/+/g, '/');
}
function buildScanUrl(sitecode, url) {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const p = buildOutducksPath(sitecode, url);
  return `https://res.cloudinary.com/dl7hskxab/image/upload/v1623338718/inducks-covers/${p}`;
}

/**
 * Fetch all scan URLs for a list of entrycodes.
 * Returns { [entrycode]: string[] }
 */
function getScanUrls(db, entryCodes) {
  if (!entryCodes.length) return {};
  const escaped = entryCodes.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const rows = db.prepare(`
    SELECT eu.entrycode, eu.sitecode, eu.url, eu.pagenumber
    FROM inducks_entryurl eu
    WHERE eu.entrycode IN (${escaped})
      AND eu.public = 'Y'
    ORDER BY
      CAST(eu.pagenumber AS INTEGER),
      CASE eu.sitecode
        WHEN 'webusers'    THEN 0
        WHEN 'thumbnails2' THEN 1
        WHEN 'thumbnails'  THEN 2
        ELSE 3 END
  `).all();
  const map = {};
  const pagesSeen = new Set();
  for (const u of rows) {
    const pageKey = `${u.entrycode}#${u.pagenumber}`;
    if (pagesSeen.has(pageKey)) continue; // already have best URL for this page
    const full = buildScanUrl(u.sitecode, u.url);
    if (!full) continue;
    pagesSeen.add(pageKey);
    if (!map[u.entrycode]) map[u.entrycode] = [];
    map[u.entrycode].push(full);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a single article's Markdown content
// ─────────────────────────────────────────────────────────────────────────────
function buildEntryMarkdown({ entry, issue, pub, transcript, scanUrls }) {
  const now = new Date().toISOString();
  const lines = [];

  // ── YAML front matter ──────────────────────────────────────────────────────
  const statusVal = transcript
    ? (transcript.validated ? 'validated' : 'draft')
    : 'missing';

  lines.push('---');
  lines.push(`entrycode: "${entry.entrycode}"`);
  lines.push(`storycode: "${entry.storyversioncode || ''}"`);
  lines.push(`publication: "${issue.publicationcode}"`);
  lines.push(`publication_title: "${(pub.title || '').replace(/"/g, '\\"')}"`);
  lines.push(`country: "${(issue.publicationcode || '').split('/')[0]}"`);
  lines.push(`issue: "${issue.issuecode}"`);
  lines.push(`language: "${issue.languagecode || pub.languagecode || ''}"`);
  lines.push(`position: "${entry.position || ''}"`);
  lines.push(`hero: "${entry.printedhero || ''}"`);
  lines.push(`part: "${entry.part || ''}"`);
  lines.push(`title: "${transcript ? transcript.title.replace(/"/g, '\\"') : ''}"`);
  lines.push(`inducks_title: "${(entry.inducks_title || '').replace(/"/g, '\\"')}"`);
  lines.push(`status: "${statusVal}"`);
  const inducksIssueUrl = `https://inducks.org/issue.php?c=${encodeURIComponent(issue.issuecode)}`;
  const inducksStoryUrl = entry.storyversioncode
    ? `https://inducks.org/story.php?c=${encodeURIComponent(entry.storyversioncode)}`
    : '';
  lines.push(`pages: ${scanUrls ? scanUrls.length : 0}`);
  lines.push(`source_issue: "${inducksIssueUrl}"`);
  if (inducksStoryUrl) lines.push(`source_story: "${inducksStoryUrl}"`);
  lines.push(`exported_at: "${now}"`);
  lines.push('---');
  lines.push('');

  // ── Heading ────────────────────────────────────────────────────────────────
  const pubLabel  = pub.title || issue.publicationcode;
  const issueNum  = issue.issuecode.split(' ').slice(-1)[0];
  const entrySlot = entry.entrycode.replace(issue.issuecode, '').replace(/^\s+/, '');

  lines.push(`# ${pubLabel} — N°${issueNum} — Article ${entrySlot || entry.position || entry.entrycode}`);
  lines.push('');

  // ── Metadata ───────────────────────────────────────────────────────────────
  lines.push('## Métadonnées');
  lines.push('');
  lines.push(`| Champ | Valeur |`);
  lines.push(`|---|---|`);
  lines.push(`| Publication | \`${issue.publicationcode}\` — ${pub.title || ''} |`);
  lines.push(`| Numéro | \`${issue.issuecode}\` |`);
  lines.push(`| Article | \`${entry.entrycode}\` |`);
  if (entry.storyversioncode)    lines.push(`| Storycode | \`${entry.storyversioncode}\` |`);
  if (entry.printedhero)  lines.push(`| Personnage | ${entry.printedhero} |`);
  if (entry.position)     lines.push(`| Position | ${entry.position} |`);
  if (entry.part)         lines.push(`| Partie | ${entry.part} |`);
  const langCode = issue.languagecode || pub.languagecode || '';
  if (langCode)           lines.push(`| Langue | \`${langCode}\` |`);
  lines.push('');

  // ── Transcription ──────────────────────────────────────────────────────────
  lines.push('## Transcription');
  lines.push('');

  if (transcript) {
    const badge = transcript.validated ? '✅ **Validé**' : '⏳ **Brouillon**';
    lines.push(`**Statut :** ${badge}`);
    lines.push('');
    lines.push(`**Titre transcrit :**`);
    lines.push('');
    lines.push(`> ${transcript.title}`);
    lines.push('');

    if (transcript.ocr_raw && transcript.ocr_raw.trim() !== transcript.title.trim()) {
      lines.push('<details>');
      lines.push('<summary>OCR brut</summary>');
      lines.push('');
      lines.push('```');
      lines.push(transcript.ocr_raw.trim());
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  } else if (entry.inducks_title) {
    lines.push(`**Statut :** ℹ️ Titre présent dans Inducks (non retranscrit depuis le scan)`);
    lines.push('');
    lines.push(`**Titre Inducks :**`);
    lines.push('');
    lines.push(`> ${entry.inducks_title}`);
    lines.push('');
  } else {
    lines.push(`**Statut :** ❌ Titre manquant — à transcrire`);
    lines.push('');
  }

  // ── Sources ────────────────────────────────────────────────────────────────
  lines.push('## Sources Inducks');
  lines.push('');
  lines.push(`- [Page du numéro sur Inducks](${inducksIssueUrl})`);
  if (inducksStoryUrl) lines.push(`- [Page de l'histoire sur Inducks](${inducksStoryUrl})`);
  lines.push('');

  // ── Scans ──────────────────────────────────────────────────────────────────
  lines.push('## Scans');
  lines.push('');
  if (scanUrls && scanUrls.length > 0) {
    scanUrls.forEach((url, i) => {
      lines.push(`- [Scan page ${i + 1}](${url})`);
    });
  } else {
    lines.push('*Aucun scan disponible dans Inducks pour cet article.*');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Determine the output file path for a given entrycode + publicationcode.
 * data/exports/{country}/{pub_slug}/{entrycode_slug}.md
 */
function entryFilePath(publicationcode, entrycode) {
  const [country, pubPart] = (publicationcode || '').split('/');
  const dir = path.join(EXPORTS_DIR, slugify(country), slugify(pubPart || publicationcode));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, slugify(entrycode) + '.md');
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/exports  — list all exported Markdown files
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const files = [];
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (name.endsWith('.md')) {
          files.push({
            filename: name,
            relative: path.relative(EXPORTS_DIR, full).replace(/\\/g, '/'),
            size: stat.size,
            updated_at: stat.mtimeMs,
          });
        }
      }
    }
    walk(EXPORTS_DIR);
    files.sort((a, b) => b.updated_at - a.updated_at);
    res.json({ exports_dir: EXPORTS_DIR, count: files.length, files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/exports/entry?code=fr%2FMM+1234A
// Save 1 Markdown file for a single article
// ─────────────────────────────────────────────────────────────────────────────
router.post('/entry', (req, res) => {
  try {
    const db  = getCoaDb();
    const tdb = getTranscriptionsDb();
    const entrycode = req.query.code;
    if (!entrycode) return res.status(400).json({ error: 'Missing code query param' });

    const entry = db.prepare(`
      SELECT e.entrycode, e.issuecode, e.storyversioncode, e.title AS inducks_title,
             e.position, e.part, e.printedhero
      FROM inducks_entry e WHERE e.entrycode = ?
    `).get(entrycode);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const issue = db.prepare(`
      SELECT i.*, p.title AS pub_title, p.languagecode AS pub_languagecode
      FROM inducks_issue i
      JOIN inducks_publication p ON p.publicationcode = i.publicationcode
      WHERE i.issuecode = ?
    `).get(entry.issuecode);

    const pub = db.prepare('SELECT * FROM inducks_publication WHERE publicationcode = ?')
      .get(issue.publicationcode);

    const transcript = tdb.prepare('SELECT * FROM transcriptions WHERE entrycode = ?').get(entrycode);
    const scanUrlMap = getScanUrls(db, [entrycode]);

    const md = buildEntryMarkdown({ entry, issue, pub, transcript, scanUrls: scanUrlMap[entrycode] || [] });
    const filepath = entryFilePath(issue.publicationcode, entrycode);
    fs.writeFileSync(filepath, md, 'utf8');

    res.json({
      ok: true,
      relative: path.relative(EXPORTS_DIR, filepath).replace(/\\/g, '/'),
      path: filepath,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/exports/issue?code=fr%2FMM+1234
// Save 1 Markdown file per article for a whole issue
// ─────────────────────────────────────────────────────────────────────────────
router.post('/issue', (req, res) => {
  try {
    const db  = getCoaDb();
    const tdb = getTranscriptionsDb();
    const issuecode = req.query.code;
    if (!issuecode) return res.status(400).json({ error: 'Missing code query param' });

    const issue = db.prepare(`
      SELECT i.*, p.title AS pub_title, p.languagecode AS pub_languagecode
      FROM inducks_issue i
      JOIN inducks_publication p ON p.publicationcode = i.publicationcode
      WHERE i.issuecode = ?
    `).get(issuecode);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const pub = db.prepare('SELECT * FROM inducks_publication WHERE publicationcode = ?')
      .get(issue.publicationcode);

    const entries = db.prepare(`
      SELECT e.entrycode, e.storyversioncode, e.title AS inducks_title, e.position, e.part, e.printedhero
      FROM inducks_entry e WHERE e.issuecode = ?
      ORDER BY CAST(e.position AS INTEGER), e.entrycode
    `).all(issuecode);

    const transcriptMap = {};
    tdb.prepare('SELECT * FROM transcriptions').all()
      .forEach(t => { transcriptMap[t.entrycode] = t; });

    const scanUrlMap = getScanUrls(db, entries.map(e => e.entrycode));

    const saved = [];
    for (const entry of entries) {
      const md = buildEntryMarkdown({
        entry, issue, pub,
        transcript: transcriptMap[entry.entrycode] || null,
        scanUrls: scanUrlMap[entry.entrycode] || [],
      });
      const filepath = entryFilePath(issue.publicationcode, entry.entrycode);
      fs.writeFileSync(filepath, md, 'utf8');
      saved.push(path.relative(EXPORTS_DIR, filepath).replace(/\\/g, '/'));
    }

    res.json({ ok: true, saved: saved.length, files: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/exports/publication?pub=fr%2FMM
// Save 1 Markdown file per article for all issues in a publication
// ─────────────────────────────────────────────────────────────────────────────
router.post('/publication', (req, res) => {
  try {
    const db  = getCoaDb();
    const tdb = getTranscriptionsDb();
    const pubcode = req.query.pub;
    if (!pubcode) return res.status(400).json({ error: 'Missing pub query param' });

    const pub = db.prepare('SELECT * FROM inducks_publication WHERE publicationcode = ?').get(pubcode);
    if (!pub) return res.status(404).json({ error: 'Publication not found' });

    const issues = db.prepare(`
      SELECT i.*, p.languagecode AS pub_languagecode
      FROM inducks_issue i
      JOIN inducks_publication p ON p.publicationcode = i.publicationcode
      WHERE i.publicationcode = ? ORDER BY i.issuecode
    `).all(pubcode);

    const transcriptMap = {};
    tdb.prepare('SELECT * FROM transcriptions').all()
      .forEach(t => { transcriptMap[t.entrycode] = t; });

    let totalSaved = 0;
    for (const issue of issues) {
      const entries = db.prepare(`
        SELECT e.entrycode, e.storyversioncode, e.title AS inducks_title, e.position, e.part, e.printedhero
        FROM inducks_entry e WHERE e.issuecode = ?
        ORDER BY CAST(e.position AS INTEGER), e.entrycode
      `).all(issue.issuecode);
      if (!entries.length) continue;

      const scanUrlMap = getScanUrls(db, entries.map(e => e.entrycode));

      for (const entry of entries) {
        const md = buildEntryMarkdown({
          entry, issue, pub,
          transcript: transcriptMap[entry.entrycode] || null,
          scanUrls: scanUrlMap[entry.entrycode] || [],
        });
        const filepath = entryFilePath(issue.publicationcode, entry.entrycode);
        fs.writeFileSync(filepath, md, 'utf8');
        totalSaved++;
      }
    }

    res.json({ ok: true, saved: totalSaved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
