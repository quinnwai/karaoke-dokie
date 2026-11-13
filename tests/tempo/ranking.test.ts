// QWW-33, redone for QWW-54: the Tempo slider on songs with the bpm Deezer actually returned (read from its public API in
// November 2026). Several are double time (Hey Jude 148, Eminem 172, Hotel California 147), and no rule on the numbers can
// tell them from songs that really are fast, so a song's feel label decides which end it sits at. The labels here are what a
// listener would say. A song with no label is squeezed into the middle, whatever its bpm.

import { describe, expect, it } from 'vitest';
import type { Match, SetlistInput, VocalRange } from '../../src/lib/contracts';
import { DEFAULT_VIEW, orderMatches } from '../../src/lib/songs/browse';
import { rankSetlist, type SetlistCandidate } from '../../src/lib/songs/setlist';
import { effectiveTempo, isWeakLabelSource, type Feel } from '../../src/lib/tempo/feel';
import { rng } from '../helpers/sliderFixtures';

const user: VocalRange = { low: 40, high: 76, source: 'test' };

/** key, Deezer's bpm as returned (0 when it had none), the song's feel label (none when nobody labelled it). */
const SONGS: [string, number, Feel | undefined][] = [
  ['the beatles|hey jude', 148, 'slow'],
  ['louis armstrong|what a wonderful world', 0, 'slow'],
  ['a-ha|take on me', 169, 'upbeat'],
  ['the weeknd|blinding lights', 171, 'upbeat'],
  ['eagles|hotel california', 147, 'slow'],
  ['bob marley & the wailers|three little birds', 148, 'slow'],
  ['billy joel|piano man', 177, 'slow'],
  ['eminem|lose yourself', 172, 'mid'],
  ['rihanna|umbrella', 174, 'mid'],
  ['foo fighters|everlong', 158, undefined], // really fast, but nobody labelled it
  ['the rolling stones|paint it black', 160, 'upbeat'],
  ['abba|dancing queen', 100, 'upbeat'],
  ['guns n’ roses|november rain', 156, 'mid'],
  ['coldplay|yellow', 87, 'mid'],
  ['mark ronson|uptown funk', 115, 'upbeat'],
  ['some artist|never checked', 120, undefined],
];

const songs: Match[] = SONGS.map(([key, bpm, feel], i) => {
  const tempo = effectiveTempo({ key, record: bpm > 0 ? { deezerBpm: bpm } : undefined, feel })?.tempo;
  return {
    track: { id: key, title: key.split('|')[1]!, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: i },
    range: { low: 50, high: 62, tessitura: 56, source: 'note-file', confidence: 'high', fastLyrics: false },
    difficulty: 'easy',
    octave: 'none',
    ...(tempo !== undefined ? { tempo } : {}),
  } as Match;
});
const order = (tempo: number) => orderMatches(songs, { ...DEFAULT_VIEW, tempo }, user, 'catalogue').map((m) => m.track.id);

describe('Tempo slider with feel labels', () => {
  it('Slow jams puts the labelled slow songs first, double-time readings and all', () => {
    // Deezer calls Hey Jude 148, Hotel California 147, Three Little Birds 148 and Piano Man 177, and has no bpm for Wonderful
    // World; the label says slow for all of them, so they are the front of the list and the published tempo orders them.
    const slow = new Set(['the beatles|hey jude', 'louis armstrong|what a wonderful world', 'eagles|hotel california', 'bob marley & the wailers|three little birds', 'billy joel|piano man']);
    expect(new Set(order(0).slice(0, slow.size))).toEqual(slow);
    expect(order(0)[0]).toBe('louis armstrong|what a wonderful world'); // 66 is the slowest published tempo
  });

  it('Fast tracks puts the labelled upbeat songs last of all, and the fastest reading first', () => {
    const upbeat = ['a-ha|take on me', 'the weeknd|blinding lights'];
    expect(order(1).slice(0, 2).sort()).toEqual(upbeat.sort());
    // an upbeat song read at 100 (Dancing Queen) is upbeat all the same, behind the ones the numbers back up
    expect(order(1).indexOf('abba|dancing queen')).toBeLessThan(order(1).indexOf('coldplay|yellow'));
  });

  it('an unlabelled fast song does not reach the upbeat end, and a mid song read at 172 does not either', () => {
    const front = order(1).slice(0, 6);
    expect(front).not.toContain('foo fighters|everlong'); // 158 bpm, but unlabelled: in the middle
    expect(front).not.toContain('eminem|lose yourself'); // read at 172 and published at 86, labelled mid
    expect(front).not.toContain('rihanna|umbrella');
  });

  it('a song with no label and no bpm still sorts last', () => {
    expect(order(0).at(-1)).toBeDefined();
    const none = orderMatches([...songs, { ...songs[0]!, track: { ...songs[0]!.track, id: 'x|nothing known', playRank: 99 }, tempo: undefined }], { ...DEFAULT_VIEW, tempo: 0 }, user, 'catalogue');
    expect(none.at(-1)!.track.id).toBe('x|nothing known');
  });
});

