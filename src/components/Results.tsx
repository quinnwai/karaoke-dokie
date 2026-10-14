import type { Match, VocalRange } from '../lib/contracts';
import { midiToNoteName } from '../lib/audio/notes';
import { difficultyLabel, octaveWording } from '../lib/client/display';
import { Lyric } from './Lyric';
import styles from './screen.module.css';

interface ResultsProps {
  range: VocalRange;
  matches: Match[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  onSelect(trackId: string): void;
  onMore(): void;
  onRedo(): void;
}

export function Results({ range, matches, loading, error, hasMore, onSelect, onMore, onRedo }: ResultsProps) {
  return (
    <div className={styles.results}>
      <div className={styles.resultsBar}>
        <span className={styles.rangeChip} aria-label={`Your range ${midiToNoteName(range.low)} to ${midiToNoteName(range.high)}`}>
          {midiToNoteName(range.low)} – {midiToNoteName(range.high)}
        </span>
        <button type="button" className={styles.redo} onClick={onRedo} aria-label="Redo the singing test">
          redo
        </button>
      </div>

      <Lyric text="Songs for your voice" />

      {matches.length > 0 && (
        <ol className={styles.songList}>
          {matches.map((m) => {
            const octave = octaveWording(m.octave);
            return (
              <li key={m.track.id}>
                <button
                  type="button"
                  className={styles.song}
                  onClick={() => onSelect(m.track.id)}
                  aria-label={`${m.track.title} by ${m.track.artist}, ${difficultyLabel(m.difficulty)}${octave ? `. ${octave}` : ''}`}
                >
                  <span className={styles.songText}>
                    <span className={styles.songTitle}>{m.track.title}</span>
                    <span className={styles.songArtist}>{m.track.artist}</span>
                    {octave && <span className={styles.songOctave}>{octave}</span>}
                  </span>
                  <span className={styles.pill} data-difficulty={m.difficulty}>
                    {difficultyLabel(m.difficulty)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {!loading && !error && matches.length === 0 && (
        <p className={styles.hint}>No songs from your library fit yet. Try saving more songs on Spotify.</p>
      )}
      {error && <p className={styles.hint}>Couldn’t load songs.</p>}

      {(hasMore || error) && (
        <button type="button" className={styles.more} onClick={onMore} disabled={loading} aria-label={error ? 'Try loading songs again' : 'Generate more songs'}>
          {loading ? 'Loading…' : error ? 'Try again' : 'Generate more'}
        </button>
      )}
      {loading && !hasMore && !error && <p className={styles.hint}>Loading…</p>}
      {!loading && !error && !hasMore && matches.length > 0 && <p className={styles.hint}>That’s every song that fits, for now.</p>}
    </div>
  );
}
