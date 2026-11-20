/**
 * server/routes/health.js
 * Comprehensive Health & OCR Coverage Status Endpoint
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getSearchDb } = require('../searchdb');
const { DB_PATH, getTranscriptionsDb, getCoaDb } = require('../db');
const {
  SCAN_LIBRARY, DATABASE_DIR, TELDRIVE_LOCAL_URL, TELDRIVE_PUBLIC_URL, TELDRIVE_KEEPALIVE_MS,
} = require('../config');

const SEARCH_DB_PATH = process.env.SEARCH_DB || path.join(DATABASE_DIR, 'search.sqlite');

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}j`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

function getFileSizeMB(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return +(fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
    }
  } catch (_) {}
  return 0;
}

/**
 * issuecode → { publicationcode, title } from Inducks.
 *
 * The publication cannot be cut out of the issuecode: `it/TL 1000` has a space before
 * the number but `lu/LW600305` has none, which listed every Luxembourg issue as its own
 * publication. Unknown issues (or no Inducks database) fall back to the issuecode.
 */
function publicationsOf(issuecodes) {
  const out = new Map();
  let coa;
  try { coa = getCoaDb(); } catch { return out; }
  for (let i = 0; i < issuecodes.length; i += 500) {
    const chunk = issuecodes.slice(i, i + 500);
    const rows = coa.prepare(`
      SELECT i.issuecode, i.publicationcode, p.title
      FROM inducks_issue i LEFT JOIN inducks_publication p ON p.publicationcode = i.publicationcode
      WHERE i.issuecode IN (${chunk.map(() => '?').join(',')})
    `).all(...chunk);
    for (const r of rows) out.set(r.issuecode, { publicationcode: r.publicationcode, title: r.title });
  }
  return out;
}

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Per-issue page counts → one row per Inducks publication, largest first. */
function groupByPublication(perIssue, pubOf) {
  const groups = new Map();
  for (const r of perIssue) {
    const pub = pubOf.get(r.issuecode) || { publicationcode: r.issuecode, title: null };
    let g = groups.get(pub.publicationcode);
    if (!g) {
      g = { publication: pub.publicationcode, title: pub.title, country: r.country, total_pages: 0,
        done_pages: 0, pending_pages: 0, v1_pages: 0, v2_pages: 0, issues: 0, done_issues: 0, conf_sum: 0, first_issue: r.issuecode };
      groups.set(pub.publicationcode, g);
    }
    g.total_pages += r.total_pages;
    g.done_pages += r.done_pages;
    g.pending_pages += r.pending_pages;
    g.v1_pages += r.v1_pages || 0;
    g.v2_pages += r.v2_pages || 0;
    g.issues += 1;
    if (r.done_pages) g.done_issues += 1;
    g.conf_sum += r.conf_sum || 0;
    if (naturalCompare(r.issuecode, g.first_issue) < 0) g.first_issue = r.issuecode;
  }
  return [...groups.values()]
    .map(({ conf_sum, ...g }) => ({
      ...g,
      pages: g.total_pages,
      avg_confidence: g.done_pages ? +(conf_sum / g.done_pages).toFixed(3) : null,
      completion_rate: g.total_pages > 0 ? ((g.done_pages / g.total_pages) * 100).toFixed(1) + '%' : '0.0%',
    }))
    .sort((a, b) => b.total_pages - a.total_pages);
}