// ---------- QWW-54 follow-up: "I See Fire" ----------
// Ed Sheeran's "I See Fire", a slow ballad, was labelled mid and read by Deezer at double time. The label only moves a reading by
// whole octaves when that is cheaper than leaving it, so the song was pinned just inside the top edge of the mid band, right
// under every upbeat song: 124.8 bpm and 72 of 100 on the Tempo gear, near the top at "Fast tracks". A slow label halves the
// same reading into the slow band, and nothing in the ranking can lift a slow-labelled song out of it.

/** The readings effectiveTempo takes: Deezer's, the beat tracker's and UltraStar's bpm. */
type Readings = NonNullable<Parameters<typeof effectiveTempo>[0]['record']>;

describe('Tempo gear: a slow label wins over a double-time reading', () => {
  it('halves the reading into the slow band with a slow label, and pins it under the upbeat band with a mid one', () => {
    const record: Readings = { deezerBpm: 132 }; // a ballad of about 66 bpm, read at double time
    const slow = effectiveTempo({ key: 'ed sheeran|i see fire', record, feel: 'slow' })!;
    const mid = effectiveTempo({ key: 'ed sheeran|i see fire', record, feel: 'mid' })!;
    expect(slow.tempo).toBeCloseTo(66, 5);
    expect(slow.adjusted).toBe('halved');
    expect(mid.tempo).toBeGreaterThan(124); // the mistake: the top of the mid band, next to the upbeat songs
    expect(mid.tempo).toBeLessThan(125);
  });

  /** The Tempo gear alone, turned to "Fast tracks". */
  const UPBEAT_END: SetlistInput = {
    range: { low: 41, high: 72 },
    gears: { difficulty: 50, history: 50, popularity: 50, tempo: 100 },
    off: ['difficulty', 'history', 'popularity', 'era'],
    eras: [],
    loggedIn: false,
  };

  /**
   * A pool in the catalogue's mix of labels (686 slow, 3,736 mid, 1,780 upbeat of 6,202, scaled to 400 songs, and a few with
   * no label). Every slow song is read at double time or more (Deezer, and the beat tracker for two in three), or has no
   * reading at all: the readings that put "I See Fire" at the upbeat end.
   */
  function pool(seed: number) {
    const rand = rng(seed);
    const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
    const songs: { key: string; feel: Feel | undefined; record?: Readings }[] = [];
    for (let i = 0; i < 45; i++) {
      const felt = between(52, 80);
      const record: Readings | undefined = i % 15 === 0 ? undefined : { deezerBpm: 2 * felt, ...(i % 3 ? { trackerBpm: 2 * felt } : {}) };
      songs.push({ key: `slow|ballad ${i}`, feel: 'slow', ...(record ? { record } : {}) });
    }
    for (let i = 0; i < 235; i++) {
      const felt = between(92, 122);
      songs.push({ key: `mid|song ${i}`, feel: 'mid', record: { deezerBpm: felt * (i % 5 === 0 ? 2 : i % 7 === 0 ? 0.5 : 1) } });
    }
    for (let i = 0; i < 115; i++) {
      const felt = between(130, 185);
      songs.push({ key: `upbeat|song ${i}`, feel: 'upbeat', record: { deezerBpm: felt * (i % 4 === 0 ? 0.5 : 1) } });
    }
    for (let i = 0; i < 5; i++) songs.push({ key: `none|song ${i}`, feel: undefined, record: { deezerBpm: between(60, 180) } });
    return songs;
  }

  const candidate = (song: ReturnType<typeof pool>[number], i: number): SetlistCandidate => {
    const tempo = effectiveTempo({ key: song.key, record: song.record, feel: song.feel })?.tempo;
    return {
      match: {
        track: { id: song.key, title: song.key.split('|')[1]!, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: i },
        range: { low: 50, high: 62, tessitura: 56, source: 'note-file', confidence: 'high', fastLyrics: false },
        difficulty: 'easy',
        octave: 'none',
        ...(tempo !== undefined ? { tempo } : {}),
      } as Match,
    };
  };

  it.each([54, 55, 56])('never lifts a slow-labelled song into the top 30% of the gear, whatever its readings (seed %i)', (seed) => {
    const songs = pool(seed);
    const list = rankSetlist(songs.map(candidate), UPBEAT_END);
    const slow = songs.filter((s) => s.feel === 'slow').map((s) => s.key);
    expect(slow).toHaveLength(45);
    for (const key of slow) {
      const song = list.songs.find((s) => s.match.track.id === key)!;
      expect(song.match.tempo, key).toBeLessThan(90); // in the slow band
      expect(song.gears.tempo, key).toBeLessThan(70); // so below the top 30% of the gear
    }
    // and none is among the first 30% of "Fast tracks"
    const front = new Set(list.songs.slice(0, Math.ceil(list.songs.length * 0.3)).map((s) => s.match.track.id));
    expect(slow.filter((key) => front.has(key))).toEqual([]);
  });
});

