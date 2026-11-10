import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataSourceLogEntry, SongRange, VocalRange } from '../../src/lib/contracts';
import { readOnlyStore } from '../../src/lib/report/readOnlyStore';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { matchSong } from '../../src/lib/songs/match';
import { trimmedRange } from '../../src/lib/songs/range';
import {
  ARTIST_MAX_DISTANCE,
  RAP_MAX_ARTIST_DISTANCE,
  RAP_MAX_RESIDUAL,
  TYPICAL_HIGH,
  buildOctaveEvidence,
  correctOctave,
  fixStoredOctaves,
  octaveLogNote,
  octaveMove,
  octaveToward,
  shiftRange,
  type OctaveEvidence,
  type OctavePair,
} from '../../src/lib/songs/octave';

const evidenceFile = JSON.parse(readFileSync(join(__dirname, '../../data/octave-evidence.json'), 'utf8')) as OctaveEvidence;
const user: VocalRange = { low: 41, high: 72, source: 'test' }; // F2 to C5
const log = (outcome: DataSourceLogEntry['outcome'] = 'note-file'): DataSourceLogEntry => ({ trackId: '', title: 't', artist: 'a', outcome, reason: 'Used the note file.', at: '2026-01-01' });
const noteFile = (low: number, high: number, tessitura: number, extra: Partial<SongRange> = {}): SongRange => ({
  low, high, tessitura, source: 'note-file', confidence: 'high', fastLyrics: false, ...extra,
});

describe('octaveToward', () => {
  it('picks the whole octave that puts the typical note nearest the target', () => {
    expect(octaveToward(71.15, 59.34)).toBe(-12);
    expect(octaveToward(59, 59.34)).toBe(0);
    expect(octaveToward(47, 59)).toBe(12);
    expect(octaveToward(65, 59)).toBe(-12); // 6 above: the lower octave is nearer or equal
    expect(octaveToward(53, 59)).toBe(0);
  });
});

describe('Easy by the Commodores (QWW-31)', () => {
  // The stored note file: 65 to 78, typical note 71.2: inside E2..C5 so range.ts left it, but a whole octave above the recording.
  const stored = noteFile(65, 78, 71.15, { pitchShare: [[65, 0.4], [72, 0.5], [78, 0.1]], collection: 'singmania' });

  it('is stored an octave too high, so F2 to C5 was told to sing it an octave lower', () => {
    expect(matchSong(user, stored)?.octave).toBe('down');
  });

  it('moves down an octave by its own recording, and then needs no octave shift', () => {
    const fixed = correctOctave('commodores|easy', stored, evidenceFile);
    expect(fixed).toMatchObject({ low: 53, high: 66, octaveFrom: 'recording' });
    expect(fixed.tessitura).toBeCloseTo(59.15, 5);
    expect(fixed.pitchShare).toEqual([[53, 0.4], [60, 0.5], [66, 0.1]]);
    expect(matchSong(user, fixed)?.octave).toBe('none');
  });
});

interface KnownCase {
  key: string;
  stored: Pick<SongRange, 'low' | 'high' | 'tessitura' | 'pitchShare'> & Partial<SongRange>;
  published: { low: number; high: number; source: string; url: string | null };
}
const known = (JSON.parse(readFileSync(join(__dirname, '../fixtures/octave-known-cases.json'), 'utf8')) as { songs: KnownCase[] }).songs;
const centre = (r: { low: number; high: number }) => (r.low + r.high) / 2;
const storedOf = (c: KnownCase): SongRange => noteFile(c.stored.low, c.stored.high, c.stored.tessitura, { pitchShare: c.stored.pitchShare });
const knownCase = (key: string): KnownCase => known.find((c) => c.key === key)!;
const d25: VocalRange = { low: 39, high: 74, source: 'test' }; // D#2 to D5, the range Quinn-Wai tested with on 10 Nov

