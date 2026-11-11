import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { midiToNoteName } from '../../src/lib/audio/notes';
import type { DataSourceLogEntry, SongRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import {
  artistOfKey,
  correctOctave,
  fixStoredOctaves,
  octaveLogNote,
  octaveMove,
  shiftRange,
  withHandChecked,
  type OctaveEvidence,
  type OctaveHandChecked,
} from '../../src/lib/songs/octave';
import { loadOctaveEvidence } from '../../src/lib/songs/octaveFiles';
import { songKey } from '../../src/lib/songs/resolve';

// QWW-31, 11 Nov: Quinn-Wai heard AC/DC high (You Shook Me All Night Long at about G4 to C5, Hells Bells near C5), so
// the pitch rule, which moves a high note file with no artist evidence down an octave, was wrong for the band.
// tests/fixtures/octave-acdc.json holds every stored AC/DC range as read from production (as written) and from the
// preview after round 2.

const root = join(__dirname, '../..');
const paths = { evidence: join(root, 'data/octave-evidence.json'), hand: join(root, 'data/octave-hand-checked.json') };
const evidence = loadOctaveEvidence(paths);
const generated = JSON.parse(readFileSync(paths.evidence, 'utf8')) as OctaveEvidence; // what round 2 had: no AC/DC in it
const handFile = JSON.parse(readFileSync(paths.hand, 'utf8')) as OctaveHandChecked;

type Row = { low: number; high: number; tessitura: number; duet?: boolean; octaveFrom?: SongRange['octaveFrom'] };
const songs = (JSON.parse(readFileSync(join(__dirname, '../fixtures/octave-acdc.json'), 'utf8')) as { songs: { key: string; production: Row; preview: Row }[] }).songs;
const range = (r: Row): SongRange => ({
  low: r.low,
  high: r.high,
  tessitura: r.tessitura,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
  ...(r.duet ? { duet: true } : {}),
  ...(r.octaveFrom ? { octaveFrom: r.octaveFrom } : {}),
});
const song = (title: string) => songs.find((s) => s.key === `ac/dc|${title}`)!;
const titles = (keys: string[]) => keys.map((k) => k.split('|')[1]!).sort();
const notes = (r: { low: number; high: number }) => `${midiToNoteName(r.low)} to ${midiToNoteName(r.high)}`;
const log = (): DataSourceLogEntry => ({ trackId: '', title: 't', artist: 'AC/DC', outcome: 'note-file', reason: 'Used the note file.', at: '2026-11-11' });
async function seeded(state: 'production' | 'preview') {
  const store = createMemoryStore();
  for (const s of songs) await store.putSongRange(s.key, { range: range(s[state]), log: log() });
  return store;
}

const SHOULD_GO_BACK = [
  'anything goes', 'for those about to rock', 'gimme a bullet', 'have a drink on me', 'hell ain’t a bad place to be', 'moneytalks', 'rock or bust',
  'shoot to thrill', 'shot in the dark', 'sink the pink', 'thunderstruck', 'who made who', 'whole lotta rosie', 'you shook me all night long',
];
const SHOULD_MOVE_UP = ['back in black', 'big gun', 'fire your guns', 'hells bells', 'riff raff', 'rocker', 'stiff upper lip'];

describe('the hand-checked evidence file', () => {
  it('sets AC/DC at A#4 and keeps Let There Be Rock, each saying where it came from', () => {
    expect(handFile.artists['ac/dc']).toMatchObject({ typical: 70 });
    expect(handFile.artists['ac/dc']!.source).toMatch(/Quinn-Wai, by ear, 11 Nov/);
    expect(Object.keys(handFile.keep)).toEqual(['ac/dc|let there be rock']);
    for (const entry of [...Object.values(handFile.artists), ...Object.values(handFile.keep)]) expect(entry.source.length).toBeGreaterThan(20);
  });

  it('uses the keys the app uses', () => {
    expect(artistOfKey(songKey('AC/DC', 'Hells Bells'))).toBe('ac/dc');
    expect(songKey('AC/DC', 'Let There Be Rock')).toBe('ac/dc|let there be rock');
    expect(songs.every((s) => s.key === songKey('AC/DC', s.key.split('|')[1]!))).toBe(true);
  });

  it('is merged in at load, takes the place of a measured artist, and says which artists are hand-checked', () => {
    expect(evidence.artists['ac/dc']).toBe(70);
    expect(evidence.hand).toEqual({ artists: ['ac/dc'], keep: ['ac/dc|let there be rock'] });
    expect(Object.keys(evidence.songs)).toEqual(Object.keys(generated.songs)); // the generated songs are untouched
    const merged = withHandChecked({ songs: {}, artists: { a: 55, b: 60 } }, { artists: { a: { typical: 70, source: 'by ear' } }, keep: {} });
    expect(merged.artists).toEqual({ a: 70, b: 60 });
    expect(merged.hand).toEqual({ artists: ['a'], keep: [] });
  });

  it('refuses an entry that does not say where it came from', () => {
    const ev: OctaveEvidence = { songs: {}, artists: {} };
    expect(() => withHandChecked(ev, { artists: { a: { typical: 70, source: ' ' } }, keep: {} })).toThrow(/source/);
    expect(() => withHandChecked(ev, { artists: { a: { typical: NaN, source: 'by ear' } }, keep: {} })).toThrow(/typical note/);
    expect(() => withHandChecked(ev, { artists: {}, keep: { 'a|b': { source: '' } } })).toThrow(/source/);
  });

  it('leaves a song’s own recording above it', () => {
    const ev: OctaveEvidence = { songs: { 'ac/dc|x': 58 }, artists: { 'ac/dc': 70 }, hand: { artists: ['ac/dc'], keep: [] } };
    const stored = range({ low: 60, high: 72, tessitura: 70 });
    expect(octaveMove('ac/dc|x', stored, { ...ev, songs: {} })).toBeNull(); // the hand-checked artist alone: 70 is where the note file is
    expect(octaveMove('ac/dc|x', stored, ev)).toEqual({ semitones: -12, from: 'recording' }); // its own recording says an octave lower
  });
});

describe('AC/DC', () => {
  it('Hells Bells ends at A4 to E5', () => {
    const stored = range(song('hells bells').production);
    expect(notes(stored)).toBe('A3 to E4');
    const fixed = correctOctave('ac/dc|hells bells', stored, evidence);
    expect(notes(fixed)).toBe('A4 to E5');
    expect(fixed.octaveFrom).toBe('hand');
  });

  it('You Shook Me All Night Long stays at G4 to D5 as written, and goes back to it from its pitch-moved row', () => {
    const s = song('you shook me all night long');
    const asWritten = range(s.production);
    expect(notes(asWritten)).toBe('G4 to D5');
    expect(correctOctave(s.key, asWritten, evidence)).toBe(asWritten); // not moved at all
    const pitchMoved = range(s.preview);
    expect(notes(pitchMoved)).toBe('G3 to D4');
    expect(pitchMoved.octaveFrom).toBe('pitch');
    const back = correctOctave(s.key, pitchMoved, evidence);
    expect(notes(back)).toBe('G4 to D5');
    expect(back.octaveFrom).toBe('hand');
    // The reason it needed saying: without the hand-checked file the pitch rule takes the as-written row down.
    expect(octaveMove(s.key, asWritten, generated)).toEqual({ semitones: -12, from: 'pitch' });
  });

  it('Let There Be Rock does not move, though the artist rule alone would take it to C4 to E6', () => {
    const s = song('let there be rock');
    const stored = range(s.production);
    expect(notes(stored)).toBe('C3 to E5');
    expect(octaveMove(s.key, stored, evidence)).toBeNull();
    expect(range(s.preview)).toEqual(stored); // round 2 left it alone too
    const withoutKeep: OctaveEvidence = { ...evidence, hand: { artists: ['ac/dc'], keep: [] } };
    const move = octaveMove(s.key, stored, withoutKeep)!;
    expect(move).toEqual({ semitones: 12, from: 'hand' });
    expect(notes({ low: stored.low + move.semitones, high: stored.high + move.semitones })).toBe('C4 to E6');
  });

  it('on the preview data (round 2 applied), 14 songs go back up to as written and 7 move up an octave; the rest stay', () => {
    const back: string[] = [];
    const up: string[] = [];
    for (const s of songs) {
      const move = octaveMove(s.key, range(s.preview), evidence);
      if (!move) continue;
      expect(move, s.key).toEqual({ semitones: 12, from: 'hand' });
      if (s.preview.octaveFrom === 'pitch') {
        back.push(s.key);
        expect(notes(shiftRange(range(s.preview), 12)), s.key).toBe(notes(s.production)); // back where the note file had it
      } else {
        up.push(s.key);
      }
    }
    expect(titles(back)).toEqual([...SHOULD_GO_BACK].sort());
    expect(titles(up)).toEqual([...SHOULD_MOVE_UP].sort());
    expect(songs.length - back.length - up.length).toBe(17);
  });

  it('on production, where the 14 never moved, only the 7 move', () => {
    const moved = songs.filter((s) => octaveMove(s.key, range(s.production), evidence)).map((s) => s.key);
    expect(titles(moved)).toEqual([...SHOULD_MOVE_UP].sort());
  });

  it('is what keeps the pitch rule off the band: on the generated evidence alone it takes exactly those 14 down', () => {
    const moved = songs.filter((s) => octaveMove(s.key, range(s.production), generated)?.from === 'pitch').map((s) => s.key);
    expect(titles(moved)).toEqual([...SHOULD_GO_BACK].sort());
    expect(songs.some((s) => octaveMove(s.key, range(s.production), evidence)?.from === 'pitch')).toBe(false);
  });

  it.each(['preview', 'production'] as const)('moves nothing the second time, on the %s rows', async (state) => {
    const store = await seeded(state);
    const first = await fixStoredOctaves(store, evidence);
    expect(first).toEqual({ checked: 38, moved: state === 'preview' ? 21 : 7, fromRecording: 0, fromArtist: 0, fromPitch: 0, fromHand: state === 'preview' ? 21 : 7, skippedChanged: 0 });
    expect(await fixStoredOctaves(store, evidence)).toMatchObject({ checked: 38, moved: 0 });
    expect(await fixStoredOctaves(store, evidence, { dryRun: true })).toMatchObject({ moved: 0 });
    // The same rows either way: the preview ends where production's as-written rows plus the 7 end.
    const hellsBells = (await store.getSongRange('ac/dc|hells bells'))!;
    expect(notes(hellsBells.range!)).toBe('A4 to E5');
    expect(hellsBells.range!.octaveFrom).toBe('hand');
    expect(hellsBells.log.reason).toBe("Used the note file. Moved an octave up to match the artist's register, checked by hand.");
    expect(notes((await store.getSongRange('ac/dc|you shook me all night long'))!.range!)).toBe('G4 to D5');
    expect(notes((await store.getSongRange('ac/dc|let there be rock'))!.range!)).toBe('C3 to E5');
  });
});

describe('octaveLogNote', () => {
  it('says a move rests on a hand-checked register', () => {
    expect(octaveLogNote({ semitones: 12, from: 'hand' })).toBe("Moved an octave up to match the artist's register, checked by hand.");
  });
});
