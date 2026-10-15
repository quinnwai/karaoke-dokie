import { describe, expect, it, vi } from 'vitest';
import type { SongRange, Track } from '../../src/lib/contracts';
import { hasLittleSinging, resolveSongRange, songKey, type ResolveDeps } from '../../src/lib/songs/resolve';
import { fixture } from './fixture';

const track: Track = {
  id: 't1',
  title: 'Somebody to Love - Remastered 2011',
  artist: 'Queen',
  artistId: 'q',
  spotifyUrl: 'https://open.spotify.com/track/t1',
  playRank: 3,
};

const noteRange = (low: number, high: number): SongRange => ({
  low,
  high,
  tessitura: (low + high) / 2,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
});

const NOW = new Date('2026-10-14T12:00:00.000Z');

function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    getNoteFile: vi.fn(async () => null),
    getArtistSongRanges: vi.fn(async () => []),
    getExternalArtistRange: vi.fn(async () => null),
    now: () => NOW,
    ...overrides,
  };
}

describe('resolveSongRange', () => {
  it('uses the note file first and does not look further', async () => {
    const d = deps({ getNoteFile: vi.fn(async () => fixture('solo.txt')) });
    const { range, log } = await resolveSongRange(track, d);
    expect(range).toMatchObject({ low: 55, high: 67, source: 'note-file', confidence: 'high' });
    expect(log).toEqual({
      trackId: 't1',
      title: track.title,
      artist: 'Queen',
      outcome: 'note-file',
      reason: 'Used the UltraStar note file for this song.',
      at: NOW.toISOString(),
    });
    expect(d.getNoteFile).toHaveBeenCalledWith('Queen', track.title);
    expect(d.getArtistSongRanges).not.toHaveBeenCalled();
    expect(d.getExternalArtistRange).not.toHaveBeenCalled();
  });

  it('falls back to the typical range of other songs by the artist', async () => {
    const others = [noteRange(50, 70), noteRange(52, 72), noteRange(48, 69), noteRange(51, 71), noteRange(50, 74), noteRange(49, 70), noteRange(53, 73)];
    const d = deps({ getArtistSongRanges: vi.fn(async () => others) });
    const { range, log } = await resolveSongRange(track, d);
    expect(range).toMatchObject({ low: 50, high: 71, source: 'artist-typical', confidence: 'low' });
    expect(log.outcome).toBe('artist-typical');
    expect(log.reason).toBe('No note file found; used the typical range of 7 other songs by Queen.');
    expect(d.getArtistSongRanges).toHaveBeenCalledWith('Queen', track.title);
  });

  it('says "song" for a single other song', async () => {
    const d = deps({ getArtistSongRanges: vi.fn(async () => [noteRange(50, 70)]) });
    expect((await resolveSongRange(track, d)).log.reason).toBe(
      'No note file found; used the typical range of 1 other song by Queen.',
    );
  });

  it('falls back to the narrowed published artist range', async () => {
    const d = deps({ getExternalArtistRange: vi.fn(async () => ({ low: 40, high: 80 })) });
    const { range, log } = await resolveSongRange(track, d);
    expect(range).toMatchObject({ low: 50, high: 70, source: 'artist-external', confidence: 'low' });
    expect(log.outcome).toBe('artist-external');
    expect(log.reason).toBe(
      "No note file found and no other songs by Queen have one; used Queen's published vocal range, narrowed to its middle half.",
    );
    expect(d.getExternalArtistRange).toHaveBeenCalledWith('Queen');
  });

  it('skips the song when nothing is known', async () => {
    const { range, log } = await resolveSongRange(track, deps());
    expect(range).toBeNull();
    expect(log.outcome).toBe('skipped');
    expect(log.reason).toBe(
      'No note file found, no other songs by Queen have one, and no published vocal range for Queen; skipped.',
    );
  });

  it('treats an unreadable note file as missing and says so', async () => {
    const d = deps({
      getNoteFile: vi.fn(async () => '#TITLE:broken\n: 0 4 0 a\n'),
      getArtistSongRanges: vi.fn(async () => [noteRange(50, 70), noteRange(52, 72)]),
    });
    const { range, log } = await resolveSongRange(track, d);
    expect(range?.source).toBe('artist-typical');
    expect(log.reason).toBe(
      'The note file could not be read; used the typical range of 2 other songs by Queen.',
    );
  });

  it('ignores non-note-file ranges from the artist lookup', async () => {
    const guess: SongRange = { ...noteRange(40, 60), source: 'artist-typical', confidence: 'low' };
    const d = deps({ getArtistSongRanges: vi.fn(async () => [guess]) });
    expect((await resolveSongRange(track, d)).log.outcome).toBe('skipped');
  });

  it('stamps the current time when no clock is given', async () => {
    const { now: _now, ...rest } = deps();
    const { log } = await resolveSongRange(track, rest);
    expect(Number.isNaN(Date.parse(log.at))).toBe(false);
  });
});

describe('songKey', () => {
  it('lowercases, strips accents and collapses spaces', () => {
    expect(songKey('Beyoncé', '  Déjà   Vu ')).toBe('beyonce|deja vu');
  });

  it('drops remaster suffixes, brackets and featured artists', () => {
    expect(songKey('Queen', 'Somebody to Love - Remastered 2011')).toBe('queen|somebody to love');
    expect(songKey('Queen', 'Bohemian Rhapsody (Live Aid) [2011 Mix]')).toBe('queen|bohemian rhapsody');
    expect(songKey('Calvin Harris feat. Rihanna', 'This Is What You Came For')).toBe(
      'calvin harris|this is what you came for',
    );
    expect(songKey('Mark Ronson', 'Uptown Funk (feat. Bruno Mars)')).toBe('mark ronson|uptown funk');
    expect(songKey('Mark Ronson', 'Uptown Funk feat. Bruno Mars')).toBe('mark ronson|uptown funk');
    expect(songKey('Eminem ft. Rihanna', 'Love The Way You Lie')).toBe('eminem|love the way you lie');
  });

  it('matches the same song written differently', () => {
    expect(songKey('QUEEN', "Don't Stop Me Now - 2011 Remaster")).toBe(songKey('Queen', "Don't Stop Me Now"));
  });

  it('keeps a hyphen that is part of a word', () => {
    expect(songKey('a-ha', 'Take On Me')).toBe('a-ha|take on me');
  });
});

describe('hasLittleSinging', () => {
  it('spots dub, instrumental and karaoke versions in the version tag', () => {
    expect(hasLittleSinging('Back To Life (However Do You Want Me) - Satta Dub')).toBe(true);
    expect(hasLittleSinging('Back to Life (Instrumental)')).toBe(true);
    expect(hasLittleSinging('Hello [Karaoke Version]')).toBe(true);
    expect(hasLittleSinging('Hello - Backing Track')).toBe(true);
  });

  it('keeps the original, remixes, live and acoustic versions, and titles that only contain the word', () => {
    expect(hasLittleSinging('Back To Life (However Do You Want Me)')).toBe(false);
    expect(hasLittleSinging('Titanium - David Guetta Remix')).toBe(false);
    expect(hasLittleSinging('Hello - Live at the BBC')).toBe(false);
    expect(hasLittleSinging('Rub a Dub')).toBe(false);
    expect(hasLittleSinging('Dubstep Love - Acoustic')).toBe(false);
  });
});