describe('known cases, checked by hand against a published range (QWW-31)', () => {
  it('has Easy, Are You With Me and Talk Dirty among them', () => {
    expect(known.map((c) => c.key)).toEqual(expect.arrayContaining(['commodores|easy', 'lost frequencies|are you with me', 'jason derulo|talk dirty']));
  });

  it.each(known.map((c) => [c.key, c] as const))('%s: stored an octave off, in the published octave once fixed', (_key, c) => {
    const stored = storedOf(c);
    const fixed = correctOctave(c.key, stored, evidenceFile);
    // The octave is what is compared, not the ends: a published range is not trimmed the way ours is.
    expect(Math.abs(centre(stored) - centre(c.published)), 'stored as imported').toBeGreaterThan(6);
    expect(Math.abs(centre(fixed) - centre(c.published)), 'after the fix').toBeLessThanOrEqual(6);
    expect(fixed.octaveFrom).toBeDefined();
    // The bug the testers saw: F2 to C5 sings every one of these as the artist does, but was told 8vb.
    expect(matchSong(user, stored)?.octave).toBe('down');
    expect(matchSong(user, fixed)?.octave).toBe('none');
  });

  it('leaves them as they are once fixed (idempotent)', () => {
    for (const c of known) {
      const fixed = correctOctave(c.key, storedOf(c), evidenceFile);
      expect(correctOctave(c.key, fixed, evidenceFile), c.key).toBe(fixed);
    }
  });

  it('Are You With Me has no recording and no artist evidence: the pitch rule moves it, and D#2 to D5 finds it Easy, not Hard', () => {
    const c = knownCase('lost frequencies|are you with me');
    expect(Object.hasOwn(evidenceFile.songs, c.key)).toBe(false);
    expect(Object.hasOwn(evidenceFile.artists, 'lost frequencies')).toBe(false);
    const stored = storedOf(c);
    expect(stored.tessitura).toBeGreaterThanOrEqual(TYPICAL_HIGH);
    const fixed = correctOctave(c.key, stored, evidenceFile);
    expect(fixed).toMatchObject({ low: 55, high: 61, octaveFrom: 'pitch' });
    expect(matchSong(d25, stored)).toMatchObject({ octave: 'none', difficulty: 'hard' }); // Quinn-Wai's screenshot
    expect(matchSong(d25, fixed)).toMatchObject({ octave: 'none', difficulty: 'easy' }); // Singing Carrots: Easy
  });

  it('Are You With Me’s low end is the 5% trim, not a second error: its notes reach D#4, as the published D#3 an octave up', () => {
    const c = knownCase('lost frequencies|are you with me');
    const lowest = c.stored.pitchShare![0]![0];
    expect(lowest).toBe(c.published.low + 12); // D#4: the same low note as the published range, an octave up
    expect(c.stored.low).toBeGreaterThan(lowest); // the stored low skips the lowest notes
    // Those two lowest pitches (D#4 and F4) are exactly the 5% of sung time the range leaves out at each end.
    const notes = c.stored.pitchShare!.map(([midi, share]) => ({ midi, length: share }));
    expect(trimmedRange(notes).low).toBe(c.stored.low);
    expect(trimmedRange(notes, 0.03).low).toBe(lowest);
  });

  it('Talk Dirty’s own recording is flagged mostly-rap and was dropped; it agrees with the note file an octave down, so it is evidence now', () => {
    const c = knownCase('jason derulo|talk dirty');
    expect(evidenceFile.songs[c.key]).toBeCloseTo(59.92, 2);
    expect(evidenceFile.artists['jason derulo']).toBeCloseTo(63.65, 2); // the artist alone would not have moved it: 4.35 past ARTIST_MAX_DISTANCE
    const stored = storedOf(c);
    expect(octaveMove(c.key, stored, evidenceFile)).toEqual({ semitones: -12, from: 'recording' });
    expect(Math.abs(stored.tessitura - 12 - evidenceFile.artists['jason derulo']!)).toBeGreaterThan(ARTIST_MAX_DISTANCE);
    expect(octaveMove(c.key, stored, { songs: {}, artists: evidenceFile.artists })).toBeNull();
  });
});