// ---------- QWW-54 follow-up: clear labels first ----------
// The judge agreed with 95% of the slow labels the strict first pass made and 79% (58% where two runs of three agreed) of the band-edge
// audit's. Labels from the plain-definition passes keep their band but rank behind the strict ones at either end of the gear.

describe('Tempo gear: strict labels rank ahead of plain-definition ones', () => {
  const STRICT = 'claude-opus-5-5/feel-v1';
  const PLAIN = 'claude-opus-5-5/feel-plain-v1';
  const AUDIT = 'claude-opus-5-5/feel-edge-recheck-v1';
  /** name, Deezer's bpm (none: no reading), label, where the label came from. */
  const POOL: [string, number | undefined, Feel, string][] = [
    ['strict slow 85', 85, 'slow', STRICT],
    ['strict slow 70', 70, 'slow', STRICT],
    ['audit slow 50', 50, 'slow', AUDIT], // the lowest tempo of the slow songs
    ['second-look slow 55', 55, 'slow', PLAIN],
    ['second-look slow, no reading', undefined, 'slow', PLAIN], // only its label vouches for it: last of the weak ones
    ['mid 100', 100, 'mid', STRICT],
    ['mid 110', 110, 'mid', STRICT],
    ['strict upbeat 150', 150, 'upbeat', STRICT],
    ['strict upbeat 170', 170, 'upbeat', STRICT],
    ['audit upbeat 190', 190, 'upbeat', AUDIT], // the highest tempo of the upbeat songs
    ['second-look upbeat 130', 130, 'upbeat', PLAIN],
    ['second-look upbeat, no reading', undefined, 'upbeat', PLAIN],
  ];
  const at = (tempo: 0 | 100): string[] => {
    const candidates: SetlistCandidate[] = POOL.map(([name, bpm, feel, source], i) => ({
      match: {
        track: { id: name, title: name, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: i },
        range: { low: 50, high: 62, tessitura: 56, source: 'note-file', confidence: 'high', fastLyrics: false },
        difficulty: 'easy',
        octave: 'none',
        tempo: effectiveTempo({ ...(bpm === undefined ? {} : { record: { deezerBpm: bpm } }), feel, weak: isWeakLabelSource(source) })!.tempo,
      } as Match,
    }));
    const input: SetlistInput = { range: { low: 41, high: 72 }, gears: { difficulty: 50, history: 50, popularity: 50, tempo }, off: ['difficulty', 'history', 'popularity', 'era'], eras: [], loggedIn: false };
    return rankSetlist(candidates, input).songs.map((s) => s.match.track.id);
  };

  it('puts the strict slow songs first at the slow end, then the audit\'s and the second look\'s, the one with no reading last of them, then the mid ones', () => {
    // Taken by tempo alone the audit's 50 and the second look's 55 would come first; resting at 89.5 the song with no reading would be ahead of them.
    expect(at(0).slice(0, 5)).toEqual(['strict slow 70', 'strict slow 85', 'audit slow 50', 'second-look slow 55', 'second-look slow, no reading']);
    expect(at(0).slice(5, 7)).toEqual(['mid 100', 'mid 110']);
  });

  it('puts the strict upbeat songs first at the upbeat end, then the second look\'s and the audit\'s, the one with no reading last of them, then the mid ones', () => {
    // Taken by tempo alone the audit's 190 would come first.
    expect(at(100).slice(0, 5)).toEqual(['strict upbeat 170', 'strict upbeat 150', 'audit upbeat 190', 'second-look upbeat 130', 'second-look upbeat, no reading']);
    expect(at(100).slice(5, 7)).toEqual(['mid 110', 'mid 100']);
  });
});
