// Redoes the stored ranges the narrow-range rule changes (range.ts applyNarrowRule, QWW-60): a note file
// of 5 semitones or fewer is measured again with a 1% trim from its pitch histogram, what is still that narrow
// is marked low confidence, and so is a recording of 5 semitones or fewer. Duets with parts, artist estimates
// and every range wider than 5 semitones are left alone, and so is the range of a note file whose 1% trim would
// reach pitches no song has (junk notes in the file, one reaching G17): it is only marked low confidence.
//
// Safe to run again, and to stop and run again: a widened range is wider than 5 semitones and a marked one
// comes out the same from the same histogram, so a second run changes nothing. A row is read again just
// before it is written and left alone if someone else changed it meanwhile (`skippedChanged`; the next run
// picks it up), which leaves a gap of one batch, so still run it while nothing else writes song ranges.
//
// Octave: the stored histogram is in the octave of the stored range (the octave fix moves it along, see
// shiftRange in octave.ts), and applyNarrowRule keeps the new low and high in that octave, so a range the
// octave fix has moved does not move back (`scripts/octave-fix.ts --dry-run` still reports 0 moves).

import type { SongRange } from '../contracts';
import type { SongRangeRecord, Store } from '../server/store';
import { applyNarrowRule, gentleRange, isNarrow, isPlausible, NARROW_SPAN } from './range';

export interface NarrowFixSummary {
  /** Stored ranges read. */
  checked: number;
  /** Of those, the ranges the rule looks at: a note file or a recording of 5 semitones or fewer, and not a duet with parts. */
  narrow: number;
  /** Note files the 1% trim widened past 5 semitones: they keep their confidence. Once written they are wide, so a second run counts none. */
  widened: number;
  /** Note files still 5 semitones or fewer with the 1% trim (or with no usable histogram): marked low confidence. */
  stillNarrow: number;
  /** Recordings of 5 semitones or fewer: marked low confidence. */
  recordings: number;
  /** Of the note files in `narrow`, those with no histogram, or one that does not describe the song, so the rule could only mark them. */
  noHistogram: number;
  /** Of the note files in `narrow`, those whose 1% trim reaches pitches no song has (junk notes in the file): kept at their range and marked, never widened. */
  implausible: number;
  /** Rows the rule changes (on a dry run, would change): `narrow` less the rows that are already as the rule leaves them. */
  changed: number;
  /** Changes not written because the row changed after it was read; the next run picks them up. */
  skippedChanged: number;
}

export interface NarrowFixOptions {
  /** Count without writing. */
  dryRun?: boolean;
  /** Start after this song key: the last key a run printed before it stopped. */
  after?: string;
  /** Songs read per query. */
  pageSize?: number;
  /** Called for every song that changes (on a dry run, would change), with its range before and after. */
  onChange?: (key: string, before: SongRange, after: SongRange) => void;
  /** Called after every page with its last song key, to resume from, and the counts so far. */
  onPage?: (lastKey: string, summary: NarrowFixSummary) => void;
}

/** Rows written at once; each is its own request to the database. */
const WRITE_BATCH = 10;

/**
 * Applies the narrow-range rule to every stored range, reading the table in pages by song key. With `dryRun`,
 * counts without writing. The rest of the row (its log line included) is kept as it is.
 */
export async function fixNarrowRanges(store: Store, opts: NarrowFixOptions = {}): Promise<NarrowFixSummary> {
  const pageSize = opts.pageSize ?? 1000;
  const summary: NarrowFixSummary = { checked: 0, narrow: 0, widened: 0, stillNarrow: 0, recordings: 0, noHistogram: 0, implausible: 0, changed: 0, skippedChanged: 0 };
  const same = (a: SongRangeRecord, b: SongRangeRecord | undefined) => b !== undefined && JSON.stringify(a) === JSON.stringify(b);
  let after = opts.after ?? '';
  for (;;) {
    const page = await store.listSongRangesPage(after, pageSize);
    if (page.size === 0) return summary;
    const writes: { key: string; read: SongRangeRecord; next: SongRangeRecord }[] = [];
    for (const [key, rec] of page) {
      after = key;
      if (!rec.range) continue;
      summary.checked++;
      if (!isNarrow(rec.range)) continue;
      summary.narrow++;
      const range = applyNarrowRule(rec.range);
      if (rec.range.source === 'audio-full') {
        summary.recordings++;
      } else {
        const finer = gentleRange(rec.range);
        if (!finer) summary.noHistogram++;
        else if (!isPlausible(finer)) summary.implausible++;
        if (range.high - range.low > NARROW_SPAN) summary.widened++;
        else summary.stillNarrow++;
      }
      if (range === rec.range) continue;
      summary.changed++;
      opts.onChange?.(key, rec.range, range);
      if (opts.dryRun) continue;
      writes.push({ key, read: rec, next: { ...rec, range } });
    }
    for (let i = 0; i < writes.length; i += WRITE_BATCH) {
      const batch = writes.slice(i, i + WRITE_BATCH);
      const fresh = await store.getSongRanges(batch.map((w) => w.key));
      await Promise.all(
        batch.map(({ key, read, next }) => {
          if (same(read, fresh.get(key))) return store.putSongRange(key, next);
          summary.skippedChanged++;
          return undefined;
        }),
      );
    }
    opts.onPage?.(after, { ...summary });
  }
}
