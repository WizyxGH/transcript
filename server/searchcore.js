/**
 * server/searchcore.js
 * The read side of the search API, shared by the local Express server and the
 * hosted Cloudflare Worker (apps/transcript/worker).
 *
 * Pure JavaScript, no Node built-in: the Worker bundles this file as is. Every
 * database access goes through an adapter with two async methods,
 *   all(sql, params) → plain row objects
 *   get(sql, params) → first row or undefined
 * so the same SQL runs on better-sqlite3 (local) and on Turso (hosted).
 *
 * Request handlers return { status, type, body }; each host only turns that into
 * its own response object. What legitimately differs between hosts is passed in
 * `options` (image URLs, Inducks story lookup, precomputed statistics).
 */

// A page whose mean OCR confidence is below this is not trusted enough to index.
const DEFAULT_CONFIDENCE_FLOOR = 0.80;

const MAX_HITS = 200;        // pages returned in `hits`
const MAX_ENTRIES = 1000;    // entries returned in `entries` (grouped over ALL matches)

/**
 * What counts as a story page, defined once for every JS consumer.
 *
 * Two vocabularies end up in page.kind: Inducks storyversion kinds ('n' story,
 * 'k' cover-story) and segmentation.js's own ('story', 'editorial'). Checking
 * only the first made 12 588 story pages invisible to the stories filter.
 * ocr_worker.py mirrors STORY_KINDS; a test keeps the two identical.
 */
const STORY_KINDS = ['n', 'k', 'story'];

/** SQL predicate for "this page belongs to a story"; `alias` is the page table alias. */
function storyPageSql(alias = '') {
  const c = alias ? `${alias}.` : '';
  const kinds = STORY_KINDS.map((k) => `'${k}'`).join(', ');
  return `(${c}kind IN (${kinds}) OR (COALESCE(${c}kind, '') = '' AND ${c}title IS NOT NULL))`;
}

/**
 * Make a snippet readable.
 *
 * Comic lettering is set in capitals, so a raw OCR snippet is a wall of
 * shouting. Lower-casing it costs nothing because FTS5's unicode61 tokenizer is
 * already case-insensitive — only the displayed text changes.
 */
function readable(snippet) {
  return String(snippet || '').toLowerCase();
}

/**
 * Turn what the user typed into an FTS5 MATCH expression.
 *
 * Every term is quoted (a literal, so "l'angle d'or" is not a syntax error) and
 * the words are ANDed. The last term matches on prefix so results appear while
 * the user is still typing. Hyphenated compounds are split ("porte-bonheur" →
 * "porte" AND "bonheur"): the tokenizer treats the hyphen as a separator.
 */
