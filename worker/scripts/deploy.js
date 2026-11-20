/**
 * Deploy the hosted API: push its secrets, then the code.
 *
 *   node scripts/deploy.js            (needs `npx wrangler login` once)
 *
 * Secrets come from Archiving-Helper's .env through server/config.js — the same
 * place the PC reads them — and go to Cloudflare through stdin, never printed:
 *   TURSO_URL   ← TRANSCRIPT_TURSO_URL
 *   TURSO_TOKEN ← TRANSCRIPT_TURSO_READ_TOKEN (read-only: the Worker never writes)
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { config, AH_ENV } = require('../../server/config.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerPkg = require.resolve('wrangler/package.json', { paths: [path.join(here, '..')] });
const wrangler = path.join(path.dirname(wranglerPkg), 'bin', 'wrangler.js');

function run(args, input) {
  const r = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: path.join(here, '..'), input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

const secrets = {
  TURSO_URL: config('TRANSCRIPT_TURSO_URL', null),
  TURSO_TOKEN: config('TRANSCRIPT_TURSO_READ_TOKEN', null),
};
const missing = Object.entries(secrets).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing in ${AH_ENV}: TRANSCRIPT_TURSO_URL / TRANSCRIPT_TURSO_READ_TOKEN. Run server/scripts/hosted-setup.js first.`);
  process.exit(1);
}

run(['deploy']);                                  // creates the Worker on first run
run(['secret', 'bulk'], JSON.stringify(secrets)); // secrets need the Worker to exist
