/**
 * scripts/api-keys.js
 * API keys of the hosted API: one per client project.
 *
 *   node scripts/api-keys.js create <name> [--origins https://a.example,https://b.example]
 *   node scripts/api-keys.js list
 *   node scripts/api-keys.js revoke <name>
 *
 * The key is printed once, at creation; only its SHA-256 is stored. `--origins`
 * limits which websites may call the API with it (browser requests carry their
 * Origin); without it the key works from anywhere (scripts, servers).
 * A key shipped in a public website is readable by anyone: the origin list is
 * what keeps other sites from reusing it, and revoke is the way out.
 */
const crypto = require('crypto');
const { hostedClient, HOSTED_SCHEMA } = require('../hosted');
const { hashApiKey } = require('../searchcore');

function usage() {
  console.log('Usage: node scripts/api-keys.js create <name> [--origins a,b] | list | revoke <name>');
  process.exit(1);
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const i = process.argv.indexOf('--origins');
  const origins = i > 0 ? process.argv[i + 1] : '*';
  if (!cmd) usage();

  const db = hostedClient();
  await db.batch(HOSTED_SCHEMA.map((sql) => ({ sql, args: [] })), 'write');

  if (cmd === 'create') {
    if (!name) usage();
    const key = `tk_${crypto.randomBytes(24).toString('base64url')}`;
    await db.execute({
      sql: 'INSERT INTO api_key (name, key_hash, origins) VALUES (?, ?, ?)',
      args: [name, await hashApiKey(key), origins || '*'],
    });
    console.log(`Clé « ${name} » créée (origines : ${origins || '*'}). Elle ne sera plus affichée :`);
    console.log(key);
  } else if (cmd === 'list') {
    const r = await db.execute('SELECT name, origins, created_at, revoked_at FROM api_key ORDER BY name');
    for (const k of r.rows) {
      const state = k.revoked_at ? `révoquée le ${new Date(k.revoked_at * 1000).toLocaleDateString('fr-FR')}` : 'active';
      console.log(`${k.name}\t${state}\t${k.origins}`);
    }
    if (!r.rows.length) console.log('Aucune clé.');
  } else if (cmd === 'revoke') {
    if (!name) usage();
    const r = await db.execute({
      sql: 'UPDATE api_key SET revoked_at = unixepoch() WHERE name = ? AND revoked_at IS NULL',
      args: [name],
    });
    console.log(r.rowsAffected ? `Clé « ${name} » révoquée (effective sous 1 min).` : `Aucune clé active nommée « ${name} ».`);
  } else {
    usage();
  }
  db.close();
}

main().catch((e) => { console.error('api-keys failed:', e.message); process.exit(1); });
