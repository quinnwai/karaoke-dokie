import { describe, expect, it } from 'vitest';
import { spotifyEmbedUrl } from '../../src/lib/client/spotifyEmbed';

const ID = '7tFiyTwD0nx5a1eklYtX2J';
const EMBED = `https://open.spotify.com/embed/track/${ID}`;

describe('spotifyEmbedUrl', () => {
  it('turns a track link into the address of the player', () => {
    expect(spotifyEmbedUrl(`https://open.spotify.com/track/${ID}`)).toBe(EMBED);
  });

  it('ignores a query string or fragment on the link', () => {
    expect(spotifyEmbedUrl(`https://open.spotify.com/track/${ID}?si=abc123&go=1#top`)).toBe(EMBED);
  });

  it.each([
    ['an empty link', ''],
    ['text that is not a link', 'open in spotify'],
    ["the offline mock's search link", 'https://open.spotify.com/search/Queen%20Bohemian%20Rhapsody'],
    ['an album link', `https://open.spotify.com/album/${ID}`],
    ['a track link with no id', 'https://open.spotify.com/track/'],
    ['another site', `https://example.com/track/${ID}`],
    ['a lookalike host', `https://open.spotify.com.example.com/track/${ID}`],
    ['a path that climbs out of /track/', `https://open.spotify.com/track/${ID}/../../x`],
    ['more path after the id', `https://open.spotify.com/track/${ID}/extra`],
    ['an id with an encoded slash', 'https://open.spotify.com/track/ab%2Fcd'],
    ['an id with punctuation', 'https://open.spotify.com/track/ab-cd'],
    ['a script address', 'javascript:alert(1)'],
  ])('is null for %s', (_what, link) => {
    expect(spotifyEmbedUrl(link)).toBeNull();
  });
});
