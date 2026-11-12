// Redoes the narrow stored song ranges (src/lib/songs/narrow.ts, the rule in range.ts applyNarrowRule, QWW-60): a note
// file of 5 semitones or fewer gets a 1% trim from its pitch histogram instead of 5%, what is still that narrow is
// marked low confidence (the Maybe group), and so is a recording of 5 semitones or fewer.
// Usage: npx tsx scripts/narrow-ranges.ts [--dry-run] [--after <song key>] [--show <song key>]... [--sample <n>]
// Needs DATABASE_URL: the database it reads and, without --dry-run, rewrites. It prints that database's host and name first.
// Reads the whole song_ranges table, 1,000 rows at a time, and rewrites only the rows the rule changes (a row's log line is kept).
// Safe to run again, and to stop and run again: a second run reports `"changed":0`. Every page prints its last song key;
// `--after <that key>` skips what a stopped run had done. It runs no schema migration, so a dry run reads and nothing else.
// --show prints the change of a song that has one, --sample the first n changes. Back up song_ranges first (copy it to a
// song_ranges_bak_<ticket> table and check the row counts match): a row's old range is not kept anywhere else. A restore
// of the whole table also undoes any write made after the backup (the octave fix, the USDB sync), so keep the output of
// the write run: its `wrote <key>` lines are exactly the keys it wrote (a row that changed after it was read is skipped
// and not listed), and a rollback restores only those.
// The new low and high stay in the stored octave (`histogramOffOctave` counts the rows where that took a shift: 0 on
// production). A later `scripts/octave-fix.ts --dry-run` finds no move this run added, since it reads only a song's typical
// note, which this never writes. It can find fewer: it also refuses a move that would take a range past PLAUSIBLE_SONG,
// which a widened range can reach. Compare its moves before and after this run; do not expect a count of 0.

import { parseArgs } from 'node:util';
import { midiToNoteName } from '../src/lib/audio/notes';
import { readOnlyStore } from '../src/lib/report/readOnlyStore';
import { neonQuery } from '../src/lib/server/getStore';
import { createPostgresStore } from '../src/lib/server/postgresStore';
import { fixNarrowRanges } from '../src/lib/songs/narrow';
import { NARROW_SPAN } from '../src/lib/songs/range';

async function main() {
  const { values } = parseArgs({
    options: { 'dry-run': { type: 'boolean' }, after: { type: 'string' }, show: { type: 'string', multiple: true }, sample: { type: 'string' } },
  });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const dryRun = values['dry-run'] === true;
  const show = new Set(values.show ?? []);
  const sample = Number(values.sample ?? 0);
  if (!Number.isInteger(sample) || sample < 0) throw new Error(`--sample takes a whole number, not "${values.sample}"`);

  const store = createPostgresStore(neonQuery(url), { autoMigrate: false });
  const target = new URL(url);
  console.log(`${dryRun ? 'Dry run (nothing is written)' : 'Writing'} on database ${target.pathname.slice(1)} at ${target.hostname}, from ${values.after ? `after ${values.after}` : 'the start'}`);
  let sampled = 0;
  // How wide the widened note files come out, so a range the 1% trim stretched far past its song shows up here.
  const widenedSpans = new Map<number, number>();
  let highToLow = 0;
  const summary = await fixNarrowRanges(dryRun ? readOnlyStore(store) : store, {
    dryRun,
    after: values.after,
    onChange: (key, before, after) => {
      const span = after.high - after.low;
      if (before.source === 'note-file' && span > NARROW_SPAN) widenedSpans.set(span, (widenedSpans.get(span) ?? 0) + 1);
      if (before.confidence === 'high' && after.confidence === 'low') highToLow++;
      if (!show.has(key) && sampled >= sample) return;
      if (!show.has(key)) sampled++;
      const name = (r: { low: number; high: number }) => `${midiToNoteName(r.low)}-${midiToNoteName(r.high)} (${r.high - r.low} semitones)`;
      console.log(`change ${key}: ${before.source} ${name(before)}, ${before.confidence} -> ${name(after)}, ${after.confidence}`);
    },
    onWrite: (key) => console.log(`wrote ${key}`),
    onPage: (lastKey, s) => console.log(`page done, last key ${JSON.stringify(lastKey)}: checked ${s.checked}, narrow ${s.narrow}, ${dryRun ? 'would change' : 'changed'} ${s.changed}`),
  });
  const spans = [...widenedSpans].sort((a, b) => a[0] - b[0]).map(([span, n]) => `${span}: ${n}`).join(', ');
  console.log(`Widened note files by their new span in semitones: ${spans || 'none'}`);
  console.log(`${highToLow} ${dryRun ? 'would be' : 'were'} newly marked low confidence`);
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
