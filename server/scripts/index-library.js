#!/usr/bin/env node
/**
 * server/scripts/index-library.js
 * Walks the personal scan library, matches each archive to its Inducks issue and
 * registers its pages as pending OCR work.
 *
 * Safe to re-run: pages already registered are left alone, so this doubles as the
 * "what is still missing" report.
 *
 * Usage:
 *   node scripts/index-library.js                      # every country
 *   node scripts/index-library.js --country France
 *   node scripts/index-library.js --limit 5 --list-only
 *   node scripts/index-library.js --report
 */
const path = require('path');
const {
  LIBRARY_ROOT, listArchives, parseArchiveName, makeMatcher, listPagesRetrying,
} = require('../library');
const { getCoaDb } = require('../db');
const { getSearchDb, registerIssuePages, progress } = require('../searchdb');

function parseArgs(argv) {
  const out = { country: null, series: null, limit: null, listOnly: false, report: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--country') out.country = argv[++i];
    else if (a === '--series') out.series = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--list-only') out.listOnly = true;
    else if (a === '--report') out.report = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const db = getSearchDb();

  if (args.report) {
    const p = await progress(db);
    console.log('\nOCR pass status');
    console.log(`  issues      ${p.issues}`);
    console.log(`  pages       ${p.total}`);
    console.log(`  done        ${p.done || 0}`);
    console.log(`  pending     ${p.pending || 0}`);
    console.log(`  failed      ${p.failed || 0}`);
    console.log(`  in index    ${p.indexed}`);
    console.log(`  reviewed    ${p.reviewed || 0}`);
    return;
  }

  console.log(`Scan library: ${LIBRARY_ROOT}`);
  let archives = listArchives();
  if (args.country) {
    archives = archives.filter((a) => a.country.toLowerCase() === args.country.toLowerCase());
    console.log(`  filtered to ${args.country}: ${archives.length} archives`);
  }
  if (args.series) {
    const sLow = args.series.toLowerCase();
    archives = archives.filter((a) => a.series.toLowerCase().includes(sLow) || a.name.toLowerCase().includes(sLow));
    console.log(`  filtered to series "${args.series}": ${archives.length} archives`);
  }
  if (args.limit) archives = archives.slice(0, args.limit);

  const coa = getCoaDb();
  const match = makeMatcher(coa);
  // Language drives which PaddleOCR recogniser the worker loads, so it is read
  // from Inducks (the archive name does not carry it). inducks_issue has no
  // languagecode of its own: the language lives on the publication.
  const issueLang = coa.prepare(
    `SELECT p.languagecode, p.title
     FROM inducks_issue i
     JOIN inducks_publication p ON p.publicationcode = i.publicationcode
     WHERE REPLACE(REPLACE(LOWER(i.issuecode), '/', ''), ' ', '') = ?
     LIMIT 1`
  );
  const langOf = (issuecode) => {
    const r = issueLang.get(issuecode.replace('/', '').replace(/ /g, '').toLowerCase());
    return (r && r.languagecode) || null;
  };

  const knownArchives = new Set(
    db.prepare('SELECT DISTINCT archive FROM page').pluck().all()
  );
  console.log(`  already registered: ${knownArchives.size} archives (will be skipped in 0 ms)`);

  const stats = { matched: 0, unmatched: 0, badName: 0, pages: 0, registered: 0, failed: 0, cached: 0 };
  const unmatched = [];
  const unreadable = [];

  for (const [i, a] of archives.entries()) {
    const parsed = parseArchiveName(a.name);
    if (!parsed) { stats.badName++; continue; }
    const issuecode = match(parsed);
    if (!issuecode) {
      stats.unmatched++;
      unmatched.push(`${a.country}/${a.series}/${a.name}`);
      continue;
    }
    stats.matched++;

    // Instant skip for already indexed archives
    if (knownArchives.has(a.file)) {
      stats.cached++;
      if (!args.listOnly && (i % 50 === 0 || i === archives.length - 1)) {
        process.stdout.write(`\r  ${i + 1}/${archives.length} archives · ${stats.cached} cached · ${stats.registered} new   `);
      }
      continue;
    }

    let pages;
    try {
      pages = listPagesRetrying(a.file);
    } catch (e) {
      console.warn(`  ! cannot read ${a.name}: ${e.message}`);
      stats.failed++;
      unreadable.push(`${a.country}/${a.series}/${a.name}`);
      continue;
    }
    stats.pages += pages.length;

    const added = registerIssuePages(db, issuecode, a.file, pages, {
      country: a.country,
      languagecode: langOf(issuecode),
    });
    stats.registered += added;

    if (!args.listOnly && (i % 10 === 0 || i === archives.length - 1)) {
      process.stdout.write(`\r  ${i + 1}/${archives.length} archives · ${stats.pages} pages · ${stats.registered} new   `);
    }
  }

  if (!args.listOnly) process.stdout.write('\n');
  console.log('\nIndexing result');
  console.log(`  archives read     ${archives.length}`);
  console.log(`  already in cache  ${stats.cached}`);
  console.log(`  matched Inducks   ${stats.matched}`);
  console.log(`  unmatched         ${stats.unmatched}`);
  console.log(`  name not parsable ${stats.badName}`);
  console.log(`  unreadable        ${stats.failed}`);
  console.log(`  pages found       ${stats.pages}`);
  console.log(`  pages registered  ${stats.registered}`);
  if (unmatched.length) {
    console.log('\n  publication codes Inducks does not know:');
    for (const u of unmatched.slice(0, 20)) console.log(`    ${u}`);
    if (unmatched.length > 20) console.log(`    … and ${unmatched.length - 20} more`);
  }
  if (unreadable.length) {
    console.log('\n  archives with no readable page (corrupt, encrypted or not an archive):');
    for (const u of unreadable.slice(0, 20)) console.log(`    ${u}`);
    if (unreadable.length > 20) console.log(`    … and ${unreadable.length - 20} more`);
  }

  const p = await progress(db);
  console.log(`\nTotal pages in database: ${p.total} (pending ${p.pending || 0})`);
  console.log(`Next: py -3.12 ocr_worker.py --limit 20`);
  db.close();
  coa.close();
}

main().catch((e) => { console.error('index-library failed:', e.message); process.exit(1); });