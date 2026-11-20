#!/usr/bin/env node
/**
 * server/scripts/setup-db.js
 * Imports the Inducks ISV files (shared dump in apps/InducksButBetter/inducks_extracted, or ISV_DIR) into SQLite.
 * 
 * ISV format (actual):
 *   - First line: field names separated by ^
 *   - Subsequent lines: data rows separated by ^
 *   - Each line ends with a trailing ^
 *   - Fields may contain empty values (consecutive ^^)
 *   - Filename = table name (e.g. inducks_publication.isv → table inducks_publication)
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');
const { DATA_DIR, DB_PATH } = require('../db');

const BASE_URL = 'https://inducks.org/inducks/isv/';

const ISV_FILES = [
  'inducks_publication.isv',
  'inducks_language.isv',
  'inducks_issue.isv',
  'inducks_entry.isv',
  'inducks_entryurl.isv',
  'inducks_storyversion.isv',
];

// The ISV dump is kept once in the monorepo (apps/InducksButBetter/inducks_extracted, source of
// IBB's `pnpm db:build`): read it from there. `ISV_DIR` overrides; downloading from inducks.org
// is the last resort only (the site sits behind Anubis, which refuses non-browser requests).
const SHARED_ISV_DIR = path.resolve(__dirname, '../../../InducksButBetter/inducks_extracted');
const ISV_DIR = process.env.ISV_DIR || (fs.existsSync(SHARED_ISV_DIR) ? SHARED_ISV_DIR : path.join(DATA_DIR, 'isv'));
if (!fs.existsSync(ISV_DIR)) fs.mkdirSync(ISV_DIR, { recursive: true });

// ─────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;
    console.log(`  ⬇  ${url}`);
    mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) process.stdout.write(`\r  ${((downloaded/total)*100).toFixed(1)}% (${(downloaded/1024/1024).toFixed(1)} MB)`);
      });
      res.pipe(file);
      file.on('finish', () => { process.stdout.write('\n'); file.close(resolve); });
      file.on('error', reject);
    }).on('error', (e) => { file.close(); reject(e); });
  });
}

// ─────────────────────────────────────────────
// ISV parser → SQLite
// Format: ^ separated, first line = headers, trailing ^ at end of line
// ─────────────────────────────────────────────
async function importIsv(isvPath, db) {
  const tableName = path.basename(isvPath, '.isv');
  
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(isvPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let fields = null;
    let stmt = null;
    let rowCount = 0;
    let firstLine = true;

    const BATCH = 2000;
    let batch = [];

    const flush = db.transaction((rows, s) => { for (const r of rows) s.run(r); });

    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return;

      if (firstLine) {
        firstLine = false;
        // Header: field names separated by ^, trailing ^ at end
        fields = line.split('^').map(f => f.trim()).filter(Boolean);
        
        // Create table
        const cols = fields.map(f => `"${f}" TEXT`).join(', ');
        db.exec(`DROP TABLE IF EXISTS "${tableName}"; CREATE TABLE "${tableName}" (${cols});`);
        stmt = db.prepare(`INSERT OR IGNORE INTO "${tableName}" VALUES (${fields.map(() => '?').join(', ')})`);
        process.stdout.write(`  → ${tableName} (${fields.length} fields)…`);
        return;
      }

      if (!stmt || !fields) return;

      // Data row: split by ^, trailing ^ means last element is empty
      const parts = line.split('^');
      // Remove trailing empty element if line ended with ^
      if (parts[parts.length - 1] === '') parts.pop();
      
      // Pad or trim to field count
      while (parts.length < fields.length) parts.push(null);
      const row = parts.slice(0, fields.length).map(v => (v === '' || v === '\\N') ? null : v);
      
      batch.push(row);
      rowCount++;
      
      if (batch.length >= BATCH) {
        flush(batch, stmt);
        batch = [];
      }
    });

    rl.on('close', () => {
      if (batch.length > 0 && stmt) flush(batch, stmt);
      console.log(` ✓ ${rowCount.toLocaleString()} rows`);
      resolve(rowCount);
    });

    rl.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────
function createIndexes(db) {
  console.log('\n📇 Creating indexes…');
  const idx = [
    `CREATE INDEX IF NOT EXISTS idx_entry_issuecode ON inducks_entry(issuecode)`,
    `CREATE INDEX IF NOT EXISTS idx_entry_title ON inducks_entry(title)`,
    `CREATE INDEX IF NOT EXISTS idx_entryurl_entry ON inducks_entryurl(entrycode)`,
    `CREATE INDEX IF NOT EXISTS idx_issue_pub ON inducks_issue(publicationcode)`,
  ];
  for (const sql of idx) {
    try { db.exec(sql); } catch (e) { console.warn('  index warn:', e.message); }
  }
  console.log('  ✓ Done');
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('Transcription of Disney comics — Database Setup\n');

  // ISV files: shared dump first, download only when missing
  console.log(`  ISV directory: ${ISV_DIR}`);
  for (const filename of ISV_FILES) {
    const dest = path.join(ISV_DIR, filename);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log(`  ✓ ${filename} already present (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      await download(BASE_URL + filename, dest);
    }
  }

  // Import
  console.log('\n📥 Importing into SQLite…');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -64000');

  for (const filename of ISV_FILES) {
    const p = path.join(ISV_DIR, filename);
    if (!fs.existsSync(p)) { console.warn(`  ⚠ Missing: ${filename}`); continue; }
    await importIsv(p, db);
  }

  createIndexes(db);

  // Stats
  console.log('\n📊 Summary:');
  try {
    const total = db.prepare(`SELECT COUNT(*) as c FROM inducks_entry`).get();
    const missing = db.prepare(`SELECT COUNT(*) as c FROM inducks_entry WHERE (title IS NULL OR title = '')`).get();
    const withScan = db.prepare(`
      SELECT COUNT(DISTINCT e.entrycode) as c FROM inducks_entry e
      JOIN inducks_entryurl eu ON eu.entrycode = e.entrycode
      WHERE (e.title IS NULL OR e.title = '')
    `).get();
    console.log(`  • Total entries: ${total.c.toLocaleString()}`);
    console.log(`  • Without title: ${missing.c.toLocaleString()}`);
    console.log(`  • Without title + has scan: ${withScan.c.toLocaleString()}`);
  } catch (e) { console.log('  Stats error:', e.message); }

  db.close();
  console.log('\n✅ Setup complete! Run: npm run server');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
