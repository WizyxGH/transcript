#!/usr/bin/env node
/**
 * server/scripts/unpack-inducks-db.js
 * Decompresses the Inducks database next to it on a drive that has room.
 *
 * apps/InducksButBetter/public/datas/ holds only inducks.sqlite.gz (~300 MB), which is
 * what the deploy publishes. better-sqlite3 cannot open a .gz, so the other apps need
 * it uncompressed — 1.2 GB. Putting that in the repo filled C: (which has a few GB
 * free), so it lives on D: instead and db.js looks there first.
 *
 * Usage:
 *   node scripts/unpack-inducks-db.js                  # → DATABASE_DIR (config.js)
 *   node scripts/unpack-inducks-db.js --dir E:\somewhere
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DATABASE_DIR } = require('../config');

const IBB_DATAS = path.resolve(__dirname, '../../../InducksButBetter/public/datas');
const GZ = path.join(IBB_DATAS, 'inducks.sqlite.gz');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
  }
  return out;
}

function human(bytes) {
  return `${(bytes / 2 ** 30).toFixed(2)} GB`;
}

function main() {
  const args = parseArgs(process.argv);
  // Same directory db.js reads from — resolved in one place, config.js.
  const destDir = args.dir || DATABASE_DIR;
  const dest = path.join(destDir, 'inducks.sqlite');

  if (!fs.existsSync(GZ)) {
    console.error(`compressed database not found: ${GZ}\n` +
      `Build it with: pnpm --filter @disney/inducks-but-better db:build`);
    process.exit(1);
  }
  if (fs.existsSync(dest)) {
    const same = fs.statSync(dest).size > 0;
    console.log(`already unpacked: ${dest} (${human(fs.statSync(dest).size)})${same ? '' : '  — EMPTY, remove it and re-run'}`);
    if (same) return;
  }

  const free = freeSpace(destDir);
  const needed = 1.3 * 2 ** 30;               // the uncompressed size, with headroom
  if (free !== null && free < needed) {
    console.error(`not enough room on ${destDir}: ${human(free)} free, ${human(needed)} needed`);
    process.exit(1);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const tmp = dest + '.partial';
  console.log(`unpacking ${path.basename(GZ)} → ${dest}`);
  console.log(`  ${human(fs.statSync(GZ).size)} compressed, target drive has ${free === null ? 'unknown' : human(free)} free`);

  const t0 = Date.now();
  const src = fs.createReadStream(GZ).pipe(zlib.createGunzip());
  const out = fs.createWriteStream(tmp);
  src.pipe(out);
  out.on('finish', () => {
    // Rename only once the bytes are all there: a truncated file named .sqlite
    // would be picked up by db.js and fail much later, with a confusing error.
    fs.renameSync(tmp, dest);
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`done in ${secs}s — ${human(fs.statSync(dest).size)} at ${dest}`);
    console.log(`\nThe transcript server finds it automatically (DATABASE_DIR in config.js).`);
  });
  out.on('error', (e) => {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    console.error('unpack failed:', e.message);
    process.exit(1);
  });
}

/** Free bytes on the drive holding `p`, or null when it cannot be determined. */
function freeSpace(p) {
  let probe = p;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  try {
    // `fs.statfs` exists on Node 18.15+ / Windows and takes a path directly.
    const s = fs.statfsSync(probe);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

main();