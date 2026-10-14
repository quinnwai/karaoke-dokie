import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { matchSong, paginate, rankMatches, songKey } from '../../src/lib/server/songLogicFallback';
import { createPlaceholderResolver, noteFileSource, SEED_SONGS } from '../../src/lib/server/wiring';
import { MOCK_TRACKS } from '../../src/lib/server/mockSpotify';

const track = (artist: string, title: string): Track => ({
  id: 'x',
  title,
  artist,
  artistId: 'a',
  spotifyUrl: '',
  playRank: 0,
});

describe('seed song ranges', () => {
  it('has 10 valid, clearly marked placeholder entries', () => {
    expect(SEED_SONGS).toHaveLength(10);
    for (const s of SEED_SONGS) {
      expect(s.range.low).toBeLessThan(s.range.tessitura);
      expect(s.range.tessitura).toBeLessThan(s.range.high);
      expect(s.provenance).toMatch(/Placeholder/);
      expect(s.range.confidence).toBe('low');
    }
  });

  it('every seed is in the mock library', () => {
    const keys = new Set(MOCK_TRACKS.map((t) => songKey(t.artist, t.title)));
    for (const s of SEED_SONGS) expect(keys.has(songKey(s.artist, s.title))).toBe(true);
  });

  it('resolves seeded songs and skips the rest with a reason', async () => {
    const resolve = createPlaceholderResolver(SEED_SONGS, songKey, noteFileSource, () => new Date(0));
    const hit = await resolve(track('QUEEN', 'Bohemian Rhapsody - Remastered 2011'));
    expect(hit.range).toEqual(SEED_SONGS[0]!.range);
    expect(hit.log).toMatchObject({ outcome: 'artist-external', at: '1970-01-01T00:00:00.000Z' });
    const miss = await resolve(track('Nobody', 'Unknown'));
    expect(miss.range).toBeNull();
    expect(miss.log.outcome).toBe('skipped');
    expect(miss.log.reason).toMatch(/note file/i);
  });
});

describe('placeholder song logic', () => {
  const r = { low: 50, high: 70, tessitura: 60, source: 'note-file' as const, confidence: 'high' as const, fastLyrics: false };
  const t = track('A', 'B');

  it('normalizes song keys', () => {
    expect(songKey('Beyoncé', 'Halo (feat. X)')).toBe(songKey('beyonce', 'Halo'));
  });

  it('matches as written, an octave down or up, or not at all', () => {
    expect(matchSong(t, r, { low: 45, high: 76, source: 'test' })).toMatchObject({ octave: 'none', difficulty: 'easy' });
    expect(matchSong(t, r, { low: 50, high: 70, source: 'test' })).toMatchObject({ octave: 'none', difficulty: 'medium' });
    expect(matchSong(t, r, { low: 36, high: 60, source: 'test' })).toMatchObject({ octave: 'down' });
    expect(matchSong(t, r, { low: 60, high: 84, source: 'test' })).toMatchObject({ octave: 'up' });
    expect(matchSong(t, r, { low: 55, high: 65, source: 'test' })).toBeNull();
    expect(matchSong(t, { ...r, fastLyrics: true }, { low: 45, high: 76, source: 'test' })?.difficulty).toBe('medium');
  });

  it('ranks easier songs first and pages', () => {
    const m = (difficulty: 'easy' | 'hard', playRank: number) => ({
      track: { ...t, playRank },
      range: r,
      difficulty,
      octave: 'none' as const,
    });
    expect(rankMatches([m('hard', 0), m('easy', 2), m('easy', 1)]).map((x) => x.track.playRank)).toEqual([1, 2, 0]);
    expect(paginate([1, 2, 3], 0, 2)).toEqual({ items: [1, 2], nextOffset: 2 });
    expect(paginate([1, 2, 3], 2, 2)).toEqual({ items: [3], nextOffset: null });
  });
});
