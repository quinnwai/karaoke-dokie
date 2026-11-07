// Builds the song list for a mood-labelling run from the vocal-range pipeline's Billboard export,
// and the gold-set sheet to fill in by hand (QWW-11). Only reads the pipeline's files.
// Usage: npx tsx scripts/moods-billboard.ts <pipeline data dir> --songs songs.json [--template gold-set-template.csv]
// Songs: every row of karaoke_ranges.json (its key, artist and title; alias keys included, since the
// app looks songs up by any of them), with the year of the first Billboard Year-End chart the song
// is on, from billboard_songs.csv joined by songKey of artist_credit and title, or of the credit's
// first artist when that misses (the pipeline keys duets like "Ariana Grande and The Weeknd" by
// the lead artist). Alias rows share their song's display artist and title, so a year found for
// one key carries to the others.
// The sheet: 60 songs, one row per song, spread over decades and over sung and mostly-rap songs
// (the only style marker the list has) by pickGoldSongs.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCsv } from '../src/lib/moods/csv';
import { goldTemplateCsv, pickGoldSongs, type GoldCandidate } from '../src/lib/moods/gold';
import type { SongToLabel } from '../src/lib/moods/label';
import { songKey } from '../src/lib/songs/resolve';

const GOLD_SIZE = 60;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { songs: { type: 'string' }, template: { type: 'string' } } });
  const [dir] = positionals;
  if (!dir || !values.songs) throw new Error('Usage: moods-billboard.ts <pipeline data dir> --songs songs.json [--template sheet.csv]');

  const { ranges } = JSON.parse(await readFile(join(dir, 'karaoke_ranges.json'), 'utf8')) as { ranges: { key: string; artist: string; title: string }[] };
  const [header = [], ...rows] = parseCsv(await readFile(join(dir, 'billboard_songs.csv'), 'utf8'));
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`billboard_songs.csv has no ${name} column`);
    return i;
  };
  const [yearCol, titleCol, artistCol, rapCol] = [col('year'), col('title'), col('artist_credit'), col('mostly_rap')];

  // Billboard: first chart year and the mostly-rap flag, per songKey of the credit and of its lead artist.
  const chart = new Map<string, { year: number; rap: boolean }>();
  const byLead = new Map<string, { year: number; rap: boolean }>();
  const keep = (map: Map<string, { year: number; rap: boolean }>, key: string, hit: { year: number; rap: boolean }) => {
    const old = map.get(key);
    if (!old || hit.year < old.year) map.set(key, hit);
  };
  for (const r of rows) {
    const credit = r[artistCol] ?? '';
    const title = r[titleCol] ?? '';
    const hit = { year: Number(r[yearCol]), rap: r[rapCol] === '1' };
    keep(chart, songKey(credit, title), hit);
    keep(byLead, songKey(credit.split(/\s+(?:and|&|with)\s+|,\s+/i)[0] ?? credit, title), hit);
  }

  const display = (r: { artist: string; title: string }) => `${r.artist}\u0000${r.title}`;
  const byDisplay = new Map<string, { year: number; rap: boolean }>();
  for (const r of ranges) {
    const own = songKey(r.artist, r.title);
    const hit = chart.get(r.key) ?? chart.get(own) ?? byLead.get(r.key) ?? byLead.get(own);
    const old = byDisplay.get(display(r));
    if (hit && (!old || hit.year < old.year)) byDisplay.set(display(r), hit);
  }

  const songs: SongToLabel[] = ranges.map((r) => {
    const hit = byDisplay.get(display(r));
    return { key: r.key, artist: r.artist, title: r.title, ...(hit ? { year: hit.year } : {}) };
  });
  await writeFile(values.songs, JSON.stringify(songs, null, 1) + '\n');
  const withYear = songs.filter((s) => s.year !== undefined).length;
  console.log(`${songs.length} songs (${new Set(ranges.map(display)).size} distinct artist and title), ${withYear} with a year`);

  if (values.template) {
    // One row per song: the row whose key is the song's own songKey, else its first alias.
    const perSong = new Map<string, GoldCandidate>();
    for (const r of ranges) {
      const hit = byDisplay.get(display(r));
      if (!hit) continue;
      const own = r.key === songKey(r.artist, r.title);
      if (!perSong.has(display(r)) || own) perSong.set(display(r), { key: r.key, artist: r.artist, title: r.title, year: hit.year, rap: hit.rap });
    }
    const picked = pickGoldSongs([...perSong.values()], GOLD_SIZE);
    await writeFile(values.template, goldTemplateCsv(picked.map(({ rap: _rap, ...s }) => s)));
    const decades = new Map<number, number>();
    for (const p of picked) decades.set(Math.floor(p.year / 10) * 10, (decades.get(Math.floor(p.year / 10) * 10) ?? 0) + 1);
    console.log(
      `Gold-set sheet: ${picked.length} songs from ${perSong.size}; per decade ${[...decades].sort().map(([d, n]) => `${d}s ${n}`).join(', ')}; ` +
        `${picked.filter((p) => p.rap).length} mostly rap`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