function getCoverageStats() {
  const db = getSearchDb();
  
  // 1. Overall stats
  let overall = {
    total_pages: 0,
    done_pages: 0,
    pending_pages: 0,
    failed_pages: 0,
    total_issues: 0,
    done_issues: 0,
    avg_confidence: 0,
    completion_rate: '0.0%',
    v1_pages: 0,
    v2_pages: 0,
    pipeline_version_latest: 2
  };

  try {
    const row = db.prepare(`
      SELECT 
        count(*) as total_pages,
        coalesce(sum(CASE WHEN state = 'done' THEN 1 ELSE 0 END), 0) as done_pages,
        coalesce(sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) as pending_pages,
        coalesce(sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) as failed_pages,
        coalesce(sum(CASE WHEN state = 'done' AND (pipeline_version IS NULL OR pipeline_version = 1) THEN 1 ELSE 0 END), 0) as v1_pages,
        coalesce(sum(CASE WHEN state = 'done' AND pipeline_version >= 2 THEN 1 ELSE 0 END), 0) as v2_pages,
        count(distinct issuecode) as total_issues,
        count(distinct CASE WHEN state = 'done' THEN issuecode ELSE null END) as done_issues,
        round(avg(CASE WHEN state = 'done' THEN confidence ELSE null END), 3) as avg_confidence
      FROM page
    `).get();
    
    if (row && row.total_pages > 0) {
      overall = {
        total_pages: row.total_pages,
        done_pages: row.done_pages,
        pending_pages: row.pending_pages,
        failed_pages: row.failed_pages,
        v1_pages: row.v1_pages,
        v2_pages: row.v2_pages,
        pipeline_version_latest: 2,
        total_issues: row.total_issues,
        done_issues: row.done_issues,
        avg_confidence: row.avg_confidence || 0,
        completion_rate: ((row.done_pages / row.total_pages) * 100).toFixed(2) + '%'
      };
    }
  } catch (err) {
    console.error('[health] Error reading page stats:', err.message);
  }

  // 2. Breakdown by publication
  let publications = [];
  try {
    const perIssue = db.prepare(`
      SELECT issuecode,
        coalesce(country, 'inconnu') as country,
        count(*) as total_pages,
        sum(CASE WHEN state = 'done' THEN 1 ELSE 0 END) as done_pages,
        sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) as pending_pages,
        sum(CASE WHEN state = 'done' AND (pipeline_version IS NULL OR pipeline_version = 1) THEN 1 ELSE 0 END) as v1_pages,
        sum(CASE WHEN state = 'done' AND pipeline_version >= 2 THEN 1 ELSE 0 END) as v2_pages,
        sum(CASE WHEN state = 'done' THEN confidence ELSE 0 END) as conf_sum
      FROM page
      GROUP BY issuecode
    `).all();
    publications = groupByPublication(perIssue, publicationsOf(perIssue.map((r) => r.issuecode)));
  } catch (err) {
    console.error('[health] Error reading publication stats:', err.message);
  }

  // 3. Breakdown by country
  let countries = [];
  try {
    countries = db.prepare(`
      SELECT 
        coalesce(country, 'inconnu') as country,
        count(*) as total_pages,
        sum(CASE WHEN state = 'done' THEN 1 ELSE 0 END) as done_pages,
        count(distinct issuecode) as issues,
        count(distinct CASE WHEN state = 'done' THEN issuecode ELSE null END) as done_issues
      FROM page
      GROUP BY country
      ORDER BY total_pages DESC
    `).all().map(c => ({
      ...c,
      completion_rate: c.total_pages > 0 ? ((c.done_pages / c.total_pages) * 100).toFixed(1) + '%' : '0.0%'
    }));
  } catch (_) {}

  // 4. Cloud pipeline status (Archiving-Helper)
  let cloudOcr = {
    active: false,
    workflow: 'WizyxGH/Archiving-Helper/.github/workflows/ocr-pipeline.yml',
    schedule: 'Toutes les 6h + workflow_dispatch',
    done_archives: 0,
    total_pages_ocr: 0,
    last_run_timestamp: null
  };

  const cloudStatusPath = path.resolve(__dirname, '../../../../../../Automatisations/Archiving-Helper/collection/ocr_status.json');
  if (fs.existsSync(cloudStatusPath)) {
    try {
      const cData = JSON.parse(fs.readFileSync(cloudStatusPath, 'utf8'));
      const doneKeys = Object.keys(cData.done || {});
      cloudOcr.active = true;
      cloudOcr.done_archives = doneKeys.length;
      cloudOcr.total_pages_ocr = cData.total_pages || 0;
      if (doneKeys.length > 0) {
        const lastTs = Math.max(...doneKeys.map(k => cData.done[k]?.timestamp || 0));
        if (lastTs > 0) cloudOcr.last_run_timestamp = new Date(lastTs * 1000).toISOString();
      }
    } catch (_) {}
  }

  // 5. TelDrive library mount info
  let teldriveMount = {
    path: SCAN_LIBRARY,
    mounted: false,
    available_countries: 0
  };
  try {
    if (fs.existsSync(SCAN_LIBRARY)) {
      teldriveMount.mounted = true;
      teldriveMount.available_countries = fs.readdirSync(SCAN_LIBRARY, { withFileTypes: true }).filter(d => d.isDirectory()).length;
    }
  } catch (_) {}

  // 6. Transcriptions DB stats
  let transcriptions = { total_entries: 0, validated_entries: 0 };
  try {
    const tdb = getTranscriptionsDb();
    const tRow = tdb.prepare('SELECT count(*) as total, coalesce(sum(validated), 0) as val FROM transcriptions').get();
    if (tRow) {
      transcriptions.total_entries = tRow.total;
      transcriptions.validated_entries = tRow.val;
    }
  } catch (_) {}

  return {
    overall,
    publications,
    countries,
    cloudOcr,
    teldriveMount,
    transcriptions
  };
}

