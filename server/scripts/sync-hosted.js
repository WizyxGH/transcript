/**
 * scripts/sync-hosted.js
 * Push OCR'd pages to the hosted copy (Turso) read by the public API.
 *
 *   node scripts/sync-hosted.js           push everything queued, then exit
 *   node scripts/sync-hosted.js --watch   keep pushing every TRANSCRIPT_SYNC_MS
 *
 * The API server (node index.js) already does --watch's job while it runs; this
 * script is for the first, long push and for checking by hand.
 */
const { getSearchDb, CONFIDENCE_FLOOR } = require('../searchdb');
const { syncHosted, hostedClient, SYNC_MS } = require('../hosted');

async function once(db, remote) {
  const t0 = Date.now();
  const { pushed, remaining } = await syncHosted(db, remote, {
    floor: CONFIDENCE_FLOOR,
    log: (line) => process.stdout.write(`\r${line}`),
  });
  if (pushed) process.stdout.write('\n');
  console.log(`${pushed} page(s) poussée(s) en ${((Date.now() - t0) / 1000).toFixed(1)} s, ${remaining} en attente`);
}

async function main() {
  const db = getSearchDb();
  const remote = hostedClient();
  await once(db, remote);
  if (!process.argv.includes('--watch')) return remote.close();
  for (;;) {
    await new Promise((r) => setTimeout(r, SYNC_MS));
    await once(db, remote).catch((e) => console.error('sync failed:', e.message));
  }
}

main().catch((e) => { console.error('sync-hosted failed:', e.message); process.exit(1); });
