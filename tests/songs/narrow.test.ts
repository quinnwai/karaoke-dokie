import { describe, expect, it } from 'vitest';
import type { DataSourceLogEntry, SongRange } from '../../src/lib/contracts';
import { readOnlyStore } from '../../src/lib/report/readOnlyStore';
import type { Store } from '../../src/lib/server/store';
import { fixNarrowRanges } from '../../src/lib/songs/narrow';
import { fixStoredOctaves, shiftRange, type OctaveEvidence } from '../../src/lib/songs/octave';
import { trimmedRange } from '../../src/lib/songs/range';
import { STORES } from '../helpers/stores';

const log: DataSourceLogEntry = { trackId: '', title: 't', artist: 'a', outcome: 'note-file', reason: 'Used the UltraStar note file for this song.', at: '2026-01-01T00:00:00.000Z' };
const noteFile = (pitchShare: [number, number][], extra: Partial<SongRange> = {}): SongRange => {
  const { low, high } = trimmedRange(pitchShare.map(([midi, length]) => ({ midi, length })));
  const total = pitchShare.reduce((sum, [, share]) => sum + share, 0);
  const tessitura = pitchShare.reduce((sum, [midi, share]) => sum + midi * share, 0) / total;
  return { low, high, tessitura, source: 'note-file', confidence: 'high', fastLyrics: false, pitchShare, ...extra };
};
// 56 to 58 with the 5% trim, 52 to 61 with the 1% trim.
const STRAY: [number, number][] = [[52, 0.015], [55, 0.03], [56, 0.5], [57, 0.4], [58, 0.03], [61, 0.025]];
const part = { low: 56, high: 58, tessitura: 57, fastLyrics: false };
const RECORDING = { source: 'audio-full', method: 'pyin-v1/app-range-v1' } as const;
const WALLOWS: SongRange = {
  low: 55,
  high: 57,
  tessitura: 56.130472103004294,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
  octaveFrom: 'recording',
  pitchShare: [[48, 0.009], [54, 0.012], [55, 0.058], [56, 0.688], [57, 0.198], [58, 0.022], [59, 0.013]],
};

/** Stored as the import left them (the keys are in the order the store pages them). */
const STORED: Record<string, SongRange> = {
  'a|widens': noteFile(STRAY),
  'b|moved and widens': { ...shiftRange(noteFile(STRAY), -12), octaveFrom: 'recording' },
  'c|still narrow': noteFile([[56, 0.9], [57, 0.1]]),
  'd|wide': noteFile([[50, 0.5], [60, 0.5]]),
  'e|duet': noteFile(STRAY, { duet: true, parts: [part, part] }),
  'f|recording': noteFile(STRAY, RECORDING),
  'g|recording already low': noteFile(STRAY, { ...RECORDING, confidence: 'low' }),
  'h|estimate': noteFile(STRAY, { source: 'artist-typical', confidence: 'low' }),
  'wallows|are you bored yet?': WALLOWS,
};

const keysOf = Object.keys(STORED);
async function fill(store: Store) {
  for (const [key, range] of Object.entries(STORED)) await store.putSongRange(key, { range, log });
  await store.putSongRange('z|skipped', { range: null, log: { ...log, outcome: 'skipped' } });
}
const rangeOf = async (store: Store, key: string) => (await store.getSongRange(key))!.range!;
const snapshot = async (store: Store) => JSON.stringify(await Promise.all([...keysOf, 'z|skipped'].map((k) => store.getSongRange(k))));