describe('octaveMove', () => {
  const ev: OctaveEvidence = { songs: { 'a|song': 60, 'a|high-but-right': 70 }, artists: { a: 60, b: 60, low: 50, mid: 62, hi: 68 } };

  it('moves by the song’s own recording at any distance, and leaves a note file already right', () => {
    expect(octaveMove('a|song', noteFile(70, 80, 76), ev)).toEqual({ semitones: -12, from: 'recording' });
    expect(octaveMove('a|song', noteFile(50, 62, 45), ev)).toEqual({ semitones: 12, from: 'recording' });
    expect(octaveMove('a|song', noteFile(55, 68, 62), ev)).toBeNull();
  });

  it('uses the artist’s other recordings only with margin to spare', () => {
    const near = 50 + 12 + ARTIST_MAX_DISTANCE; // 66: moved down an octave it lands ARTIST_MAX_DISTANCE above the artist (median 50)
    expect(octaveMove('low|other', noteFile(60, 72, near), ev)).toEqual({ semitones: -12, from: 'artist' });
    // 5 above the artist's typical note once moved: not strong enough
    expect(octaveMove('low|other', noteFile(60, 72, near + 1), ev)).toBeNull();
  });

  it('never lets the pitch rule override an artist who has evidence, whichever way the evidence leans', () => {
    // Artist at 62, note file at 69.5: moved down it lands 4.5 above the artist, which is not enough, and 69.5 is high enough for the pitch rule. Left as written.
    expect(octaveMove('mid|other', noteFile(64, 76, 69.5), ev)).toBeNull();
    // Artist at 68: a typical note of 70 as written is the nearest octave, so a high note file stays (a soprano, ABBA).
    expect(octaveMove('hi|other', noteFile(64, 76, 70), ev)).toBeNull();
  });

  it('moves a note file with no evidence down an octave from TYPICAL_HIGH, and leaves lower ones (Are You With Me)', () => {
    expect(octaveMove('c|other', noteFile(63, 73, TYPICAL_HIGH), ev)).toEqual({ semitones: -12, from: 'pitch' });
    expect(octaveMove('c|other', noteFile(63, 73, 71.9), ev)).toEqual({ semitones: -12, from: 'pitch' });
    expect(octaveMove('c|other', noteFile(63, 73, TYPICAL_HIGH - 0.1), ev)).toBeNull();
    expect(octaveMove('c|other', noteFile(63, 73, 70), ev, Infinity)).toBeNull(); // the rule can be switched off
  });

  it('moves a note file far above the line until it is below it, so a second run moves nothing', () => {
    const once = correctOctave('c|other', noteFile(75, 90, 82), ev);
    expect(once).toMatchObject({ low: 51, high: 66, octaveFrom: 'pitch' });
    expect(once.tessitura).toBeLessThan(TYPICAL_HIGH);
    expect(correctOctave('c|other', once, ev)).toBe(once);
  });

  it('lets the song’s own recording beat the pitch rule, both ways', () => {
    expect(octaveMove('a|high-but-right', noteFile(64, 76, 70), ev)).toBeNull(); // recording at 70: right as written
    expect(octaveMove('a|song', noteFile(64, 76, 70), ev)).toEqual({ semitones: -12, from: 'recording' });
  });

  it('leaves estimates, recordings, duets with parts, and moves that leave the plausible range alone', () => {
    const part = { low: 60, high: 70, tessitura: 65, fastLyrics: false };
    expect(octaveMove('a|song', { ...noteFile(70, 80, 76), source: 'audio-full' }, ev)).toBeNull();
    expect(octaveMove('a|song', { ...noteFile(70, 80, 76), source: 'artist-typical' }, ev)).toBeNull();
    expect(octaveMove('a|song', noteFile(70, 80, 76, { duet: true, parts: [part, part] }), ev)).toBeNull();
    expect(octaveMove('a|song', noteFile(70, 80, 76, { duet: true }), ev)).toBeNull(); // a duet stored without its parts
    expect(octaveMove('a|song', noteFile(60, 85, 70), { songs: { 'a|song': 82 }, artists: {} })).toBeNull(); // 85 + 12 is past the plausible top
  });

  it('does not move a range already corrected (idempotent)', () => {
    const once = correctOctave('a|song', noteFile(70, 80, 76), ev);
    expect(correctOctave('a|song', once, ev)).toBe(once);
  });
});

describe('the shipped evidence', () => {
  const songs = Object.entries(evidenceFile.songs);

  it('covers thousands of songs and artists, with sane typical notes', () => {
    expect(songs.length).toBeGreaterThan(4000);
    expect(Object.keys(evidenceFile.artists).length).toBeGreaterThan(1000);
    for (const [, tess] of [...songs, ...Object.entries(evidenceFile.artists)]) expect(tess).toBeGreaterThan(36);
  });

  it('leaves note files that are already in the recording’s octave exactly as they are', () => {
    // A note file within a few semitones of its recording's typical note is right, wherever it sits.
    for (const [key, tess] of songs) {
      for (const off of [-4, 0, 3]) {
        const range = noteFile(Math.round(tess + off) - 5, Math.round(tess + off) + 6, tess + off);
        expect(octaveMove(key, range, evidenceFile), `${key} at ${off}`).toBeNull();
      }
    }
  });

  it('moves a note file written an octave off back, in both directions', () => {
    for (const [key, tess] of songs.slice(0, 200)) {
      const high = noteFile(Math.round(tess) + 7, Math.round(tess) + 18, tess + 12.5);
      const low = noteFile(Math.round(tess) - 17, Math.round(tess) - 6, tess - 11.5);
      expect(octaveMove(key, high, evidenceFile)?.semitones, key).toBe(-12);
      expect(octaveMove(key, low, evidenceFile)?.semitones, key).toBe(12);
    }
  });
});

