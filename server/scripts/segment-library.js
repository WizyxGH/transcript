#!/usr/bin/env node
/**
 * server/scripts/segment-library.js
 * Writes the Inducks entrycode of each scanned page, by reconstructing the
 * page ranges from inducks_entry.position (see segmentation.js for why).
 *
 * Safe to re-run: it only fills `page.entrycode`, never touches the OCR text.
 *
 * Usage:
 *   node scripts/segment-library.js                 # all indexed issues
 *   node scripts/segment-library.js --issue "fr/JMC   5"
 *   node scripts/segment-library.js --report         # what is / is not segmentable
 */
const { getCoaDb } = require('../db');
const { getSearchDb } = require('../searchdb');
const { segmentIssue, lookupByPage } = require('../segmentation');

function parseArgs(argv) {
  const out = { issue: null, report: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--issue') out.issue = argv[++i];
    else if (argv[i] === '--report') out.report = true;
  }
  return out;
}

let _exactStmt = null;
let _replaceStmt = null;

/** Entries of one issue, ordered so segmentation sees them in reading order. */
function entriesOfIssue(coa, issuecode) {
  if (!_exactStmt) {
    _exactStmt = coa.prepare(`
      SELECT e.entrycode, e.position, COALESCE(e.title, '') AS title, sv.storycode, sv.entirepages, sv.kind
      FROM inducks_entry e
      LEFT JOIN inducks_storyversion sv ON sv.storyversioncode = e.storyversioncode
      WHERE e.issuecode = ?
      ORDER BY e.position
    `);
    _replaceStmt = coa.prepare(`
      SELECT e.entrycode, e.position, COALESCE(e.title, '') AS title, sv.storycode, sv.entirepages, sv.kind
      FROM inducks_entry e
      LEFT JOIN inducks_storyversion sv ON sv.storyversioncode = e.storyversioncode
      WHERE REPLACE(e.issuecode, ' ', '') = ?
      ORDER BY e.position
    `);
  }
  // Try indexed exact match first (3 ms vs 470 ms full table scan)
  const exact = _exactStmt.all(issuecode);
  if (exact.length) return exact;
  return _replaceStmt.all(issuecode.replace(/ /g, ''));
}

/** Issues present in the search database, with their page counts. */
function indexedIssues(db) {
  return db.prepare(`
    SELECT issuecode, COUNT(*) AS pages FROM page GROUP BY issuecode ORDER BY issuecode
  `).all();
}

async function main() {
  const args = parseArgs(process.argv);
  const db = getSearchDb();
  const coa = getCoaDb();

  let issues = indexedIssues(db);
  if (args.issue) {
    const flat = args.issue.replace(/ /g, '');
    issues = issues.filter((i) => i.issuecode.replace(/ /g, '') === flat);
  }
  if (!issues.length) {
    console.log('no indexed issues for that selection (run index-library.js first)');
    return;
  }

  const update = db.prepare('UPDATE page SET entrycode = ?, title = ?, storycode = ?, kind = ? WHERE issuecode = ? AND pageno = ?');
  const report = { segmentable: 0, skipped: 0, pagesSet: 0, reasons: {} };

  for (const issue of issues) {
    const entries = entriesOfIssue(coa, issue.issuecode);
    if (!entries.length) { report.skipped++; continue; }

    const { segments, shape, reason } = segmentIssue(entries, issue.pages);

    if (!segments.length) {
      report.skipped++;
      report.reasons[reason || shape] = (report.reasons[reason || shape] || 0) + 1;
      continue;
    }
    report.segmentable++;
    if (reason) report.reasons[reason] = (report.reasons[reason] || 0) + 1;

    if (args.report) {
      console.log(`\n${issue.issuecode} — ${issue.pages} pages, ${entries.length} entries`);
      for (const s of segments.slice(0, 6)) {
        console.log(`   p${String(s.from).padStart(3)}-${String(s.to).padEnd(3)} ${s.entrycode}  ${s.title || ''}`);
      }
      if (segments.length > 6) console.log(`   … and ${segments.length - 6} more`);
      continue;
    }

    // One UPDATE per page: the title is denormalised onto the row here, so that a
    // search never has to read the 1.2 GB Inducks database (~21 ms per lookup).
    const tx = db.transaction(() => {
      let n = 0;
      for (const s of segments) {
        for (let p = s.from; p <= s.to; p++) {
          n += update.run(s.entrycode, s.title, s.storycode || null, s.kind || 'n', issue.issuecode, p).changes;
        }
      }
      return n;
    });
    report.pagesSet += tx();
  }

  if (args.report) {
    console.log('\n── report ──');
    console.log(`  segmentable issues : ${report.segmentable}`);
    console.log(`  skipped            : ${report.skipped}`);
    for (const [r, n] of Object.entries(report.reasons)) console.log(`    ${n}× ${r}`);
    const still = db.prepare('SELECT COUNT(*) AS n FROM page WHERE entrycode IS NULL').get().n;
    console.log(`  pages without an entry : ${still}`);
    return;
  }

  const set = db.prepare('SELECT COUNT(*) AS n FROM page WHERE entrycode IS NOT NULL').get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM page').get().n;
  console.log(`segmented ${report.pagesSet} page assignments`);
  console.log(`  issues segmentable : ${report.segmentable}`);
  console.log(`  issues skipped     : ${report.skipped}`);
  for (const [r, n] of Object.entries(report.reasons)) console.log(`    ${n}× ${r}`);
  console.log(`  pages with an entry : ${set}/${total}`);
  db.close();
  coa.close();
}

main().catch((e) => { console.error('segment-library failed:', e.message); process.exit(1); });