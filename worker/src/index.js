/**
 * Hosted transcript API — Cloudflare Worker entry point.
 *
 * Serves the read-only search routes of server/searchcore.js from the Turso copy
 * of the index (pushed by the PC, see server/hosted.js), so it answers while the
 * PC is off. Request handling and API keys: src/handler.js.
 *
 * Secrets (set by scripts/deploy.js): TURSO_URL, TURSO_TOKEN (read-only).
 */
import { createClient } from '@libsql/client/web';
import core from '../../server/searchcore.js';
import { createHandler } from './handler.js';

let adapter = null;
const database = (env) =>
  adapter || (adapter = core.libsqlAdapter(createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN })));

export default { fetch: createHandler(database) };
