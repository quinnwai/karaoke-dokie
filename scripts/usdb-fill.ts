// Computes ranges for every USDB song we don't have yet, most popular first (run usdb:index first).
// Usage: npm run usdb:fill [-- --limit N] [--skip-countdown] [--recheck-fast]   (needs DATABASE_URL, USDB_USERNAME, USDB_PASSWORD)
// --recheck-fast re-reads only the songs flagged as fast lyrics and clears the flag where the
// current rule disagrees.
// By default waits out USDB's download countdown (about 27 s per song). --skip-countdown asks
// for each file straight away, like USDB Syncer (OK'd by the USDB folks for this fill), still one
// request every 2.5 s, so about 2.5 s per song. Stop and rerun any time.
// Don't run it alongside usdb:sync or usdb:index: USDB allows one login per account.

import { getStore } from '../src/lib/server/getStore';
import { createUsdbClient } from '../src/lib/usdb/client';
import { fillCatalogue } from '../src/lib/usdb/fillCatalogue';

async function main() {
  const username = process.env.USDB_USERNAME;
  const password = process.env.USDB_PASSWORD;
  if (!username || !password) throw new Error('Set USDB_USERNAME and USDB_PASSWORD');
  const at = process.argv.indexOf('--limit');
  const limit = at >= 0 ? Number(process.argv[at + 1]) : Infinity;
  const summary = await fillCatalogue({
    store: getStore(),
    usdb: createUsdbClient({ username, password, skipCountdown: process.argv.includes('--skip-countdown') }),
    limit,
    recheckFast: process.argv.includes('--recheck-fast'),
    onProgress: (l) => console.log(l),
  });
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
