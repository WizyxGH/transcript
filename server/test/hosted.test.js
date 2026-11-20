/**
 * The hosted copy (Turso) and the public API must answer exactly like the local
 * index, and the push must never lose a change.
 *
 * Runs on throwaway files: a better-sqlite3 search.sqlite and a libsql file
 * standing in for Turso (same engine as the hosted database).
 *
 * Run: npm test   (from apps/transcript/server)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-hosted-'));
process.env.SEARCH_DB = path.join(dir, 'search.sqlite');
process.env.OCR_CONFIDENCE_FLOOR = '0.8';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');
const { createClient } = require('@libsql/client');
const searchdb = require('../searchdb');
const core = require('../searchcore');
const hosted = require('../hosted');

const local = searchdb.getSearchDb();
const remoteClient = createClient({ url: pathToFileURL(path.join(dir, 'hosted.db')).href });
const L = searchdb.sqliteAdapter(local);
const R = core.libsqlAdapter(remoteClient);
const FLOOR = 0.8;
const sync = (remote = remoteClient) => hosted.syncHosted(local, remote, { floor: FLOOR });

after(() => {
  remoteClient.close();
  local.close();
  // libsql releases its file handle lazily on Windows: best effort.
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp dir */ }
});

// fr/JMC 5: page 12 trusted, page 13 below the floor, page 14 corrected by hand, 15 pending.
const ids = {};
function seed() {
  searchdb.registerIssuePages(local, 'fr/JMC    5', 'T:/x/fr_JMC_5.cbz', ['p11.jpg', 'p12.jpg', 'p13.jpg', 'p14.jpg', 'p15.jpg'],
    { country: 'fr', languagecode: 'fr' });
  for (const r of local.prepare('SELECT id, pagename FROM page').all()) ids[r.pagename] = r.id;
  local.prepare("UPDATE page SET entrycode = 'fr/JMC    5p012', title = 'Sou fétiche de malheurs', kind = 'n' WHERE pageno >= 2")
    .run();
  // Written with plain SQL then indexed with the OCR worker's own rule (confidence
  // floor, corrections always), like ocr_worker.store() + the review route do.
  const ocr = (name, text, confidence, reviewed = 0) => local.prepare(`
    UPDATE page SET text = ?, confidence = ?, reviewed = ?, n_boxes = 3, ocr_engine = 'test',
                    width = 10, height = 20, state = 'done' WHERE id = ?`).run(text, confidence, reviewed, ids[name]);
  ocr('p11.jpg', 'SOMMAIRE DU JOURNAL', 0.95);
  ocr('p12.jpg', 'MON SOU FÉTICHE!\nIL EST À MOI', 0.97);
  ocr('p13.jpg', 'FÉTICHE ILLISIBLE', 0.4);
  ocr('p14.jpg', 'Fétiche corrigé à la main', 0.3, 1);
  local.prepare(`INSERT INTO page_fts (rowid, text) SELECT id, text FROM page
                 WHERE state = 'done' AND (confidence >= ? OR reviewed = 1)`).run(FLOOR);
}

const QUERIES = [
  ['', { q: 'fetiche', entries: '1' }],
  ['', { q: 'sou fétiche', limit: '1' }],
  ['', { q: 'sommaire', stories_only: '1' }],
  ['/entry', { code: 'fr/JMC5p012' }],
  ['/entry', { code: 'JMC 5', format: 'text' }],
  ['/page', { id: null }],
];

test('first push copies pages, index and statistics; answers match the local API', async () => {
  seed();
  const first = await sync();
  assert.deepEqual(first, { pushed: 4, remaining: 0 }, 'the pending page 15 is not copied');

  for (const [route, q] of QUERIES) {
    // The hosted copy holds OCR'd pages only: compare entries on those.
    const query = { ...q, id: q.id === null ? String(ids['p12.jpg']) : q.id, ...(route === '/entry' ? { state: 'done' } : {}) };
    const a = await core.ROUTES[route](L, query, { confidenceFloor: FLOOR });
    const b = await core.ROUTES[route](R, query, { confidenceFloor: FLOOR });
    assert.deepEqual(b, a, `${route} ${JSON.stringify(query)}`);
  }
  // Low-confidence page 13 is not searchable; the corrected page 14 is.
  const found = (await core.handleSearch(R, { q: 'fetiche' })).body.hits.map((h) => h.pageno).sort();
  assert.deepEqual(found, [2, 4]);

  const stats = Object.fromEntries((await R.all('SELECT name, value FROM stats')).map((r) => [r.name, JSON.parse(r.value)]));
  assert.deepEqual(stats.progress, await core.progress(L, FLOOR));
  assert.equal(stats.meta.confidence_floor, FLOOR);

  // Where the scans live on this PC stays on this PC.
  const cols = (await R.all('PRAGMA table_info(page)')).map((c) => c.name);
  assert.ok(!cols.includes('archive') && !cols.includes('pagename'), cols.join(','));
});

