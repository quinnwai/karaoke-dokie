import { describe, expect, it } from 'vitest';
import { createDeezerClient, deezerQuery, matchesKey, pickDeezerHit, type DeezerTrack } from '../../src/lib/popularity/deezer';
import { songKey } from '../../src/lib/songs/resolve';

const track = (artist: string, title: string, rank: number, id = rank): DeezerTrack => ({ id, title, rank, artist: { name: artist } });

describe('deezerQuery', () => {
  it('searches the plain artist and title, without version tags or featured artists', () => {
    expect(deezerQuery('2 Chainz', 'Presha (with Lil Wayne)')).toBe('2 chainz presha');
    expect(deezerQuery('Toto', 'Africa - Remastered 2011')).toBe('toto africa');
  });
});

describe('matchesKey', () => {
  const key = songKey('Mariah the Scientist', 'Burning Blue');
  it('accepts the same artist and title, whatever the case, tags or punctuation', () => {
    expect(matchesKey(key, track('Mariah The Scientist', 'Burning Blue', 1))).toBe(true);
    expect(matchesKey(songKey('The Rolling Stones', 'Paint It, Black'), track('The Rolling Stones', 'Paint It Black', 1))).toBe(true);
    expect(matchesKey(songKey('Queen', 'Bohemian Rhapsody'), track('Queen', 'Bohemian Rhapsody (Live Aid)', 1))).toBe(true);
  });
  it('accepts an artist named with words added, like "Ms. Lauryn Hill" for "Lauryn Hill"', () => {
    expect(matchesKey(songKey('Ms. Lauryn Hill', 'Doo Wop (That Thing)'), track('Lauryn Hill', 'Doo Wop (That Thing)', 1))).toBe(true);
  });
  it('refuses another artist, another title, and karaoke or instrumental versions', () => {
    expect(matchesKey(key, track('Lil Barberi', "I'm a fan of mariah the scientist", 1))).toBe(false);
    expect(matchesKey(key, track('ZZang KARAOKE', 'Burning Blue (Instrumental Karaoke Version)', 1))).toBe(false);
    expect(matchesKey(key, track('Mariah The Scientist', 'Burning Blue (Instrumental)', 1))).toBe(false);
    expect(matchesKey(key, track('Mariah The Scientist', 'Burning', 1))).toBe(false);
  });
});

describe('pickDeezerHit', () => {
  it('takes the best-ranked matching result, original or live', () => {
    const results = [track('Toto', 'Africa (Live)', 383_105), track('Toto', 'Africa', 964_180), track('Weezer', 'Africa', 999_999)];
    expect(pickDeezerHit(songKey('Toto', 'Africa'), results)).toEqual({ rank: 964_180, deezerId: 964_180, artist: 'Toto', title: 'Africa' });
  });
  it('is null when nothing matches', () => {
    expect(pickDeezerHit(songKey('Toto', 'Africa'), [track('Weezer', 'Africa', 1)])).toBeNull();
  });
});

describe('createDeezerClient', () => {
  it('waits out a quota error and tries again', async () => {
    const answers = [{ error: { code: 4, message: 'Quota limit exceeded' } }, { data: [track('Toto', 'Africa', 5)] }];
    const urls: string[] = [];
    const waits: number[] = [];
    const client = createDeezerClient({
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => answers.shift() };
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await client.search('toto africa')).toEqual([track('Toto', 'Africa', 5)]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('https://api.deezer.com/search?q=toto%20africa&limit=10');
    expect(waits).toContain(5000);
  });
  it('gives up after its tries', async () => {
    const client = createDeezerClient({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), sleep: async () => {}, tries: 2 });
    await expect(client.search('x')).rejects.toThrow('HTTP 503');
  });
});

describe('matchesKey, names written differently', () => {
  it('reads "&" as "and" and a medley by its first song', () => {
    expect(matchesKey(songKey('KC & The Sunshine Band', 'Boogie Shoes'), track('KC and the Sunshine Band', 'Boogie Shoes', 1))).toBe(true);
    expect(matchesKey(songKey('Chicago', "Hard to Say I'm Sorry - 2009 Remaster"), track('Chicago', "Hard to Say I'm Sorry / Get Away", 1))).toBe(true);
  });
});