describe('buildOctaveEvidence', () => {
  const pair = (artist: string, title: string, recording: number, noteAsStored: number, extra: Partial<OctavePair> = {}): OctavePair => ({
    artist, title, recording, noteAsStored, rap: false, duet: false, multi: false, ...extra,
  });

  it('keys songs the way the app does, and takes each artist’s median from their solo, non-rap recordings', () => {
    const e = buildOctaveEvidence([
      pair('Ann', 'One', 60, 60),
      pair('Ann', 'Two (Live) - Remastered', 64, 64),
      pair('Ann', 'Three', 70, 70),
      pair('Ann featuring Bo', 'Collab', 50, 50, { multi: true }),
      pair('Ann', 'Duet', 40, 40, { duet: true }),
    ]);
    expect(e.songs).toMatchObject({ 'ann|one': 60, 'ann|two': 64, 'ann|three': 70, 'ann|collab': 50, 'ann|duet': 40 });
    expect(e.artists).toEqual({ ann: 64 }); // median of 60, 64, 70: the collaboration and the duet do not count
  });

  it('drops a mostly-rap recording unless it agrees with the note file at a whole octave (Talk Dirty)', () => {
    const e = buildOctaveEvidence([
      pair('Jason Derulo featuring 2 Chainz', 'Talk Dirty', 59.92, 71.3, { rap: true, multi: true }), // 0.62 off once moved down: kept
      pair('Rapper', 'Spoken', 52, 61, { rap: true }), // 49 vs 52: exactly RAP_MAX_RESIDUAL off: kept
      pair('Rapper', 'Garbled', 50, 57, { rap: true }), // 45 vs 50: 5 off at the nearest octave: dropped
    ]);
    expect(RAP_MAX_RESIDUAL).toBe(3);
    expect(e.songs).toEqual({ 'jason derulo|talk dirty': 59.92, 'rapper|spoken': 52 });
    // A rap recording never feeds an artist's median.
    expect(e.artists).toEqual({});
  });

  it('does not let a mostly-rap recording contradict the artist’s other recordings, or move a note file more than an octave', () => {
    const solo = [pair('Ann', 'One', 64, 64), pair('Ann', 'Two', 63, 63), pair('Ann', 'Three', 65, 65)]; // median 64
    const e = buildOctaveEvidence([
      ...solo,
      pair('Ann', 'Agrees', 58, 70, { rap: true }), // 6 from the artist: kept
      pair('Ann', 'Contradicts', 50, 62, { rap: true }), // fits its note file at -12, but 14 from the artist: dropped
      pair('Bo', 'Two Octaves', 46, 70, { rap: true }), // residual 0 at -24, but a rap recording moves one octave at most: dropped
    ]);
    expect(RAP_MAX_ARTIST_DISTANCE).toBe(6);
    expect(Object.keys(e.songs).sort()).toEqual(['ann|agrees', 'ann|one', 'ann|three', 'ann|two']);
    expect(e.artists).toEqual({ ann: 64 });
  });

  it('keeps a recording that is not mostly rap over a mostly-rap one of the same song, in either order', () => {
    const trusted = pair('A', 'S', 60, 60);
    const rap = pair('A', 'S (Live)', 62, 60, { rap: true }); // the same song key; on its own it passes every rap rule
    expect(buildOctaveEvidence([rap]).songs).toEqual({ 'a|s': 62 });
    expect(buildOctaveEvidence([trusted, rap]).songs).toEqual({ 'a|s': 60 });
    expect(buildOctaveEvidence([rap, trusted]).songs).toEqual({ 'a|s': 60 });
  });

  it('refuses a pairs file without both typical notes, rather than trusting what it cannot check', () => {
    const stale = { artist: 'A', title: 'S', recording: 30, rap: true, duet: false, multi: false } as unknown as OctavePair;
    expect(() => buildOctaveEvidence([stale])).toThrow(/octave-pairs\.py/);
  });
});