test('later changes and deletions are pushed, nothing else', async () => {
  assert.deepEqual(await sync(), { pushed: 0, remaining: 0 });
  // The Python OCR worker writes with plain SQL: triggers must catch it too.
  local.prepare("UPDATE page SET text = 'TICKET GAGNANT', confidence = 0.9, state = 'done' WHERE id = ?").run(ids['p15.jpg']);
  local.prepare("UPDATE page SET error = 'ignored' WHERE id = ?").run(ids['p11.jpg']);   // not copied: no push
  local.prepare('DELETE FROM page WHERE id = ?').run(ids['p13.jpg']);
  assert.deepEqual(await sync(), { pushed: 2, remaining: 0 });

  assert.equal((await core.handleSearch(R, { q: 'gagnant' })).body.total, 1);
  assert.equal(await R.get('SELECT id FROM page WHERE id = ?', [ids['p13.jpg']]), undefined);
});

test('a page changed during its own push is pushed again, not lost', async () => {
  local.prepare("UPDATE page SET text = 'VERSION UN' WHERE id = ?").run(ids['p11.jpg']);
  let changed = false;
  const racing = {
    batch: async (stmts, mode) => {
      const r = await remoteClient.batch(stmts, mode);
      if (!changed && stmts.some((s) => /INSERT INTO page \(/.test(s.sql))) {
        changed = true;      // the OCR worker rewrites the page while it is in flight
        local.prepare("UPDATE page SET text = 'VERSION DEUX' WHERE id = ?").run(ids['p11.jpg']);
      }
      return r;
    },
  };
  await sync(racing);
  await sync();
  assert.equal((await R.get('SELECT text FROM page WHERE id = ?', [ids['p11.jpg']])).text, 'VERSION DEUX');
});

test('public API: key required, origin enforced, revocation, read-only', async () => {
  const { createHandler } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/handler.js')).href);
  const key = 'tk_test_key';
  await remoteClient.execute({
    sql: "INSERT INTO api_key (name, key_hash, origins) VALUES ('ibb', ?, 'https://wizyxgh.github.io')",
    args: [await core.hashApiKey(key)],
  });
  const fetch = createHandler(() => R);
  const call = async (url, headers = {}, method = 'GET') => {
    const res = await fetch(new Request(`https://api.test${url}`, { method, headers }), {});
    return { status: res.status, body: await res.text(), cors: res.headers.get('Access-Control-Allow-Origin') };
  };
  const site = { 'X-API-Key': key, Origin: 'https://wizyxgh.github.io' };

  assert.equal((await call('/api/search?q=fetiche')).status, 401);
  assert.equal((await call('/api/search?q=fetiche', { 'X-API-Key': 'tk_wrong' })).status, 401);
  assert.equal((await call('/api/search?q=fetiche', { ...site, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/search/page', site, 'POST')).status, 405);
  assert.equal((await call('/api/search/page/image?id=1', site)).status, 404);
  assert.equal((await call('/api/search/page', { Origin: site.Origin }, 'OPTIONS')).status, 204);

  const ok = await call('/api/search?q=fetiche&entries=1', site);
  assert.equal(ok.status, 200);
  assert.equal(ok.cors, site.Origin);
  assert.deepEqual(JSON.parse(ok.body), (await core.handleSearch(L, { q: 'fetiche', entries: '1' })).body);

  const progress = JSON.parse((await call('/api/search/progress', site)).body);
  assert.equal(progress.total, (await core.progress(L, FLOOR)).total);
  assert.equal(JSON.parse((await call('/api/health', site)).body).ok, true);
  // Hosted entries carry no image link: scans stay on the local API.
  const entry = JSON.parse((await call('/api/search/entry?code=fr/JMC5p012', site)).body);
  assert.equal(entry.entries[0].pages[0].imageUrl, null);

  await remoteClient.execute("UPDATE api_key SET revoked_at = unixepoch() WHERE name = 'ibb'");
  const fresh = createHandler(() => R);       // new isolate: no cached key
  const res = await fresh(new Request('https://api.test/api/search?q=x', { headers: site }), {});
  assert.equal(res.status, 401);
});
