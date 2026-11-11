// QWW-33, redone for QWW-54: the Tempo slider on songs with the bpm Deezer actually returned (read from its public API in
// November 2026). Several are double time (Hey Jude 148, Eminem 172, Hotel California 147), and no rule on the numbers can
// tell them from songs that really are fast, so a song's feel label decides which end it sits at. The labels here are what a
// listener would say. A song with no label is squeezed into the middle, whatever its bpm.

import { describe, expect, it } from 'vitest';
import type { Match, VocalRange } from '../../src/lib/contracts';
import { DEFAULT_VIEW, orderMatches } from '../../src/lib/songs/browse';
import { effectiveTempo, type Feel } from '../../src/lib/tempo/feel';

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

  it('Upbeat tracks puts the labelled upbeat songs last of all, and the fastest reading first', () => {
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
