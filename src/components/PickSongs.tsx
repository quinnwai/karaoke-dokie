import { MAX_PICKS, type KnownSong } from '../lib/client/flow';
import { Lyric } from './Lyric';
import styles from './screen.module.css';

interface PickSongsProps {
  songs: KnownSong[] | null;
  picks: string[];
  saving: boolean;
  onToggle(trackId: string): void;
  onDone(): void;
  onTest(): void;
}

export function PickSongs({ songs, picks, saving, onToggle, onDone, onTest }: PickSongsProps) {
  const full = picks.length >= MAX_PICKS;
  return (
    <div className={styles.results}>
      <Lyric text={`Pick up to ${MAX_PICKS} songs you sing well`} />

      {songs === null && <p className={styles.hint}>Loading your songs…</p>}
      {songs?.length === 0 && <p className={styles.hint}>We don’t know the range of any of your songs yet.</p>}

      {songs && songs.length > 0 && (
        <ul className={styles.songList}>
          {songs.map(({ track }) => {
            const on = picks.includes(track.id);
            return (
              <li key={track.id}>
                <button
                  type="button"
                  className={`${styles.song} ${on ? styles.picked : ''}`}
                  aria-pressed={on}
                  disabled={!on && full}
                  onClick={() => onToggle(track.id)}
                >
                  <span className={styles.songText}>
                    <span className={styles.songTitle}>{track.title}</span>
                    <span className={styles.songArtist}>{track.artist}</span>
                  </span>
                  <span className={styles.check} aria-hidden>
                    {on ? '●' : '○'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.pickActions}>
        <button type="button" className={styles.more} disabled={!picks.length || saving} onClick={onDone}>
          {saving ? 'Saving…' : `Use ${picks.length || ''} ${picks.length === 1 ? 'song' : 'songs'}`.replace('  ', ' ')}
        </button>
        <button type="button" className={styles.textButton} onClick={onTest}>
          take the singing test instead
        </button>
      </div>
    </div>
  );
}
