// QWW-33: the Tempo slider on songs with the bpm Deezer actually returned (read from its public API in
// November 2026). Several are double time (Hey Jude 148, Eminem 172, Hotel California 147), so the
// checked tempos in data/tempo-gold.json have to win for Slow jams and Upbeat tracks to be right.

import { describe, expect, it } from 'vitest';
import type { Match, VocalRange } from '../../src/lib/contracts';
import { DEFAULT_VIEW, orderMatches } from '../../src/lib/songs/browse';
import { tempoOf } from '../../src/lib/tempo/tempo';

const user: VocalRange = { low: 40, high: 76, source: 'test' };

/** key, Deezer's bpm as returned (0 when it had none). */
const DEEZER: [string, number][] = [
  ['the beatles|hey jude', 148],
  ['louis armstrong|what a wonderful world', 0],
  ['a-ha|take on me', 169],
  ['the weeknd|blinding lights', 171],
  ['eagles|hotel california', 147],
  ['bob marley & the wailers|three little birds', 148],
  ['billy joel|piano man', 177],
  ['eminem|lose yourself', 172],
  ['rihanna|umbrella', 174],
  ['foo fighters|everlong', 158],
  ['the rolling stones|paint it black', 160],
  ['abba|dancing queen', 100],
  ['guns n’ roses|november rain', 156],
  ['coldplay|yellow', 87],
  ['mark ronson|uptown funk', 115],
  ['some artist|never checked', 120],
];

const songs: Match[] = DEEZER.map(([key, bpm], i) => {
  const tempo = tempoOf(bpm > 0 ? { deezerBpm: bpm } : undefined, key);
  return {
    track: { id: key, title: key.split('|')[1]!, artist: 'A', artistId: 'a', spotifyUrl: '', playRank: i },
    range: { low: 50, high: 62, tessitura: 56, source: 'note-file', confidence: 'high', fastLyrics: false },
    difficulty: 'easy',
    octave: 'none',
    ...(tempo !== undefined ? { tempo } : {}),
  } as Match;
});
const top = (tempo: number, n: number) => orderMatches(songs, { ...DEFAULT_VIEW, tempo }, user, 'catalogue').slice(0, n).map((m) => m.track.id);

describe('Tempo slider on checked tempos', () => {
  it('Slow jams lists What a Wonderful World (72) and Hey Jude (74) among the first five', () => {
    // Deezer has no bpm for Wonderful World and calls Hey Jude 148; both are slow once checked. Hotel
    // California, Three Little Birds and Piano Man are checked at 74 to 75, so they share the front.
    expect(top(0, 5)).toEqual(expect.arrayContaining(['louis armstrong|what a wonderful world', 'the beatles|hey jude']));
    expect(top(0, 1)).toEqual(['louis armstrong|what a wonderful world']);
  });

  it('Upbeat tracks lists Take On Me and Blinding Lights first', () => {
    expect(top(1, 2).sort()).toEqual(['a-ha|take on me', 'the weeknd|blinding lights'].sort());
  });

  it('the double-time songs (Hotel California, Three Little Birds, Piano Man, Lose Yourself) sit on the slow half', () => {
    const order = orderMatches(songs, { ...DEFAULT_VIEW, tempo: 0 }, user, 'catalogue').map((m) => m.track.id);
    const half = new Set(order.slice(0, 8));
    for (const key of ['eagles|hotel california', 'bob marley & the wailers|three little birds', 'billy joel|piano man', 'eminem|lose yourself']) {
      expect(half.has(key), key).toBe(true);
    }
  });
});