describe('octaveLogNote', () => {
  it('says what the move was based on', () => {
    expect(octaveLogNote({ semitones: -12, from: 'recording' })).toBe('Moved an octave down to match the original recording.');
    expect(octaveLogNote({ semitones: 12, from: 'artist' })).toBe('Moved an octave up to match the register of the artist\'s other recordings.');
    expect(octaveLogNote({ semitones: -24, from: 'pitch' })).toBe('Moved 2 octaves down: note files written this high are usually an octave too high.');
  });
});

describe('shiftRange', () => {
  it('moves low, high, typical note and pitch shares, and nothing else', () => {
    const r = noteFile(60, 70, 65, { pitchShare: [[60, 0.5], [70, 0.5]], usdbId: 7 });
    expect(shiftRange(r, -12)).toEqual({ ...r, low: 48, high: 58, tessitura: 53, pitchShare: [[48, 0.5], [58, 0.5]] });
  });
});

describe('fixStoredOctaves', () => {
  const ev: OctaveEvidence = { songs: { 'a|high': 60 }, artists: { a: 60 } };

  async function seeded() {
    const s = createMemoryStore();
    await s.putSongRange('a|high', { range: noteFile(65, 78, 72 - 0.5), log: log() });
    await s.putSongRange('a|artist-only', { range: noteFile(68, 80, 75), log: log() }); // 63 once moved: 3 from the artist at 60
    await s.putSongRange('a|right', { range: noteFile(55, 68, 61), log: log() });
    await s.putSongRange('a|duet', { range: noteFile(65, 78, 71, { duet: true, parts: [{ low: 65, high: 78, tessitura: 71, fastLyrics: false }] }), log: log() });
    await s.putSongRange('a|estimate', { range: { ...noteFile(65, 78, 71), source: 'artist-typical', confidence: 'low' }, log: log('artist-typical') });
    await s.putSongRange('y|no-evidence-high', { range: noteFile(63, 73, 69.9), log: log() }); // an artist the evidence does not name
    await s.putSongRange('z|no-evidence-lower', { range: noteFile(60, 70, 66), log: log() });
    await s.putSongRange('z|skipped', { range: null, log: log('skipped') });
    return s;
  }

  it('fixes the plain note files the evidence or the pitch rule moves, notes why, and is a no-op the second time', async () => {
    const s = await seeded();
    const first = await fixStoredOctaves(s, ev);
    expect(first).toEqual({ checked: 7, moved: 3, fromRecording: 1, fromArtist: 1, fromPitch: 1, skippedChanged: 0 });
    const fixed = await s.getSongRange('a|high');
    expect(fixed?.range).toMatchObject({ low: 53, high: 66, octaveFrom: 'recording' });
    expect(fixed?.log.reason).toBe('Used the note file. Moved an octave down to match the original recording.');
    expect((await s.getSongRange('a|artist-only'))?.range).toMatchObject({ low: 56, high: 68, octaveFrom: 'artist' });
    const byPitch = await s.getSongRange('y|no-evidence-high');
    expect(byPitch?.range).toMatchObject({ low: 51, high: 61, octaveFrom: 'pitch' });
    expect(byPitch?.range?.tessitura).toBeCloseTo(57.9, 5);
    expect(byPitch?.log.reason).toBe('Used the note file. Moved an octave down: note files written this high are usually an octave too high.');
    expect((await s.getSongRange('a|right'))?.range).toMatchObject({ low: 55, high: 68 });
    expect((await s.getSongRange('a|duet'))?.range).toMatchObject({ low: 65 });
    expect((await s.getSongRange('a|estimate'))?.range).toMatchObject({ low: 65 });
    expect((await s.getSongRange('z|no-evidence-lower'))?.range).toMatchObject({ low: 60 });
    expect(await fixStoredOctaves(s, ev)).toMatchObject({ moved: 0 });
  });

  it('writes nothing on a dry run, and reports each move', async () => {
    const s = await seeded();
    const moves: string[] = [];
    expect(await fixStoredOctaves(s, ev, { dryRun: true, onMove: (key, move) => moves.push(`${key} ${move.from} ${move.semitones}`) })).toMatchObject({ moved: 3 });
    expect(moves).toEqual(['a|artist-only artist -12', 'a|high recording -12', 'y|no-evidence-high pitch -12']);
    expect((await s.getSongRange('a|high'))?.range).toMatchObject({ low: 65 });
    expect((await s.getSongRange('y|no-evidence-high'))?.range).toMatchObject({ low: 63 });
  });

  it('is a read-only dry run through readOnlyStore, which is how the script opens the store for one', async () => {
    const s = await seeded();
    expect(await fixStoredOctaves(readOnlyStore(s), ev, { dryRun: true })).toMatchObject({ checked: 7, moved: 3 });
    expect((await s.getSongRange('a|high'))?.range).toMatchObject({ low: 65 });
  });

  it('gives the same result in small pages, writes every page’s moves, reports each page’s last key, and resumes after a key', async () => {
    const pages: [string, number][] = [];
    const s = await seeded();
    const summary = await fixStoredOctaves(s, ev, { pageSize: 2, onPage: (lastKey, sofar) => pages.push([lastKey, sofar.checked]) });
    expect(summary).toEqual({ checked: 7, moved: 3, fromRecording: 1, fromArtist: 1, fromPitch: 1, skippedChanged: 0 });
    // Seven rows with a range, two per page; the skipped song is not read.
    expect(pages).toEqual([['a|duet', 2], ['a|high', 4], ['y|no-evidence-high', 6], ['z|no-evidence-lower', 7]]);
    // Moves on the first page and on a later one are both written.
    expect((await s.getSongRange('a|artist-only'))?.range).toMatchObject({ octaveFrom: 'artist' });
    expect((await s.getSongRange('a|high'))?.range).toMatchObject({ octaveFrom: 'recording' });
    expect((await s.getSongRange('y|no-evidence-high'))?.range).toMatchObject({ octaveFrom: 'pitch' });

    // A stopped run picks up after its last printed key: only what comes after is looked at.
    const resumed = await seeded();
    expect(await fixStoredOctaves(resumed, ev, { after: 'a|right' })).toMatchObject({ checked: 2, moved: 1, fromPitch: 1 });
    expect((await resumed.getSongRange('a|high'))?.range).toMatchObject({ low: 65 }); // before the cursor: left for the next full run
  });

  it('leaves a row alone that another writer changed after it was read, and fixes it on the next run', async () => {
    const real = await seeded();
    let changed = false;
    const racing = {
      ...real,
      // Someone re-imports a:high (new reason, new views) while the fix is deciding what to do with the page it just read.
      listSongRangesPage: async (after: string, limit: number) => {
        const page = await real.listSongRangesPage(after, limit);
        if (!changed) {
          changed = true;
          await real.putSongRange('a|high', { range: noteFile(65, 78, 71.5, { usdbViews: 999 }), log: { ...log(), reason: 'Re-imported.' } });
        }
        return page;
      },
    };
    const first = await fixStoredOctaves(racing, ev);
    expect(first).toMatchObject({ moved: 3, skippedChanged: 1 });
    expect((await real.getSongRange('a|high'))?.range).toMatchObject({ low: 65, usdbViews: 999 }); // the other writer's row, not ours
    expect((await real.getSongRange('a|high'))?.log.reason).toBe('Re-imported.');
    expect((await real.getSongRange('a|artist-only'))?.range).toMatchObject({ octaveFrom: 'artist' }); // the others were written
    expect(await fixStoredOctaves(real, ev)).toMatchObject({ moved: 1, fromRecording: 1, skippedChanged: 0 });
    expect((await real.getSongRange('a|high'))?.range).toMatchObject({ low: 53, usdbViews: 999, octaveFrom: 'recording' });
  });
});

describe('TYPICAL_HIGH', () => {
  // How often a note file was an octave too high, by typical note, over the songs that have a recording (octave-measure.ts).
  const { bins } = JSON.parse(readFileSync(join(__dirname, '../fixtures/octave-calibration.json'), 'utf8')) as { bins: Record<string, [number, number]> };
  const share = (from: number, to: number) => {
    const rows = Object.entries(bins).filter(([bin]) => Number(bin) >= from && Number(bin) < to);
    return rows.reduce((n, [, [, high]]) => n + high, 0) / rows.reduce((n, [, [songs]]) => n + songs, 0);
  };

  it('sits where most note files above it were an octave too high, and fewer than half the ones just below', () => {
    expect(share(Math.ceil(TYPICAL_HIGH), 100)).toBeGreaterThanOrEqual(0.8);
    expect(share(Math.floor(TYPICAL_HIGH) - 1, Math.floor(TYPICAL_HIGH))).toBeLessThan(0.5);
  });
});
