import { describe, expect, it } from 'vitest';
import { spotifyEmbedUrl } from '../../src/lib/client/spotifyEmbed';
import { MOCK_TRACKS } from '../../src/lib/server/mockSpotify';

describe('mock Spotify tracks', () => {
  it("give most songs a real track link, so the offline demo shows Spotify's player", () => {
    const embeddable = MOCK_TRACKS.filter((t) => spotifyEmbedUrl(t.spotifyUrl));
    expect(embeddable.length).toBeGreaterThanOrEqual(20);
    const elvis = MOCK_TRACKS.find((t) => t.title === "Can't Help Falling in Love")!;
    expect(spotifyEmbedUrl(elvis.spotifyUrl)).toBe('https://open.spotify.com/embed/track/44AyOl4qVkzS48vBsbNXaC');
  });

  it('keeps a search link for any song without a verified id', () => {
    for (const t of MOCK_TRACKS) {
      if (!spotifyEmbedUrl(t.spotifyUrl)) expect(t.spotifyUrl).toMatch(/^https:\/\/open\.spotify\.com\/search\//);
    }
  });
});
