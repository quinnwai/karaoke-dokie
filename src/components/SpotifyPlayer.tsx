import type { CSSProperties } from 'react';
import type { Track } from '../lib/contracts';
import { spotifyEmbedUrl } from '../lib/client/spotifyEmbed';
import { ExternalLinkIcon } from './Icon';
import styles from './screen.module.css';

/**
 * Spotify's own player, as the plain iframe from Spotify's "creating an embed" tutorial. It plays
 * in the page, and its Spotify logo opens the song in Spotify. When the song's link is not a track
 * to embed (catalogue songs, and the few offline-mock songs without a real id) a plain "Open in Spotify" link stands in.
 *
 * Keep the `allow` list as Spotify gives it: without `encrypted-media` the player only plays previews.
 */
interface SpotifyPlayerProps {
  track: Track;
  /** Text of the fallback link ("Find on Spotify" for catalogue songs). */
  label?: string;
  /** The fallback link was tapped (for the beta event log). */
  onOpen?(): void;
  /** The song page holds the link, and the player, for a moment after it opens (SongDetail's holdMs): the style is `pointer-events: none` then. */
  style?: CSSProperties;
}

export function SpotifyPlayer({ track, label = 'Open in Spotify', onOpen, style }: SpotifyPlayerProps) {
  const src = spotifyEmbedUrl(track.spotifyUrl);
  if (!src) {
    return (
      <a className={styles.spotify} style={style} href={track.spotifyUrl} target="_blank" rel="noreferrer" onClick={onOpen}>
        {label}
        <ExternalLinkIcon className={styles.externalIcon} />
      </a>
    );
  }
  return (
    <iframe
      className={styles.player}
      style={style}
      title={`Spotify player: ${track.title} by ${track.artist}`}
      src={src}
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"
    />
  );
}
