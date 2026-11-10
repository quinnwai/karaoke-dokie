// Mood labels from AcousticBrainz's audio models (CC0) for the vocal-range pipeline's measured
// recordings (QWW-19). Reads karaoke_ranges.json (never changes it), asks AcousticBrainz about each
// recording's MusicBrainz ID (range.mbid), 25 at a time and at most 2 requests a second, caching
// every raw response in --cache (keep it outside the repo), so a rerun asks only about recordings
// no cached response covers. Writes one row per song key whose recording AcousticBrainz has.
// Usage: npm run moods:acousticbrainz -- <karaoke_ranges.json> --cache <dir> [--out data/moods/labels-acousticbrainz-v1.json]

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AB_METHOD, AB_PROXIES, AB_SOURCE, abRecords, fetchHighLevel, type CachedResponse } from '../src/lib/moods/acousticbrainz';
import { formatMoodRows } from '../src/lib/moods/merge';

const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : 'n/a');

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { cache: { type: 'string' }, out: { type: 'string' } } });
  const [rangesPath] = positionals;
  const cacheDir = values.cache;
  if (!rangesPath || !cacheDir) throw new Error('Usage: npm run moods:acousticbrainz -- <karaoke_ranges.json> --cache <dir> [--out labels.json]');

  const { ranges } = JSON.parse(await readFile(rangesPath, 'utf8')) as { ranges: { key: string; range?: { mbid?: string } }[] };
  const songs = ranges.flatMap((r) => (r.range?.mbid ? [{ key: r.key, mbid: r.range.mbid }] : []));

  await mkdir(cacheDir, { recursive: true });
  const cached: CachedResponse[] = [];
  for (const name of (await readdir(cacheDir)).filter((n) => /^high-level-.*\.json$/.test(n))) {
    cached.push(JSON.parse(await readFile(join(cacheDir, name), 'utf8')) as CachedResponse);
  }
  const models = await fetchHighLevel({
    mbids: songs.map((s) => s.mbid),
    cached,
    save: async (response) => {
      const file = join(cacheDir, `high-level-${response.requested[0]}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(response));
      await rename(`${file}.tmp`, file);
    },
    onBatch: (done, total) => console.log(`asked AcousticBrainz: ${done} / ${total} batches`),
  });

  const rows = abRecords(songs, models);
  const recordings = new Set(songs.map((s) => s.mbid.toLowerCase())).size;
  const upbeat = rows.filter((r) => r.moods.includes('upbeat')).length;
  const heartfelt = rows.filter((r) => r.moods.includes('heartfelt')).length;
  console.log(
    `${ranges.length} song keys, ${songs.length} with a recording ID (${recordings} recordings); AcousticBrainz has ${models.size} of the recordings. ` +
      `${rows.length} keys labelled: Upbeat ${upbeat} (${pct(upbeat, rows.length)}), Heartfelt ${heartfelt} (${pct(heartfelt, rows.length)}).`,
  );

  if (values.out) {
    const comment =
      "Mood labels from AcousticBrainz's audio models (acousticbrainz.org, MetaBrainz, CC0) for the vocal-range pipeline's measured recordings, " +
      `by MusicBrainz recording ID. Upbeat: ${AB_PROXIES.upbeat.rule}. Heartfelt: ${AB_PROXIES.heartfelt.rule}. ` +
      'Songs AcousticBrainz has no data for are left out. Made with npm run moods:acousticbrainz; stored with npm run moods:import (data/moods/README.md).';
    await writeFile(values.out, formatMoodRows({ comment, source: AB_SOURCE, method: AB_METHOD }, rows));
    console.log(`Wrote ${values.out}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