describe.each(STORES)('fixNarrowRanges (%s store)', (_name, make) => {
  const counts = { checked: 9, narrow: 6, widened: 2, stillNarrow: 2, recordings: 2, noHistogram: 0, implausible: 0, stray: 0, histogramOffOctave: 0, changed: 5, skippedChanged: 0 };

  it('counts what it would change on a dry run, and writes nothing', async () => {
    const store = make();
    await fill(store);
    const before = await snapshot(store);
    const changes: string[] = [];
    const noWrite = () => {
      throw new Error('wrote on a dry run');
    };
    expect(await fixNarrowRanges(readOnlyStore(store), { dryRun: true, onChange: (key) => changes.push(key), onWrite: noWrite })).toEqual(counts);
    expect(changes).toEqual(['a|widens', 'b|moved and widens', 'c|still narrow', 'f|recording', 'wallows|are you bored yet?']);
    expect(await snapshot(store)).toBe(before);
    // Dry run is also respected by a store that would write.
    await fixNarrowRanges(store, { dryRun: true, onWrite: noWrite });
    expect(await snapshot(store)).toBe(before);
  });

  it('widens note files, marks what is still narrow and the recordings, and leaves duets, estimates and wide ranges alone', async () => {
    const store = make();
    await fill(store);
    expect(await fixNarrowRanges(store)).toEqual(counts);

    expect(await rangeOf(store, 'a|widens')).toEqual({ ...STORED['a|widens'], low: 52, high: 61 });
    // A range the octave fix moved stays in that octave, and keeps `octaveFrom`.
    expect(await rangeOf(store, 'b|moved and widens')).toEqual({ ...STORED['b|moved and widens'], low: 40, high: 49 });
    expect(await rangeOf(store, 'c|still narrow')).toEqual({ ...STORED['c|still narrow'], confidence: 'low' });
    expect(await rangeOf(store, 'wallows|are you bored yet?')).toEqual({ ...WALLOWS, low: 54, high: 59, confidence: 'low' });
    expect(await rangeOf(store, 'f|recording')).toEqual({ ...STORED['f|recording'], confidence: 'low' });
    for (const key of ['d|wide', 'e|duet', 'g|recording already low', 'h|estimate']) expect(await rangeOf(store, key)).toEqual(STORED[key]);
    // Only the range changes: every log line is as it was, and the skipped song is still skipped.
    for (const key of keysOf) expect((await store.getSongRange(key))!.log).toEqual(log);
    expect((await store.getSongRange('z|skipped'))!.range).toBeNull();
  });

  it('is idempotent: a second run changes 0 rows', async () => {
    const store = make();
    await fill(store);
    await fixNarrowRanges(store);
    const written = await snapshot(store);
    // Widened rows are wider than 5 semitones now; the narrow ones are as the rule leaves them.
    expect(await fixNarrowRanges(store)).toEqual({ ...counts, narrow: 4, widened: 0, changed: 0 });
    expect(await snapshot(store)).toBe(written);
  });

  it('puts every changed range around its song’s typical note, which is what would show a range left an octave away', async () => {
    const store = make();
    await fill(store);
    await fixNarrowRanges(store);
    for (const key of ['a|widens', 'b|moved and widens', 'c|still narrow', 'wallows|are you bored yet?']) {
      const r = await rangeOf(store, key);
      expect(r.low).toBeLessThanOrEqual(r.tessitura);
      expect(r.high).toBeGreaterThanOrEqual(r.tessitura);
    }
  });

  it('leaves the typical note alone, so the octave fix finds the same moves after it as before', async () => {
    const store = make();
    await fill(store);
    // The octave fix reads the typical note, so apart from the bounds check (the next test) it cannot see the range: it says the
    // same before and after. A song that still has a move to make (here a note file the evidence puts an octave lower) makes the count above 0 in both.
    const evidence: OctaveEvidence = {
      songs: { 'b|moved and widens': STORED['b|moved and widens']!.tessitura, 'wallows|are you bored yet?': WALLOWS.tessitura, 'a|widens': STORED['a|widens']!.tessitura - 12 },
      artists: {},
    };
    const moves = async () => (await fixStoredOctaves(readOnlyStore(store), evidence, { dryRun: true })).moved;
    expect(await moves()).toBe(1);
    await fixNarrowRanges(store);
    expect(await moves()).toBe(1);
    // ...and it moves the widened range along with the typical note, whole.
    await fixStoredOctaves(store, evidence);
    expect(await rangeOf(store, 'a|widens')).toMatchObject({ low: 52 - 12, high: 61 - 12 });
    expect(await moves()).toBe(0);
  });

  it('counts a histogram left in the note file’s octave, and puts the new range in the stored octave', async () => {
    const store = make();
    const file = noteFile(STRAY);
    const left = { ...shiftRange(file, -12), pitchShare: file.pitchShare, octaveFrom: 'recording' as const };
    await store.putSongRange('a|histogram left', { range: left, log });
    expect(await fixNarrowRanges(store)).toMatchObject({ narrow: 1, widened: 1, histogramOffOctave: 1, changed: 1 });
    expect(await rangeOf(store, 'a|histogram left')).toEqual({ ...left, low: 52 - 12, high: 61 - 12 });
  });

  it('starts after the key a stopped run printed', async () => {
    const store = make();
    await fill(store);
    const pages: string[] = [];
    const summary = await fixNarrowRanges(store, { after: 'c|still narrow', pageSize: 2, onPage: (last) => pages.push(last) });
    // After 'c|still narrow': the wide song, the duet, both recordings, the estimate and Wallows.
    expect(summary).toMatchObject({ checked: 6, narrow: 3, changed: 2 });
    expect(pages.at(-1)).toBe('wallows|are you bored yet?');
    expect(await rangeOf(store, 'a|widens')).toEqual(STORED['a|widens']);
    expect(await rangeOf(store, 'f|recording')).toMatchObject({ confidence: 'low' });
  });

  it('leaves a row alone that changed after it was read, and the next run picks it up', async () => {
    const store = make();
    await fill(store);
    const concurrent = { ...STORED['a|widens']!, usdbViews: 123 };
    let read = false;
    const racing: Store = {
      ...store,
      listSongRangesPage: async (after, limit) => {
        const page = await store.listSongRangesPage(after, limit);
        if (!read) {
          read = true;
          await store.putSongRange('a|widens', { range: concurrent, log });
        }
        return page;
      },
    };
    const wrote: string[] = [];
    expect(await fixNarrowRanges(racing, { onWrite: (key) => wrote.push(key) })).toMatchObject({ changed: 5, skippedChanged: 1 });
    // The key list for a rollback is the rows written, not the rows that changed: the skipped one is not in it.
    expect([...wrote].sort()).toEqual(['b|moved and widens', 'c|still narrow', 'f|recording', 'wallows|are you bored yet?']);
    expect(await rangeOf(store, 'a|widens')).toEqual(concurrent);
    expect(await fixNarrowRanges(store)).toMatchObject({ changed: 1, skippedChanged: 0 });
    expect(await rangeOf(store, 'a|widens')).toEqual({ ...concurrent, low: 52, high: 61 });
  });

  it('keeps the range of a note file with junk notes in it, and only marks it', async () => {
    const store = make();
    // 1.5% of the time on a pitch no song has (production has one that reaches G17): the 1% trim would stretch it to 44 semitones.
    const junk = noteFile([[56, 0.5], [57, 0.485], [100, 0.015]]);
    await store.putSongRange('a|junk notes', { range: junk, log });
    expect(await fixNarrowRanges(store)).toMatchObject({ narrow: 1, stillNarrow: 1, widened: 0, noHistogram: 0, implausible: 1, stray: 0, changed: 1 });
    expect(await rangeOf(store, 'a|junk notes')).toEqual({ ...junk, confidence: 'low' });
    expect(await fixNarrowRanges(store)).toMatchObject({ implausible: 1, changed: 0 });
  });

  it('keeps the range of a note file with a stray note in it, and only marks it (Pretty Maids All in a Row)', async () => {
    const store = make();
    // 2.1% of the time on D#2, 16 semitones below every other note: the 1% trim would make a Hard song of it, from what is probably a typo.
    const eagles = noteFile([[39, 0.021], [55, 0.766], [56, 0.115], [58, 0.098]]);
    expect(eagles).toMatchObject({ low: 55, high: 58 });
    await store.putSongRange('eagles|pretty maids all in a row', { range: eagles, log });
    // The junk-note guard looks first, so a range that fails both is counted once, as implausible.
    const junk = noteFile([[56, 0.5], [57, 0.485], [100, 0.015]]);
    await store.putSongRange('a|junk notes', { range: junk, log });
    expect(await fixNarrowRanges(store)).toMatchObject({ narrow: 2, stillNarrow: 2, widened: 0, noHistogram: 0, implausible: 1, stray: 1, changed: 2 });
    expect(await rangeOf(store, 'eagles|pretty maids all in a row')).toEqual({ ...eagles, confidence: 'low' });
    expect(await fixNarrowRanges(store)).toMatchObject({ implausible: 1, stray: 1, changed: 0 });
  });

  it('can block a pending octave move at the bounds of a plausible song, and never adds one', async () => {
    const store = make();
    // A high note file that the evidence puts an octave up: written 78 to 79 (+12 is 90 to 91, inside the bounds), it is widened to
    // 78 to 80, whose +12 is past the top bound, so octaveMove (which refuses a move out of bounds) now declines it.
    const high = noteFile([[78, 0.5], [79, 0.485], [80, 0.015]]);
    await store.putSongRange('a|high', { range: high, log });
    const evidence: OctaveEvidence = { songs: { 'a|high': high.tessitura + 12 }, artists: {} };
    const moves = async () => (await fixStoredOctaves(readOnlyStore(store), evidence, { dryRun: true })).moved;
    expect(await moves()).toBe(1);
    await fixNarrowRanges(store);
    expect(await rangeOf(store, 'a|high')).toMatchObject({ low: 78, high: 80, confidence: 'low' });
    expect(await moves()).toBe(0);
  });

  it('counts a narrow note file with no usable histogram, and can only mark it', async () => {
    const store = make();
    const { pitchShare: _, ...bare } = noteFile(STRAY);
    await store.putSongRange('a|no histogram', { range: bare, log });
    expect(await fixNarrowRanges(store)).toMatchObject({ narrow: 1, stillNarrow: 1, widened: 0, noHistogram: 1, changed: 1 });
    expect(await rangeOf(store, 'a|no histogram')).toEqual({ ...bare, confidence: 'low' });
  });
});
