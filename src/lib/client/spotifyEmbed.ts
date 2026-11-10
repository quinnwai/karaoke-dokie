// Spotify's embedded player: which iframe address belongs to a song.

const EMBED_BASE = 'https://open.spotify.com/embed/track/';

/**
 * The address of Spotify's player for the song a `https://open.spotify.com/track/ID` link points
 * to, or null when the link is not a track link (the offline mock's search links, an empty string,
 * another site). Only the ID is copied over, and only when it is letters and digits, so the result
 * can never point anywhere but Spotify's player.
 */
export function spotifyEmbedUrl(spotifyUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(spotifyUrl);
  } catch {
    return null;
  }
  if (url.hostname !== 'open.spotify.com') return null;
  const id = /^\/track\/([0-9A-Za-z]+)$/.exec(url.pathname)?.[1];
  return id ? EMBED_BASE + id : null;
}
