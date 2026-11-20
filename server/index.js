/**
 * server/index.js
 * Main Express server
 */
// Load .env manually (no dotenv dependency needed)
const fs = require('fs');
const envPath = require('path').join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...vals] = line.replace(/\r/g, '').split('=');
    if (key && !key.startsWith('#') && vals.length) {
      process.env[key.trim()] = process.env[key.trim()] || vals.join('=').trim();
    }
  });
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const { DB_PATH } = require('./db');
const { getCoverageStats, formatUptime } = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────
// TelDrive keep-alive: the host sleeps after ~15 min idle and the T: mount then
// hangs. Only the public address wakes it (see config.js).
// ─────────────────────────────────────────────
const { TELDRIVE_PUBLIC_URL, TELDRIVE_KEEPALIVE_MS } = require('./config');
if (TELDRIVE_PUBLIC_URL) {
  const pingTelDrive = async () => {
    try {
      await fetch(`${TELDRIVE_PUBLIC_URL.replace(/\/+$/, '')}/api/version`);
    } catch (_) {}
  };
  setInterval(pingTelDrive, TELDRIVE_KEEPALIVE_MS);
  pingTelDrive();
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────
app.use('/api/health', require('./routes/health'));
app.use('/api/publications', require('./routes/publications'));
app.use('/api/issues', require('./routes/entries'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/ocr', require('./routes/ocr'));
app.use('/api/transcriptions', require('./routes/transcriptions'));
app.use('/api/exports', require('./routes/exports'));
app.use('/api/search', require('./routes/search'));

// Root welcome & interactive documentation dashboard
app.get('/', (req, res) => {
  const coverage = getCoverageStats();
  const uptime = formatUptime(process.uptime());

  // Coverage is progress, not health: grey = not started, amber = in progress,
  // green from 90 % (nearly everything searchable). Red is kept for real failures.
  const COVERAGE_GREEN_FROM = 90;
  const coverageColor = (p) => {
    const rate = parseFloat(p.completion_rate) || 0;
    if (!p.done_pages) return { fg: '#94a3b8', bg: '#1e293b' };
    if (rate < COVERAGE_GREEN_FROM) return { fg: '#fde68a', bg: '#78350f' };
    return { fg: '#6ee7b7', bg: '#064e3b' };
  };

  const pubsRows = coverage.publications.map(p => `
    <tr>
      <td><strong>${p.publication}</strong>${p.title ? `<div class="hint">${p.title}</div>` : ''}</td>
      <td>${p.country}</td>
      <td>${p.total_pages || p.pages || 0}</td>
      <td><span style="color: ${coverageColor(p).fg}; font-weight: bold;">${p.done_pages}</span></td>
      <td>
        <span style="font-size: 0.8rem; color: #fde68a;">v1: ${p.v1_pages || 0}</span>
        ${(p.v2_pages > 0) ? `<span style="font-size: 0.8rem; color: #4ade80; font-weight: bold; margin-left: 0.3rem;">v2: ${p.v2_pages}</span>` : ''}
        ${(p.v1_pages > 0 && p.done_pages > 0) ? `<div style="font-size: 0.72rem; color: #f87171;">⚠️ ${p.v1_pages} à repasser</div>` : ''}
      </td>
      <td><span class="badge" style="background: ${coverageColor(p).bg}; color: ${coverageColor(p).fg};">${p.completion_rate}</span></td>
      <td>
        <a href="/api/search/entry?code=${encodeURIComponent(p.first_issue)}" target="_blank">Explorer</a>
        ${(p.v1_pages > 0) ? ` · <a href="/api/search/issues?needs_repass=1" target="_blank" style="color: #f87171; font-size: 0.8rem;">repasse</a>` : ''}
      </td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Transcript API — Hub OCR & Couverture</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 2rem; background: #0b0f19; color: #f1f5f9; line-height: 1.6; max-width: 960px; margin: 0 auto; }
          .card { background: #151d30; padding: 1.8rem; border-radius: 1rem; border: 1px solid #24324f; box-shadow: 0 10px 25px rgba(0,0,0,0.4); margin-bottom: 1.5rem; }
          h1 { color: #38bdf8; margin-top: 0; display: flex; align-items: center; gap: 0.5rem; }
          h2 { color: #93c5fd; border-bottom: 1px solid #24324f; padding-bottom: 0.5rem; margin-top: 1.5rem; }
          a.button { display: inline-flex; align-items: center; background: #0284c7; color: white; padding: 0.6rem 1.2rem; border-radius: 0.5rem; text-decoration: none; font-weight: bold; transition: background 0.2s; font-size: 0.9rem; }
          a.button:hover { background: #0369a1; }
          .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; font-weight: bold; background: #1e3a8a; color: #93c5fd; }
          .badge.get { background: #064e3b; color: #6ee7b7; }
          .badge.post { background: #78350f; color: #fde68a; }
          .badge.cloud { background: #581c87; color: #d8b4fe; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
          th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #1f2d48; }
          th { color: #94a3b8; font-weight: 600; }
          code { background: #0b1120; padding: 0.2rem 0.4rem; border-radius: 0.3rem; color: #38bdf8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
          a { color: #38bdf8; text-decoration: none; }
          a:hover { text-decoration: underline; }
          .hint { color: #94a3b8; font-size: 0.85rem; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; margin: 1rem 0; }
          .stat-box { background: #0f172a; padding: 1.1rem; border-radius: 0.6rem; border: 1px solid #1e293b; }
          .stat-label { color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }
          .stat-val { font-size: 1.35rem; font-weight: bold; margin-top: 0.2rem; }
          .stat-sub { font-size: 0.8rem; color: #64748b; margin-top: 0.25rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Transcript API — Hub OCR Disney</h1>
          <p>Moteur d'indexation OCR plein texte, segmentation Inducks et recherche sémantique dans les bulles de BD.</p>
          <div style="display: flex; gap: 0.75rem; margin-top: 1.25rem; flex-wrap: wrap;">
            <a class="button" href="http://localhost:5173/InducksButBetter/">Ouvrir InducksButBetter (Port 5173)</a>
            <a class="button" style="background: #0284c7;" href="/api/health">Voir JSON Brut Complet (/api/health)</a>
            <a class="button" style="background: #1e293b; border: 1px solid #334155;" href="/api/search/progress">Progression Indexation (/progress)</a>
          </div>
        </div>

        <!-- LIVE COVERAGE & HEALTH STATS -->
        <div class="card" style="border-left: 4px solid #38bdf8;">
          <h2>Statistiques de Couverture OCR & Santé Système</h2>
          
          <div class="grid">
            <div class="stat-box">
              <div class="stat-label">Statut Serveur</div>
              <div class="stat-val" style="color: #4ade80;">● En Ligne</div>
              <div class="stat-sub">Uptime : ${uptime}</div>
            </div>

            <div class="stat-box">
              <div class="stat-label">TelDrive (Blitz.cloud)</div>
              <div class="stat-val" style="color: #38bdf8;">${coverage.teldriveMount.mounted ? 'Disque T: Connecté' : 'API Active'}</div>
              <div class="stat-sub">Keep-Alive 3m | ${coverage.teldriveMount.available_countries} pays scannés</div>
            </div>

            <div class="stat-box">
              <div class="stat-label">Planches OCRisées</div>
              <div class="stat-val" style="color: #fbbf24;">${coverage.overall.done_pages} / ${coverage.overall.total_pages}</div>
              <div class="stat-sub">Taux : <strong>${coverage.overall.completion_rate}</strong> | Confiance : ${(coverage.overall.avg_confidence * 100).toFixed(1)}%</div>
            </div>

            <div class="stat-box" style="border-left: 3px solid #a855f7;">
              <div class="stat-label">Version OCR (Pipelines)</div>
              <div class="stat-val" style="color: #c084fc;">
                v2: <span style="color: #4ade80;">${coverage.overall.v2_pages || 0}</span> / v1: <span style="color: #fde68a;">${coverage.overall.v1_pages || 0}</span>
              </div>
              <div class="stat-sub">
                ${coverage.overall.v1_pages > 0 
                  ? `<span style="color: #f87171; font-weight: bold;">⚠️ ${coverage.overall.v1_pages} en v1</span> (<a href="/api/search/issues?needs_repass=1" target="_blank" style="color: #fca5a5;">voir numéros</a>)` 
                  : '<span style="color: #4ade80;">✨ Tout à jour en v2</span>'}
              </div>
            </div>

            <div class="stat-box">
              <div class="stat-label">Numéros Indexés</div>
              <div class="stat-val" style="color: #f472b6;">${coverage.overall.total_issues} numéros</div>
              <div class="stat-sub">${coverage.publications.length} séries répertoriées (${coverage.overall.done_issues} OCRisé)</div>
            </div>
          </div>

          <!-- Cloud OCR status badge -->
          <div style="margin-top: 1.25rem; padding: 0.85rem 1rem; background: #0f172a; border-radius: 0.5rem; border: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="badge cloud">GitHub Actions 24/7</span>
              <span style="font-size: 0.85rem; color: #cbd5e1;">Worker Cloud OCR autonome sans PC (Archiving-Helper) : <strong>toutes les 6h</strong></span>
            </div>
            <span style="font-size: 0.8rem; color: #94a3b8;">${coverage.cloudOcr.done_archives} tome(s) traité(s) dans le cloud</span>
          </div>

          <h3 style="color: #cbd5e1; font-size: 1rem; margin-top: 1.5rem; margin-bottom: 0.5rem;">Détail par Publication dans search.sqlite :</h3>
          <table>
            <thead>
              <tr>
                <th>Publication</th>
                <th>Pays</th>
                <th>Total Planches</th>
                <th>Traitées (Done)</th>
                <th>Couverture</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${pubsRows || '<tr><td colspan="6">Aucune publication indexée.</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>1. Explorer un Numéro ou une Histoire précise</h2>
          <p>Vous n'êtes pas limité aux recherches par mots-clés : vous pouvez récupérer tout le texte OCRisé d'un numéro ou d'une histoire d'un seul coup.</p>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Endpoint</th>
                <th>Description</th>
                <th>Test direct</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span class="badge get">GET</span></td>
                <td><code>/api/search/entry?code={issuecode}</code></td>
                <td>Toutes les planches d'un numéro dans l'ordre avec leur transcription</td>
                <td><a href="/api/search/entry?code=it/TL 1" target="_blank">Topolino n°1 (it/TL 1)</a></td>
              </tr>
              <tr>
                <td><span class="badge get">GET</span></td>
                <td><code>/api/search/entry?code={entrycode}</code></td>
                <td>Toutes les planches d'une histoire spécifique</td>
                <td><a href="/api/search/entry?code=it/TL 1b" target="_blank">Topolino e il cobra bianco (it/TL 1b)</a></td>
              </tr>
              <tr>
                <td><span class="badge get">GET</span></td>
                <td><code>/api/search/entry?title={titre}</code></td>
                <td>Recherche directe par titre d'histoire (sans connaître le code)</td>
                <td><a href="/api/search/entry?title=cobra bianco" target="_blank">Titre "cobra bianco"</a></td>
              </tr>
              <tr>
                <td><span class="badge get">GET</span></td>
                <td><code>/api/search/entry?code=...&format=text</code></td>
                <td>Format script texte continu pour lecture directe ou LLM</td>
                <td><a href="/api/search/entry?code=it/TL 1b&format=text" target="_blank">Script texte brut</a></td>
              </tr>
              <tr>
                <td><span class="badge get">GET</span></td>
                <td><code>/api/search/entry?code=...&stories_only=1</code></td>
                <td>Filtre strict BD (exclut couvertures, pubs et jeux)</td>
                <td><a href="/api/search/entry?code=it/TL 1&stories_only=1" target="_blank">BD seulement (it/TL 1)</a></td>
              </tr>
              <tr>
                <td><span class="badge get">GET</span></td>
                <td><code>/api/search/page?id={id}</code></td>
                <td>Détail d'une page spécifique (texte, nombre de bulles)</td>
                <td><a href="/api/search/page?id=387" target="_blank">Page id #387</a></td>
              </tr>
              <tr>
                <td><span class="badge get">GET</span></td>
                <td><code>/api/search/page/image?id={id}</code></td>
                <td>Affiche l'image originale de la planche extraite du scan TelDrive</td>
                <td><a href="/api/search/page/image?id=387" target="_blank">Image scan #387</a></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>2. Recherche Plein Texte dans les Bulles (FTS5)</h2>
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Description</th>
                <th>Test direct</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>/api/search?q={mot}</code></td>
                <td>Recherche globale par mot ou phrase</td>
                <td><a href="/api/search?q=Paperino" target="_blank">Recherche "Paperino"</a></td>
              </tr>
              <tr>
                <td><code>/api/search?q={mot}&entries=1</code></td>
                <td>Recherche regroupée par histoire Inducks</td>
                <td><a href="/api/search?q=Paperino&entries=1" target="_blank">Grouper par histoire</a></td>
              </tr>
              <tr>
                <td><code>/api/search/progress</code></td>
                <td>Progression globale des pages OCRisées</td>
                <td><a href="/api/search/progress" target="_blank">Voir l'avancement</a></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>3. Publications & Scans Inducks</h2>
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Description</th>
                <th>Test direct</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>/api/publications</code></td>
                <td>Liste des publications avec tomes scannés</td>
                <td><a href="/api/publications" target="_blank">Voir les publications</a></td>
              </tr>
              <tr>
                <td><code>/api/issues/entries?code={issuecode}</code></td>
                <td>Détail des entrées du numéro dans la base Inducks officielle</td>
                <td><a href="/api/issues/entries?code=it/TL    1" target="_blank">Entrées Inducks de it/TL 1</a></td>
              </tr>
            </tbody>
          </table>
          <p class="hint" style="margin-top: 1.5rem;">Documentation technique complète accessible dans <code>apps/transcript/server/API.md</code>.</p>
        </div>
      </body>
    </html>
  `);
});

// ─────────────────────────────────────────────
// Serve frontend (production)
// ─────────────────────────────────────────────
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`\nTranscriptDisneyComics API`);
  console.log(`   http://localhost:${PORT}`);
  if (!fs.existsSync(DB_PATH)) {
    console.log(`\n Database not found. Run: npm run setup-db`);
  } else {
    console.log(`   DB: ${DB_PATH}`);
  }
  startHostedSync();
});

/**
 * Keep the hosted copy (public API, apps/transcript/worker) up to date while this
 * server runs: OCR'd pages are pushed every TRANSCRIPT_SYNC_MS. Off when
 * TRANSCRIPT_TURSO_URL is not configured. Passes never overlap.
 */
function startHostedSync() {
  const hosted = require('./hosted');
  if (!hosted.HOSTED_URL) return;
  const { getSearchDb, CONFIDENCE_FLOOR } = require('./searchdb');
  const remote = hosted.hostedClient();
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const { pushed, remaining } = await hosted.syncHosted(getSearchDb(), remote, { floor: CONFIDENCE_FLOOR });
      if (pushed) console.log(`   hosted sync: ${pushed} page(s) pushed, ${remaining} queued`);
    } catch (e) {
      console.error(`   hosted sync failed: ${e.message}`);
    } finally {
      running = false;
    }
  };
  console.log(`   hosted sync: every ${hosted.SYNC_MS / 1000} s → ${hosted.HOSTED_URL}`);
  setInterval(pass, hosted.SYNC_MS);
  pass();
}

module.exports = app;
