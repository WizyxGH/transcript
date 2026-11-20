/**
 * server/library.js
 * The personal scan library: archive discovery, page extraction, Inducks matching.
 *
 * The library lives outside the repo (D:\Duckburg Archives by default, SCAN_LIBRARY
 * overrides). Archives are named <cc>_<CODE>_<num>.cbr — e.g. fr_JMC_12.cbr — which
 * is the convention InducksScanUploader already relies on, so the matching logic
 * here stays in the same spirit: whole-token lookup, never a guess.
 *
 * .cbr/.rar need WinRAR's UnRAR.exe; .cbz/.zip are read with Node's own zlib, so
 * neither case pulls in a dependency.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { getCoaDb } = require('./db');
const { SCAN_LIBRARY } = require('./config');

const LIBRARY_ROOT = SCAN_LIBRARY;
const UNRAR_CANDIDATES = [
  'C:\\Program Files\\WinRAR\\UnRAR.exe',
  'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe',
];

const RAR_EXT = new Set(['.cbr', '.rar']);
const ZIP_EXT = new Set(['.cbz', '.zip']);
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|webp)$/i;

const isRar = (file) => RAR_EXT.has(path.extname(file).toLowerCase());
const isZip = (file) => ZIP_EXT.has(path.extname(file).toLowerCase());

function findUnrar() {
  for (const p of UNRAR_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/** Walk the library, returning every archive with its country and series. */
function listArchives(root = LIBRARY_ROOT) {
  if (!fs.existsSync(root)) {
    // T: is a TelDrive mount: after a reboot the drive letter exists before the
    // sleeping host answers, and the folder only appears once it is awake.
    throw new Error(
      `Scan library not found: ${root}\n` +
      `- If it is the TelDrive drive: wake and (re)mount it from Archiving-Helper with\n` +
      `  py -3.12 tools/mount-drive/mount_drive.py remount   (the host can take ~1-2 min to wake)\n` +
      `- Otherwise set TARGET_ARCHIVE_PATH (Archiving-Helper's .env or the environment)\n` +
      `  to the folder that contains the country directories.`
    );
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!isRar(full) && !isZip(full)) continue;
      const rel = path.relative(root, full);
      out.push({
        file: full,
        name: e.name,
        ext: path.extname(e.name).toLowerCase(),
        country: rel.split(path.sep)[0],
        series: path.dirname(rel).split(path.sep).slice(1).join('/') || '',
      });
    }
  };
  walk(root);
  return out;
}

/**
 * Parse <cc>_<CODE>_<num> from an archive name.
 * Returns { cc, code, num }, or null when the name does not follow the convention.
 */
function parseArchiveName(name) {
  const m = /^([a-z]{2})_([A-Za-z0-9]+)_(\d+)\.c?b?r?z?$/i.exec(path.basename(name));
  if (!m) return null;
  return { cc: m[1].toLowerCase(), code: m[2].toUpperCase(), num: parseInt(m[3], 10) };
}

/**
 * Match an archive to an Inducks issue.
 * Inducks issue codes are "<cc>/<CODE> <num>" but the spacing is not reliable in
 * the dump, so an exact lookup is tried first and a whitespace-insensitive one
 * second. Results are cached: the library walks hundreds of issues.
 */
