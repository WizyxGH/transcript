/**
 * scripts/hosted-setup.js
 * One-time creation of the hosted database (Turso) behind the public API.
 *
 * Needs, in Archiving-Helper's .env (or the environment):
 *   TURSO_PLATFORM_TOKEN   Turso dashboard → Settings → API Tokens → Create
 *   TURSO_ORG              your organization slug (the name in the dashboard URL)
 * Optional: TRANSCRIPT_TURSO_DB (default "transcript"), TURSO_GROUP (default: first group).
 *
 * Creates the database if missing, mints a full-access token (this PC pushes) and a
 * read-only token (the Worker reads), and writes TRANSCRIPT_TURSO_URL,
 * TRANSCRIPT_TURSO_TOKEN and TRANSCRIPT_TURSO_READ_TOKEN into that same .env.
 * Tokens are never printed. Safe to re-run: existing database kept, tokens renewed.
 */
const fs = require('fs');
const { config, AH_ENV } = require('../config');

const API = 'https://api.turso.tech/v1';

async function turso(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Set (or replace) KEY=value lines in the .env, keeping everything else as is. */
function writeEnv(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text += `${text && !text.endsWith(eol) ? eol : ''}${line}${eol}`;
  }
  fs.writeFileSync(file, text);
}

async function main() {
  const token = config('TURSO_PLATFORM_TOKEN', null);
  const org = config('TURSO_ORG', null);
  if (!token || !org) {
    throw new Error(`TURSO_PLATFORM_TOKEN and TURSO_ORG must be set in ${AH_ENV}`);
  }
  const name = config('TRANSCRIPT_TURSO_DB', 'transcript');

  let db = await turso(token, 'GET', `/organizations/${org}/databases/${name}`);
  if (db.status === 404) {
    let group = config('TURSO_GROUP', null);
    if (!group) {
      const groups = await turso(token, 'GET', `/organizations/${org}/groups`);
      if (!groups.ok) throw new Error(`listing groups failed (${groups.status}): ${JSON.stringify(groups.data)}`);
      group = groups.data.groups?.[0]?.name;
      if (!group) throw new Error('no Turso group: create one in the dashboard or set TURSO_GROUP');
    }
    const created = await turso(token, 'POST', `/organizations/${org}/databases`, { name, group });
    if (!created.ok) throw new Error(`creating ${name} failed (${created.status}): ${JSON.stringify(created.data)}`);
    console.log(`Base « ${name} » créée (groupe ${group}).`);
    db = await turso(token, 'GET', `/organizations/${org}/databases/${name}`);
  } else {
    console.log(`Base « ${name} » déjà présente.`);
  }
  if (!db.ok) throw new Error(`reading ${name} failed (${db.status}): ${JSON.stringify(db.data)}`);
  const hostname = db.data.database?.Hostname;
  if (!hostname) throw new Error(`no hostname for ${name}: ${JSON.stringify(db.data)}`);

  const mint = async (authorization) => {
    const r = await turso(token, 'POST',
      `/organizations/${org}/databases/${name}/auth/tokens?expiration=never&authorization=${authorization}`);
    if (!r.ok || !r.data.jwt) throw new Error(`minting a ${authorization} token failed (${r.status})`);
    return r.data.jwt;
  };

  writeEnv(AH_ENV, {
    TRANSCRIPT_TURSO_URL: `libsql://${hostname}`,
    TRANSCRIPT_TURSO_TOKEN: await mint('full-access'),
    TRANSCRIPT_TURSO_READ_TOKEN: await mint('read-only'),
  });
  console.log(`URL et jetons écrits dans ${AH_ENV}.`);
  console.log('Ensuite : node scripts/sync-hosted.js (premier envoi), puis le déploiement du Worker.');
}

main().catch((e) => { console.error('hosted-setup failed:', e.message); process.exit(1); });