function toMatchExpression(raw) {
  const terms = String(raw || '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => t.split('-'))
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return null;
  const quoted = terms.map((t) => `"${t}"`);
  quoted[quoted.length - 1] += '*';
  return quoted.join(' AND ');
}

const isTrue = (v) => v === '1' || v === 'true';

/** Search filters from query parameters (one parser for every host). */
function parseSearchFilters(query) {
  const filters = {};
  if (query.country) filters.country = String(query.country);
  if (query.issue) filters.issuecode = String(query.issue);
  if (query.entry) filters.entrycode = String(query.entry);
  if (query.kind) filters.kind = String(query.kind);
  if (isTrue(query.stories_only)) filters.stories_only = true;
  if (query.min_confidence) filters.min_confidence = parseFloat(query.min_confidence);
  return filters;
}

function buildSearchFilter(filters) {
  const where = [];
  const params = [];
  if (filters.country) { where.push('p.country = ?'); params.push(filters.country); }
  if (filters.issuecode) {
    where.push("REPLACE(p.issuecode, ' ', '') = REPLACE(?, ' ', '')");
    params.push(filters.issuecode);
  }
  if (filters.entrycode) {
    where.push("REPLACE(p.entrycode, ' ', '') = REPLACE(?, ' ', '')");
    params.push(filters.entrycode);
  }
  if (filters.kind) {
    where.push('p.kind = ?');
    params.push(filters.kind);
  } else if (filters.stories_only) {
    where.push(storyPageSql('p'));
  }
  if (filters.min_confidence != null && !Number.isNaN(filters.min_confidence)) {
    where.push('p.confidence >= ?');
    params.push(Number(filters.min_confidence));
  }
  return { extra: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

const SNIPPET_SQL = "snippet(page_fts, 0, '«', '»', ' … ', 14)";

/**
 * Keyword search: one row per matching page, best first.
 *
 * `entrycode` is nullable: an issue is OCR'd as a whole, so until the story split
 * is confirmed the hit is reported at issue level rather than invented.
 */
async function search(db, match, { limit = 50, offset = 0, ...filters } = {}) {
  const { extra, params } = buildSearchFilter(filters);
  return db.all(`
    SELECT p.id, p.entrycode, p.issuecode, p.pageno,
           p.confidence, p.reviewed, p.width, p.height, p.title, p.storycode, p.kind,
           ${SNIPPET_SQL} AS snippet,
           bm25(page_fts) AS score
    FROM page_fts
    JOIN page p ON p.id = page_fts.rowid
    WHERE page_fts MATCH ?${extra}
    ORDER BY score, p.issuecode, p.pageno
    LIMIT ? OFFSET ?
  `, [match, ...params, limit, offset]);
}

/** How many pages a MATCH returns. */
async function countMatches(db, match, filters = {}) {
  const { extra, params } = buildSearchFilter(filters);
  const row = await db.get(`
    SELECT COUNT(*) AS n FROM page_fts
    JOIN page p ON p.id = page_fts.rowid
    WHERE page_fts MATCH ?${extra}
  `, [match, ...params]);
  return Number(row?.n || 0);
}

/**
 * Matches grouped by entry, over EVERY matching page.
 *
 * Grouping the first `limit` hits instead (as the route once did) silently
 * dropped entries: 470 pages matched « patinhas » but only the 200 best were
 * grouped. A caller using the entry list as a filter must get all of them.
 * The snippet is computed afterwards, only for each entry's best page.
 * `m` must be MATERIALIZED: bm25() is only valid while scanning the FTS table, and
 * SQLite refuses it once the CTE is flattened into the grouping query.
 */
async function searchEntries(db, match, filters = {}, { limit = MAX_ENTRIES } = {}) {
  const { extra, params } = buildSearchFilter(filters);
  const rows = await db.all(`
    WITH m AS MATERIALIZED (
      SELECT p.id, COALESCE(p.entrycode, p.issuecode) AS key, p.entrycode, p.issuecode,
             p.title, p.storycode, p.pageno, p.confidence, bm25(page_fts) AS score
      FROM page_fts
      JOIN page p ON p.id = page_fts.rowid
      WHERE page_fts MATCH ?${extra}
    ),
    best AS (SELECT key, id AS best_id, MIN(score) AS best_score FROM m GROUP BY key)
    SELECT m.key, MAX(m.entrycode) AS entrycode, MAX(m.issuecode) AS issuecode,
           MAX(m.title) AS title, MAX(m.storycode) AS storycode, COUNT(*) AS hits, GROUP_CONCAT(m.pageno) AS pages,
           MAX(m.confidence) AS maxConfidence, best.best_id AS bestId,
           best.best_score AS bestScore, COUNT(*) OVER () AS entryTotal
    FROM m JOIN best ON best.key = m.key
    GROUP BY m.key
    ORDER BY hits DESC, bestScore
    LIMIT ?
  `, [match, ...params, limit]);

  const snippets = new Map();
  if (rows.length) {
    const ids = rows.map((r) => r.bestId);
    const found = await db.all(`
      SELECT page_fts.rowid AS id, ${SNIPPET_SQL} AS snippet
      FROM page_fts
      WHERE page_fts MATCH ? AND page_fts.rowid IN (${ids.map(() => '?').join(',')})
    `, [match, ...ids]);
    for (const f of found) snippets.set(Number(f.id), f.snippet);
  }

  return {
    total: rows.length ? Number(rows[0].entryTotal) : 0,
    entries: rows.map((r) => ({
      key: r.key,
      entrycode: r.entrycode || null,
      issuecode: r.issuecode,
      title: r.title || null,
      storycode: r.storycode || null,
      hits: Number(r.hits),
      // Sorted page numbers show the extent of the entry, not relevance noise.
      pages: String(r.pages || '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b),
      firstSnippet: readable(snippets.get(Number(r.bestId))),
      maxConfidence: r.maxConfidence,
    })),
  };
}

/** Progress of the OCR pass. */
async function progress(db, floor = DEFAULT_CONFIDENCE_FLOOR) {
  const row = await db.get(`
    SELECT
      COUNT(*)                   AS total,
      SUM(state = 'done')        AS done,
      SUM(state = 'pending')     AS pending,
      SUM(state = 'failed')      AS failed,
      SUM(reviewed = 1)          AS reviewed,
      COUNT(DISTINCT issuecode)  AS issues
    FROM page
  `, []);
  // COUNT(*) on an external-content FTS5 table counts the *content* rows, not the
  // indexed ones. Apply the predicate that decides indexing instead.
  const indexed = await db.get(`
    SELECT COUNT(*) AS n FROM page
    WHERE state = 'done' AND text IS NOT NULL AND TRIM(text) <> '' AND confidence >= ?
  `, [floor]);
  const out = {};
  for (const k of ['total', 'done', 'pending', 'failed', 'reviewed', 'issues']) out[k] = Number(row?.[k] || 0);
  out.indexed = Number(indexed?.n || 0);

  let v1 = out.done;
  let v2 = 0;
  try {
    const vRow = await db.get(`
      SELECT
        SUM(state = 'done' AND (pipeline_version IS NULL OR pipeline_version = 1)) AS v1,
        SUM(state = 'done' AND pipeline_version >= 2) AS v2
      FROM page
    `, []);
    if (vRow) {
      v1 = Number(vRow.v1 || 0);
      v2 = Number(vRow.v2 || 0);
    }
  } catch {}
  out.pipeline_version_latest = 2;
  out.pipeline_v1 = v1;
  out.pipeline_v2 = v2;
  out.reprocess_needed = v1;

  return out;
}

/** Indexed issues with their OCR status. */
async function issues(db, floor = DEFAULT_CONFIDENCE_FLOOR, filterOptions = {}) {
  let rows = [];
  try {
    rows = await db.all(`
      SELECT issuecode, country, languagecode,
             COUNT(*)                                  AS pages,
             SUM(state = 'done')                       AS done,
             SUM(state = 'pending')                    AS pending,
             SUM(state = 'failed')                     AS failed,
             SUM(state = 'done' AND confidence >= ?)   AS indexed,
             SUM(state = 'done' AND (pipeline_version IS NULL OR pipeline_version < 2)) AS pending_repass
      FROM page
      GROUP BY issuecode
      ORDER BY issuecode
    `, [floor]);
  } catch {
    rows = await db.all(`
      SELECT issuecode, country, languagecode,
             COUNT(*)                                  AS pages,
             SUM(state = 'done')                       AS done,
             SUM(state = 'pending')                    AS pending,
             SUM(state = 'failed')                     AS failed,
             SUM(state = 'done' AND confidence >= ?)   AS indexed,
             0                                         AS pending_repass
      FROM page
      GROUP BY issuecode
      ORDER BY issuecode
    `, [floor]);
  }
  if (filterOptions.needsRepass) {
    rows = rows.filter((r) => Number(r.pending_repass || 0) > 0);
  }
  return rows;
}

/**
 * Resolve any identifier into a page filter:
 * entrycode or issuecode (space-insensitive, leading zeros, missing country),
 * storycode (needs Inducks: `options.findStory`), or a title.
 */
async function resolvePagesQuery(db, code, options = {}) {
  const raw = String(code || '').trim();
  const flat = raw.replace(/\s+/g, '');

  if (flat) {
    const entry = await db.get(`
      SELECT entrycode, issuecode, title FROM page
      WHERE REPLACE(entrycode, ' ', '') = ? LIMIT 1
    `, [flat]);
    if (entry) {
      return {
        type: 'entry', whereSql: "REPLACE(entrycode, ' ', '') = ?", params: [flat],
        title: entry.title, issuecode: entry.issuecode, entrycode: entry.entrycode,
      };
    }
    const issue = await db.get(`
      SELECT issuecode FROM page WHERE REPLACE(issuecode, ' ', '') = ? LIMIT 1
    `, [flat]);
    if (issue) {
      return { type: 'issue', whereSql: "REPLACE(issuecode, ' ', '') = ?", params: [flat], issuecode: issue.issuecode };
    }
    // Leading zeroes in the issue number ("it/TL0001" → "it/TL1").
    const lz = flat.match(/^([a-z]{2}\/[A-Za-z0-9]+?)0+([0-9]+[a-z]?)$/i);
    if (lz) {
      const stripped = lz[1] + lz[2];
      const found = await db.get(`
        SELECT issuecode FROM page WHERE REPLACE(issuecode, ' ', '') = ? LIMIT 1
      `, [stripped]);
      if (found) {
        return { type: 'issue', whereSql: "REPLACE(issuecode, ' ', '') = ?", params: [stripped], issuecode: found.issuecode };
      }
    }
    // Missing country prefix ("TL 1" → "%/TL 1").
    if (!flat.includes('/')) {
      const found = await db.get(`
        SELECT issuecode FROM page WHERE REPLACE(issuecode, ' ', '') LIKE '%/' || ? LIMIT 1
      `, [flat]);
      if (found) {
        return {
          type: 'issue', whereSql: "REPLACE(issuecode, ' ', '') = ?",
          params: [found.issuecode.replace(/\s+/g, '')], issuecode: found.issuecode,
        };
      }
    }
  }

  // Storycode ("I TL 1-A"): only a host with the Inducks database can resolve it.
  const storycode = options.storycode || (raw.includes('-') && !raw.includes('/') ? raw : null);
  if (storycode && options.findStory) {
    const rows = await options.findStory(storycode);
    if (rows && rows.length) {
      const entrycodes = rows.map((r) => r.entrycode);
      return {
        type: 'story', whereSql: `entrycode IN (${entrycodes.map(() => '?').join(',')})`,
        params: entrycodes, title: rows[0].title, storycode,
        issuecode: rows[0].issuecode, entrycode: rows[0].entrycode,
        entries: rows,              // Inducks order: one entry per issue the story is printed in
      };
    }
  }

  const titleSearch = options.title || (!raw.includes('/') && raw.length >= 3 ? raw : null);
  if (titleSearch) {
    const found = await db.get(`
      SELECT entrycode, issuecode, title FROM page
      WHERE title LIKE ? AND entrycode IS NOT NULL LIMIT 1
    `, [`%${titleSearch}%`]);
    if (found) {
      return {
        type: 'entry', whereSql: 'entrycode = ?', params: [found.entrycode],
        title: found.title, issuecode: found.issuecode, entrycode: found.entrycode,
      };
    }
  }
  return null;
}

// ── Request handlers ─────────────────────────────────────────────────────────

const json = (body, status = 200) => ({ status, type: 'application/json; charset=utf-8', body });
const text = (body, type) => ({ status: 200, type: `${type}; charset=utf-8`, body });
const floorOf = (options) => (options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR);

/** GET /api/search?q=… — matching pages (`hits`) and the entries they belong to. */
async function handleSearch(db, query) {
  const q = query.q;
  const match = toMatchExpression(q);
  if (!match) return json({ query: q || '', terms: [], total: 0, hits: [], entries: [] });

  const requested = parseInt(query.limit, 10) || 50;
  const limit = Math.min(requested, MAX_HITS);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  const filters = parseSearchFilters(query);

  try {
    const total = await countMatches(db, match, filters);
    const raw = await search(db, match, { ...filters, limit, offset });
    // The Inducks title is denormalised onto the page by segment-library.js.
    const hits = raw.map((r) => ({
      id: r.id,
      issuecode: r.issuecode,
      entrycode: r.entrycode || null,
      pageno: r.pageno,
      confidence: r.confidence,
      reviewed: !!r.reviewed,
      width: r.width,
      height: r.height,
      snippet: readable(r.snippet),
      title: r.title || null,
      storycode: r.storycode || null,
    }));
    // Entries are always returned (the transcript UI reads them); `entries=1` is
    // kept for callers that send it.
    const grouped = await searchEntries(db, match, filters, { limit: Math.min(requested, MAX_ENTRIES) });
    return json({
      query: q, match, terms: String(q).trim().split(/\s+/), total, limit, offset, hits,
      entries: grouped.entries, entryTotal: grouped.total,
    });
  } catch (err) {
    // A malformed MATCH expression reads as "nothing found", not a 500.
    if (/fts5|MATCH/.test(String(err.message))) {
      return json({ query: q || '', total: 0, hits: [], entries: [], error: err.message });
    }
    throw err;
  }
}

/**
 * GET /api/search/entry — every page of one entry, issue or story, in scan order.
 * code|issue|entry, storycode, title, stories_only, kind, state, min_confidence,
 * format=json|text|markdown
 */
async function handleEntry(db, query, options = {}) {
  const code = query.code || query.issue || query.entry;
  const resolved = await resolvePagesQuery(db, code, {
    storycode: query.storycode, title: query.title, findStory: options.findStory,
  });
  if (!resolved) {
    return json({
      error: 'Missing or unknown identifier',
      hint: 'Use code=it/TL 1, code=it/TL 1b, storycode=I TL 1-A, or title=...',
    }, 400);
  }

  const where = [resolved.whereSql];
  const params = [...resolved.params];
  if (isTrue(query.stories_only)) where.push(storyPageSql());
  if (query.kind) { where.push('kind = ?'); params.push(String(query.kind)); }
  if (query.state) { where.push('state = ?'); params.push(String(query.state)); }
  if (query.min_confidence) {
    where.push('(confidence >= ? OR reviewed = 1)');
    params.push(parseFloat(query.min_confidence));
  }

  const pages = await db.all(`
    SELECT *
    FROM page
    WHERE ${where.join(' AND ')}
    ORDER BY issuecode, pageno
  `, params);
  if (!pages.length) return json({ error: 'No transcribed page found for that query/filter', resolved }, 404);

  const entries = groupByEntry(pages, resolved.entries);
  const first = entries[0];
  const title = resolved.title || first.title || null;
  const transcribed = countTranscribed(pages);
  const imageUrl = (id) => (options.imageUrl ? options.imageUrl(id) : null);
  // Several entries only for a story printed in several owned issues: label each one.
  const several = entries.length > 1;
  const entryLabel = (e) => `${e.issuecode}${e.entrycode !== e.issuecode ? ` → ${e.entrycode}` : ''}`
    + `${e.languagecode ? ` [${e.languagecode}]` : ''}${e.title && e.title !== title ? ` — ${e.title}` : ''}`;

  if (query.format === 'text' || query.format === 'transcript') {
    const lines = [
      title || first.entrycode,
      resolved.storycode ? `Histoire Inducks : ${resolved.storycode} (${entries.length} entrée(s))` : `Numéro Inducks : ${first.issuecode}`,
      `Pages : ${pages.length} (${transcribed} transcrites)`,
      '='.repeat(60),
      '',
    ];
    for (const e of entries) {
      if (several) lines.push(`##### ${entryLabel(e)}`, '');
      for (const p of e.pages) {
        const conf = p.confidence ? ` [confiance ${(p.confidence * 100).toFixed(0)}%]` : '';
        lines.push(`--- Page ${p.pageno} (${p.kind || 'page'})${conf} ---`);
        lines.push(p.text ? p.text.trim() : '(page sans texte OCR)');
        lines.push('');
      }
    }
    return text(lines.join('\n'), 'text/plain');
  }

  if (query.format === 'markdown' || query.format === 'md') {
    const lines = [
      `# ${title || first.entrycode}`,
      resolved.storycode ? `* **Histoire** : \`${resolved.storycode}\` (${entries.length} entrée(s))` : `* **Numéro** : \`${first.issuecode}\``,
      `* **Planches** : ${pages.length} (${transcribed} transcrites)`,
      '',
    ];
    for (const e of entries) {
      if (several) lines.push(`## ${entryLabel(e)}`, '');
      for (const p of e.pages) {
        lines.push(`### Page ${p.pageno} ${p.kind ? `*(${p.kind})*` : ''}`);
        lines.push(p.text ? p.text.split('\n').map((l) => `> ${l}`).join('\n') : '*Non transcrite*');
        const url = imageUrl(p.id);
        if (url) lines.push(`\n[![Planche](${url})](${url})\n`);
      }
    }
    return text(lines.join('\n'), 'text/markdown');
  }

  return json({
    type: resolved.type,
    storycode: resolved.storycode || null,
    entrycode: first.entrycode,
    issuecode: first.issuecode,
    title,
    segmented: !!pages[0].entrycode,
    pageCount: pages.length,
    transcribed,
    entries: entries.map((e) => ({
      entrycode: e.entrycode,
      storycode: e.storycode || null,
      issuecode: e.issuecode,
      languagecode: e.languagecode,
      title: e.title,
      pageCount: e.pages.length,
      transcribed: countTranscribed(e.pages),
      pages: e.pages.map((p) => ({
        id: p.id,
        pageno: p.pageno,
        kind: p.kind,
        title: p.title,
        storycode: p.storycode || null,
        text: p.text,
        pipeline_version: p.pipeline_version ?? 1,
        structured_text: p.structured_text ?? null,
        confidence: p.confidence,
        reviewed: !!p.reviewed,
        n_boxes: p.n_boxes,
        state: p.state,
        width: p.width,
        height: p.height,
        imageUrl: imageUrl(p.id),
      })),
    })),
  });
}

const countTranscribed = (pages) => pages.filter((p) => p.state === 'done' && p.text).length;

/**
 * Pages → Inducks entries, each with its own pages in scan order.
 *
 * A story is printed in one entry per issue it appears in, often in another language
 * and under another title; mixing their pages lost which printing each came from.
 * `inducksEntries` (from the storycode lookup) gives Inducks' order and local titles;
 * an unsegmented issue becomes one entry keyed by its issuecode.
 */
function groupByEntry(pages, inducksEntries = []) {
  const known = new Map((inducksEntries || []).map((e, i) => [e.entrycode, { ...e, order: i }]));
  const groups = new Map();
  for (const p of pages) {
    const key = p.entrycode || p.issuecode;
    if (!groups.has(key)) {
      const inducks = known.get(p.entrycode) || {};
      groups.set(key, {
        entrycode: key,
        issuecode: p.issuecode,
        languagecode: p.languagecode || null,
        title: inducks.title || p.title || null,
        storycode: inducks.storycode || p.storycode || null,
        order: inducks.order ?? Infinity,
        pages: [],
      });
    }
    groups.get(key).pages.push(p);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order);   // stable: scan order otherwise
}

/** GET /api/search/progress — `options.progress` replaces the live count (hosted stats). */
async function handleProgress(db, options = {}) {
  const floor = floorOf(options);
  const p = options.progress ? await options.progress() : await progress(db, floor);
  const percent = p.total ? Math.round((100 * (p.done || 0)) / p.total) : 0;
  return json({ ...p, percent, confidence_floor: floor });
}

/** GET /api/search/issues — `options.issues` replaces the live count (hosted stats). */
async function handleIssues(db, query = {}, options = {}) {
  if (query && (query.confidenceFloor != null || query.issues)) {
    options = query;
    query = {};
  }
  const needsRepass = query.needs_repass === '1' || query.needs_repass === 'true';
  return json(options.issues ? await options.issues() : await issues(db, floorOf(options), { needsRepass }));
}

/** Fields of GET /api/search/page; the local host adds its private ones (archive path…). */
const PAGE_FIELDS = [
  'id', 'issuecode', 'entrycode', 'storycode', 'country', 'languagecode', 'pageno', 'title', 'kind',
  'text', 'confidence', 'n_boxes', 'state', 'width', 'height', 'ocr_engine',
  'pipeline_version', 'structured_text',
];

/** GET /api/search/page?id=N */
async function handlePage(db, query, options = {}) {
  const id = parseInt(query.id, 10);
  if (!id) return json({ error: 'Missing id' }, 400);
  const page = await db.get('SELECT * FROM page WHERE id = ?', [id]);
  if (!page) return json({ error: 'Page not found' }, 404);
  const out = {};
  for (const f of [...PAGE_FIELDS, ...(options.extraPageFields || [])]) out[f] = page[f] ?? null;
  out.reviewed = !!page.reviewed;
  return json(out);
}

/** Read-only routes, relative to /api/search; both hosts mount exactly these. */
const ROUTES = {
  '': (db, query) => handleSearch(db, query),
  '/entry': handleEntry,
  '/progress': (db, _query, options) => handleProgress(db, options),
  '/issues': (db, query, options) => handleIssues(db, query, options),
  '/page': handlePage,
};

/** Adapter over a libsql client (Turso): the hosted API and the tests use it. */
function libsqlAdapter(client) {
  const rows = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  return {
    all: async (sql, args = []) => rows(await client.execute({ sql, args })),
    get: async (sql, args = []) => rows(await client.execute({ sql, args }))[0],
  };
}

// ── API keys (hosted API) ────────────────────────────────────────────────────

/** SHA-256 hex of a key: the database stores only this, never the key. */
async function hashApiKey(key) {
  const bytes = new TextEncoder().encode(String(key));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A key's allowed origins: '*' (any, e.g. a server) or a comma-separated list. */
function originAllowed(origins, origin) {
  if (!origin) return true;                      // not a browser request
  const list = String(origins || '*').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(origin);
}

module.exports = {
  DEFAULT_CONFIDENCE_FLOOR,
  MAX_HITS,
  MAX_ENTRIES,
  STORY_KINDS,
  storyPageSql,
  readable,
  toMatchExpression,
  parseSearchFilters,
  buildSearchFilter,
  search,
  countMatches,
  searchEntries,
  progress,
  issues,
  resolvePagesQuery,
  handleSearch,
  handleEntry,
  handleProgress,
  handleIssues,
  handlePage,
  PAGE_FIELDS,
  ROUTES,
  libsqlAdapter,
  hashApiKey,
  originAllowed,
};