/**
 * GET /api/health
 */
router.get('/', (req, res) => {
  const dbInducksReady = fs.existsSync(DB_PATH);
  const dbSearchReady = fs.existsSync(SEARCH_DB_PATH);
  const coverage = getCoverageStats();

  const mem = process.memoryUsage();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: formatUptime(process.uptime()),
    uptime_seconds: Math.floor(process.uptime()),
    system: {
      node_version: process.version,
      pid: process.pid,
      memory: {
        rss_mb: +(mem.rss / 1024 / 1024).toFixed(1),
        heap_used_mb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
        heap_total_mb: +(mem.heapTotal / 1024 / 1024).toFixed(1)
      }
    },
    services: {
      teldrive: {
        status: coverage.teldriveMount.mounted ? 'mounted' : 'accessible_api',
        api_host: TELDRIVE_LOCAL_URL,
        public_url: TELDRIVE_PUBLIC_URL,
        keep_alive: TELDRIVE_PUBLIC_URL
          ? `active (ping every ${TELDRIVE_KEEPALIVE_MS / 60000} min)`
          : 'off (TELDRIVE_PUBLIC_URL not set)',
        mount_point: coverage.teldriveMount.path,
        mount_ready: coverage.teldriveMount.mounted,
        available_countries: coverage.teldriveMount.available_countries
      },
      databases: {
        search_sqlite: {
          ready: dbSearchReady,
          path: SEARCH_DB_PATH,
          size_mb: getFileSizeMB(SEARCH_DB_PATH),
          indexed_pages: coverage.overall.total_pages
        },
        inducks_sqlite: {
          ready: dbInducksReady,
          path: DB_PATH,
          size_mb: getFileSizeMB(DB_PATH)
        },
        transcriptions_sqlite: {
          ready: true,
          entries_count: coverage.transcriptions.total_entries,
          validated_count: coverage.transcriptions.validated_entries
        }
      },
      cloud_ocr_pipeline: {
        active: coverage.cloudOcr.active,
        workflow: coverage.cloudOcr.workflow,
        schedule: coverage.cloudOcr.schedule,
        cloud_done_archives: coverage.cloudOcr.done_archives,
        last_cloud_run: coverage.cloudOcr.last_run_timestamp
      }
    },
    coverage: {
      summary: {
        total_pages: coverage.overall.total_pages,
        done_pages: coverage.overall.done_pages,
        pending_pages: coverage.overall.pending_pages,
        failed_pages: coverage.overall.failed_pages,
        completion_rate: coverage.overall.completion_rate,
        avg_confidence: coverage.overall.avg_confidence,
        total_issues: coverage.overall.total_issues,
        done_issues: coverage.overall.done_issues
      },
      by_publication: coverage.publications,
      by_country: coverage.countries
    }
  });
});

module.exports = router;
module.exports.getCoverageStats = getCoverageStats;
module.exports.formatUptime = formatUptime;
module.exports.getFileSizeMB = getFileSizeMB;

module.exports.groupByPublication = groupByPublication;
