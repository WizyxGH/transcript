/**
 * scripts/ingest-cloud-transcripts.js
 * Ingests JSON transcripts produced by the Cloud OCR pipeline (GitHub Actions)
 * into search.sqlite so they become searchable immediately.
 */
const fs = require('fs');
const path = require('path');
const { getSearchDb } = require('../searchdb');

const TRANSCRIPTS_DIR = path.resolve(__dirname, '../../../../../../Automatisations/Archiving-Helper/collection/transcripts');
const CONFIDENCE_FLOOR = 0.80;

function ingestAll() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    console.log(`[!] Transcripts directory not found: ${TRANSCRIPTS_DIR}`);
    return;
  }

  const db = getSearchDb();
  const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[+] Found ${files.length} transcript file(s) from Cloud OCR.`);

  const updatePage = db.prepare(`
    UPDATE page 
    SET text = ?, confidence = ?, n_boxes = ?, ocr_engine = 'paddle-cloud', ocr_ms = ?, state = 'done', updated_at = unixepoch()
    WHERE pagename = ? OR (archive LIKE ? AND pagename LIKE ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO page_fts(rowid, text) VALUES (?, ?)
  `);

  const getPageId = db.prepare(`
    SELECT id, reviewed FROM page 
    WHERE pagename = ? OR (archive LIKE ? AND pagename LIKE ?)
    LIMIT 1
  `);

  let totalUpdated = 0;

  for (const file of files) {
    const fullPath = path.join(TRANSCRIPTS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const comicName = data.comic_name;
      const pages = data.pages || [];
      console.log(`[*] Ingesting ${comicName} (${pages.length} pages)...`);

      let comicUpdated = 0;
      for (const p of pages) {
        if (!p.text || !p.text.trim()) continue;
        const pageFilename = p.filename;
        const targetRow = getPageId.get(pageFilename, `%${comicName}%`, `%${pageFilename}%`);

        if (targetRow) {
          updatePage.run(p.text, p.confidence || 0.9, p.n_boxes || 0, p.ocr_ms || 1000, pageFilename, `%${comicName}%`, `%${pageFilename}%`);
          if (!targetRow.reviewed && (p.confidence || 0) >= CONFIDENCE_FLOOR) {
            try {
              insertFts.run(targetRow.id, p.text);
            } catch (_) {}
          }
          comicUpdated++;
        }
      }
      console.log(`    ✓ ${comicUpdated} page(s) updated for ${comicName}`);
      totalUpdated += comicUpdated;
    } catch (e) {
      console.error(`    ! Error parsing ${file}:`, e.message);
    }
  }

  console.log(`\n[✓] Done. Total ${totalUpdated} page(s) ingested into search.sqlite.`);
}

ingestAll();