const matchCache = new Map();
function makeMatcher(db = getCoaDb()) {
  const exact = db.prepare('SELECT issuecode FROM inducks_issue WHERE issuecode = ?');
  const loose = db.prepare(
    `SELECT issuecode FROM inducks_issue
     WHERE REPLACE(REPLACE(LOWER(issuecode), '/', ''), ' ', '') = ?
     LIMIT 1`
  );
  return (parsed) => {
    if (!parsed) return null;
    const key = `${parsed.cc}/${parsed.code} ${parsed.num}`;
    if (matchCache.has(key)) return matchCache.get(key);
    const flat = `${parsed.cc}/${parsed.code}${parsed.num}`.replace('/', '').toLowerCase();
    const found = exact.get(key) || loose.get(flat);
    const issuecode = found ? found.issuecode : null;
    matchCache.set(key, issuecode);
    return issuecode;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zip reading — one parser, two uses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a zip's central directory into { name, method, compSize, localOffset }.
 *
 * Listing pages and reading one page's bytes walk the same two structures, so
 * they share this single implementation rather than each repeating the
 * End-Of-Central-Directory scan and the entry walk.
 */
function parseCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return [];
  return parseEntries(buf, buf.readUInt32LE(eocd + 16), buf.readUInt16LE(eocd + 10));
}

const EOCD_SIG = 0x06054b50;
const EOCD_SEARCH = 66000;   // EOCD record (22 bytes) + the longest possible zip comment

/** Offset of the End-Of-Central-Directory record in `buf`, or -1. */
function findEocd(buf) {
  const minStart = Math.max(0, buf.length - EOCD_SEARCH);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Walk `count` central-directory entries starting at `off` in `buf`. */
function parseEntries(buf, off, count) {
  const CEN_SIG = 0x02014b50;
  const entries = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      localOffset: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read `length` bytes at `position` without loading the rest of the file. */
function readRange(file, position, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, position);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A zip's entry names, read from its tail only.
 *
 * On the TelDrive mount every byte read is a download: reading the whole file just
 * to list it cost 23 s per 88 MB CBZ (≈ 9 h for 1 480 of them); the directory is a
 * few KB at the end.
 */
function listZipEntries(file) {
  const size = fs.statSync(file).size;
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const tail = readRange(file, tailStart, size - tailStart);
  const eocd = findEocd(tail);
  if (eocd < 0) return [];
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = cdOffset >= tailStart
    ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
    : readRange(file, cdOffset, cdSize);
  return parseEntries(cd, 0, count);
}

/** Header TelDrive writes in front of encrypted files; the mount serves them undecrypted. */
const TELDRIVE_ENCRYPTED_MAGIC = Buffer.from('TELDRIVE');

function isTeldriveEncrypted(file) {
  return readRange(file, 0, TELDRIVE_ENCRYPTED_MAGIC.length).equals(TELDRIVE_ENCRYPTED_MAGIC);
}

/**
 * I/O errors that come from the storage, not from the file. On the TelDrive mount a
 * hiccup surfaces as EIO; the same archive read fine on the next attempt.
 */
const TRANSIENT_IO_CODES = new Set(['EIO', 'ETIMEDOUT', 'EBUSY', 'ECONNRESET', 'EAGAIN']);

function isTransientIoError(e) {
  return Boolean(e) && TRANSIENT_IO_CODES.has(e.code);
}

/**
 * listPages, retried on storage hiccups so one bad second does not drop an archive
 * from the run. `sleepMs` and `read` are injectable for tests.
 */
function listPagesRetrying(archiveFile, { attempts = 3, delayMs = 30000, sleepMs = sleepSync, read = listPages } = {}) {
  for (let i = 1; ; i++) {
    try {
      return read(archiveFile);
    } catch (e) {
      if (!isTransientIoError(e) || i >= attempts) throw e;
      console.warn(`  ~ ${path.basename(archiveFile)}: ${e.code}, retrying in ${delayMs / 1000} s (${i}/${attempts - 1})`);
      sleepMs(delayMs);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read one entry's bytes out of a zip held in memory. */
function readZipEntry(buf, wanted) {
  const entry = parseCentralDirectory(buf).find((e) => e.name === wanted);
  if (!entry) return null;
  const lo = entry.localOffset;
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;               // stored, not compressed
  try { return zlib.inflateRawSync(raw); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages
// ─────────────────────────────────────────────────────────────────────────────

/** Natural sort so page 2 comes before page 10. */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * List the image pages inside an archive, in archive order.
 *
 * Throws when the file holds no image at all. UnRAR exits 0 on a file that is not an
 * archive (TelDrive-encrypted bytes, for one), and an empty list was then registered
 * as an issue with no pages: 439 broken archives went unnoticed that way.
 */
function listPages(archiveFile) {
  const pages = listArchiveImages(archiveFile);
  if (!pages.length) {
    throw new Error('no image page found: not a readable archive (encrypted or corrupt?)');
  }
  return pages;
}

function listArchiveImages(archiveFile) {
  if (isTeldriveEncrypted(archiveFile)) {
    throw new Error('TelDrive-encrypted file: the mount serves it undecrypted');
  }
  if (isRar(archiveFile)) {
    const unrar = findUnrar();
    if (!unrar) throw new Error('UnRAR.exe not found (install WinRAR) — .cbr archives cannot be read');
    const out = execFileSync(unrar, ['lb', '-p-', '-y', archiveFile], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, input: '', timeout: 15000,
    });
    return out.split(/\r?\n/).filter((l) => l.trim() && IMAGE_RE.test(l)).sort(naturalCompare);
  }
  return listZipEntries(archiveFile)
    .map((e) => e.name)
    .filter((n) => IMAGE_RE.test(n) && !n.startsWith('__MACOSX'))
    .sort(naturalCompare);
}

/**
 * Extract one page to destDir and return the written path. Caller deletes it.
 *
 * UnRAR ignores an absolute destination path and writes into the current
 * directory instead, so it runs with cwd=destDir and a bare target name — and the
 * result is verified, because UnRAR exits 0 even when it wrote nothing at all.
 */
function extractPage(archiveFile, pageName, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(pageName));

  if (isRar(archiveFile)) {
    const unrar = findUnrar();
    if (!unrar) throw new Error('UnRAR.exe not found (install WinRAR)');
    const target = path.basename(pageName);
    execFileSync(unrar, ['e', '-p-', '-o+', '-idq', archiveFile, target], {
      cwd: destDir, stdio: 'ignore', windowsHide: true,
    });
    if (!fs.existsSync(dest)) {
      throw new Error(`UnRAR produced no output for ${target} (cwd ${destDir})`);
    }
    return dest;
  }

  const data = readZipEntry(fs.readFileSync(archiveFile), pageName);
  if (!data) throw new Error(`page not found in archive: ${pageName}`);
  fs.writeFileSync(dest, data);
  return dest;
}

module.exports = {
  LIBRARY_ROOT,
  RAR_EXT,
  ZIP_EXT,
  IMAGE_RE,
  isRar,
  isZip,
  findUnrar,
  listArchives,
  parseArchiveName,
  makeMatcher,
  parseCentralDirectory,
  listZipEntries,
  isTeldriveEncrypted,
  readZipEntry,
  listPages,
  listPagesRetrying,
  isTransientIoError,
  extractPage,
  naturalCompare,
};