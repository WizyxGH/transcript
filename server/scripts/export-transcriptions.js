#!/usr/bin/env node
/**
 * server/scripts/export-transcriptions.js
 * Exports the OCR'd page text as JSON for InducksButBetter.
 *
 * IBB reads JSON side-data (public/datas/*.json) and mounts it as a SQL table in
 * the browser database — see apps/InducksButBetter/src/lib/quotationsTable.ts.
 * This produces the same shape for transcriptions, so IBB can do exactly the same
 * thing with it: no server, no copy of the scan library, and nothing added to the
 * public deployment unless the file is deliberately copied there.
 *
 * Only pages that made it into the index are exported (confident enough): shipping
 * low-confidence text would put words in IBB's results that the scan does not
 * contain. The OCR text is the expensive artefact; the title and the entrycode
 * come from Inducks.
 *
 * Usage:
 *   node scripts/export-transcriptions.js                     # default output
 *   node scripts/export-transcriptions.js --out path.json
 *   node scripts/export-transcriptions.js --country France
 *   node scripts/export-transcriptions.js --include-unindexed  # everything OCR'd
 *   node scripts/export-transcriptions.js --stats             # size estimate, no write
 */
const fs = require('fs');
const path = require('path');
const { getSearchDb, CONFIDENCE_FLOOR } = require('../searchdb');

const DEFAULT_OUT = path.join(
  __dirname, '../../../InducksButBetter/public/datas/transcriptions.json'
);

function parseArgs(argv) {
  const out = { file: DEFAULT_OUT, country: null, includeUnindexed: false, stats: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.file = argv[++i];
    else if (a === '--country') out.country = argv[++i];
    else if (a === '--include-unindexed') out.includeUnindexed = true;
    else if (a === '--stats') out.stats = true;
  }
  return out;
}

/**
 * One record per entry, with its pages' text joined.
 *
 * Keyed by entrycode because that is what a search result is about: IBB joins on
 * the entrycode it already knows, and a page number means little without the entry.
 * Pages with no entrycode (issues Inducks does not segment) are kept under their
 * issuecode so their text is still searchable — reported separately in the output
 * so the difference is visible rather than silent.
 */
function buildExport(db, { country, includeUnindexed }) {
  const where = ["state = 'done'", "text IS NOT NULL", "TRIM(text) <> ''"];
  const params = [];
  if (!includeUnindexed) {
    where.push('confidence >= ?');
    params.push(CONFIDENCE_FLOOR);
  }
  if (country) {
    where.push('country = ?');
    params.push(country);
  }

  const rows = db.prepare(`
    SELECT issuecode, entrycode, country, languagecode, pageno, title, text, confidence, reviewed
    FROM page
    WHERE ${where.join(' AND ')}
    ORDER BY issuecode, pageno
  `).all(...params);

  const byEntry = new Map();
  let unsegmented = 0;
  let chars = 0;

  for (const r of rows) {
    const key = r.entrycode || `issue:${r.issuecode}`;
    if (!r.entrycode) unsegmented++;
    let e = byEntry.get(key);
    if (!e) {
      e = {
        entrycode: r.entrycode || null,
        issuecode: r.issuecode,
        country: r.country,
        languagecode: r.languagecode,
        title: r.title || null,
        // Pages joined by a form-feed: a keyword search never spans the boundary,
        // and it keeps the text readable when IBB shows it.
        text: [],
        pages: [],
        reviewed: false,
        minConfidence: 1,
      };
      byEntry.set(key, e);
    }
    e.text.push(r.text);
    e.pages.push(r.pageno);
    chars += r.text.length;
    if (r.reviewed) e.reviewed = true;
    if (r.confidence < e.minConfidence) e.minConfidence = r.confidence;
  }

  const entries = [...byEntry.values()].map((e) => ({
    entrycode: e.entrycode,
    issuecode: e.issuecode,
    country: e.country,
    languagecode: e.languagecode,
    title: e.title,
    pages: e.pages,
    reviewed: e.reviewed,
    confidence: Number(e.minConfidence.toFixed(3)),
    text: e.text.join('\n\f\n'),
  }));

  return { entries, pageCount: rows.length, unsegmented, chars };
}

function main() {
  const args = parseArgs(process.argv);
  const db = getSearchDb();

  const t0 = Date.now();
  const { entries, pageCount, unsegmented, chars } = buildExport(db, args);
  const payload = {
    // Version marker: IBB rebuilds its table only when this changes, the same way
    // quotationsTable.ts versions on `${text.length}:${hash(text)}`.
    generated_at: new Date().toISOString(),
    confidence_floor: args.includeUnindexed ? 0 : CONFIDENCE_FLOOR,
    source: 'apps/transcript — OCR of the personal scan library',
    page_count: pageCount,
    entry_count: entries.length,
    entries,
  };
  const json = JSON.stringify(payload);

  const mb = (Buffer.byteLength(json) / 1048576).toFixed(1);
  const full = entries.reduce((n, e) => n + e.text.length, 0);

  console.log(`entries        ${entries.length}`);
  console.log(`pages          ${pageCount}${unsegmented ? ` (${unsegmented} without an entrycode)` : ''}`);
  console.log(`text           ${(full / 1048576).toFixed(1)} MB raw`);
  console.log(`json           ${mb} MB`);
  console.log(`built in       ${Date.now() - t0} ms`);

  if (args.stats) {
    console.log(`\n(no file written — would go to ${args.file})`);
    return;
  }

  fs.mkdirSync(path.dirname(args.file), { recursive: true });
  fs.writeFileSync(args.file, json);
  console.log(`\nwritten: ${args.file}`);
}

main();