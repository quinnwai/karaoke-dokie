// Fills or refreshes our copy of USDB's song list (no note files), so syncs skip searching.
// Usage: npm run usdb:index [-- --full]   (needs DATABASE_URL, USDB_USERNAME, USDB_PASSWORD)
// First run reads the whole list (about 14 minutes); later runs read only what changed.

import { getStore } from '../src/lib/server/getStore';
import { createUsdbClient } from '../src/lib/usdb/client';
import { updateUsdbIndex } from '../src/lib/usdb/songIndex';

async function main() {
  const username = process.env.USDB_USERNAME;
  const password = process.env.USDB_PASSWORD;
  if (!username || !password) throw new Error('Set USDB_USERNAME and USDB_PASSWORD');
  const summary = await updateUsdbIndex({
    store: getStore(),
    usdb: createUsdbClient({ username, password }),
    full: process.argv.includes('--full'),
    onProgress: (l) => console.log(l),
  });
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
