/**
 * Hosted transcript API — request handling (src/index.js wires the database).
 *
 * Serves the read-only search routes of searchcore.js from the Turso copy of the
 * index (pushed by the PC, see server/hosted.js), so it answers while the PC is
 * off. Every request needs an API key (header X-API-Key); keys are managed with
 * server/scripts/api-keys.js and stored hashed in the api_key table.
 *
 * Kept free of the Turso client so tests can run it on a local libsql file.
 */
import core from '../../server/searchcore.js';

const PREFIX = '/api/search';
const KEY_TTL_MS = 60 * 1000;        // a revoked key stops working within a minute
const STATS_TTL_MS = 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const RATE_LIMIT_MAX_AUTH_FAILURES = 15;

function checkRateLimit(ipLimits, ip, isAuthFailure = false) {
  if (!ip) return true;
  const now = Date.now();
  let entry = ipLimits.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, failures: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    ipLimits.set(ip, entry);
  }
  if (isAuthFailure) {
    entry.failures++;
    if (entry.failures > RATE_LIMIT_MAX_AUTH_FAILURES) return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) return false;
  return true;
}

async function lookupKey(db, key, keys) {
  const hash = await core.hashApiKey(key);
  const cached = keys.get(hash);
  if (cached && cached.until > Date.now()) return cached;
  const row = await db.get('SELECT origins, revoked_at FROM api_key WHERE key_hash = ?', [hash]);
  const entry = { active: !!row && !row.revoked_at, origins: row?.origins, until: Date.now() + KEY_TTL_MS };
  keys.set(hash, entry);
  return entry;
}

/** progress / issues / meta, precomputed by the PC at each sync. */
async function hostedStats(db, cache) {
  if (cache.until > Date.now()) return cache.values;
  const values = {};
  for (const r of await db.all('SELECT name, value FROM stats', [])) values[r.name] = JSON.parse(r.value);
  Object.assign(cache, { values, until: Date.now() + STATS_TTL_MS });
  return values;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-API-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function respond(out, origin, cacheSeconds = 0) {
  const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  const headers = { 'Content-Type': out.type, ...corsHeaders(origin) };
  if (cacheSeconds > 0) headers['Cache-Control'] = `public, max-age=${Math.min(60, cacheSeconds)}, s-maxage=${cacheSeconds}, stale-while-revalidate=86400`;
  return new Response(body, { status: out.status, headers });
}

const error = (status, message, origin) =>
  respond({ status, type: 'application/json; charset=utf-8', body: { error: message } }, origin);

/** `database(env)` returns a searchcore adapter (all/get). */
export function createHandler(database) {
  const keys = new Map();            // key hash → { active, origins, until }, per isolate
  const statsCache = { until: 0 };
  const ipLimits = new Map();
  return async function fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return error(405, 'Read-only API: GET only', origin);

    const url = new URL(request.url);
    const isHealth = url.pathname === '/api/health';
    if (isHealth) return respond({ status: 200, type: 'application/json; charset=utf-8', body: { ok: true } }, origin, 60);


    const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length).replace(/\/+$/, '') : null;
    if (!isHealth && (route === null || !(route in core.ROUTES))) {
      return error(404, `Unknown route. Routes: /api/health, ${Object.keys(core.ROUTES).map((r) => PREFIX + r).join(', ')}`, origin);
    }

    try {
      const db = database(env);
      const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-real-ip') || '';
      if (!checkRateLimit(ipLimits, ip)) {
        return error(429, 'Too Many Requests (rate limit exceeded)', origin);
      }

      const key = request.headers.get('X-API-Key');
      if (!key) return error(401, 'Missing API key (header X-API-Key)', origin);
      if (typeof key !== 'string' || !key.startsWith('tk_') || key.length < 8 || key.length > 100) {
        checkRateLimit(ipLimits, ip, true);
        return error(401, 'Invalid API key format', origin);
      }
      const access = await lookupKey(db, key, keys);
      if (!access.active) {
        checkRateLimit(ipLimits, ip, true);
        return error(401, 'Unknown or revoked API key', origin);
      }
      if (!core.originAllowed(access.origins, origin)) return error(403, `Origin ${origin} not allowed for this key`, origin);

      const cache = typeof caches !== 'undefined' ? caches.default : null;
      if (cache) {
        const cached = await cache.match(request);
        if (cached) return cached;
      }

      const s = await hostedStats(db, statsCache);
      if (!s.meta) return error(503, 'Hosted index not synced yet: run server/scripts/sync-hosted.js on the PC', origin);
      if (isHealth) {
        return respond({ status: 200, type: 'application/json; charset=utf-8', body: { ok: true, ...s.meta } }, origin);
      }
      const query = Object.fromEntries(url.searchParams);
      const out = await core.ROUTES[route](db, query, {
        confidenceFloor: s.meta?.confidence_floor,
        progress: async () => s.progress,
        issues: async () => s.issues,
        // No scans here: images stay on the local API.
        imageUrl: null,
      });
      const res = respond(out, origin, 300);
      if (cache && out.status === 200) {
        ctx?.waitUntil ? ctx.waitUntil(cache.put(request, res.clone())) : cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      return error(500, e.message, origin);
    }
  };
}
