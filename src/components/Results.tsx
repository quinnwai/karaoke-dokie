import { useId, useState } from 'react';
import type { Match, VocalRange } from '../lib/contracts';
import { midiToNoteName } from '../lib/audio/notes';
import { difficultyLabel, MAYBE_NOTE, octaveWording } from '../lib/client/display';
import { rangeWarning } from '../lib/client/rangeCheck';
import { isRangeKept, keepRange } from '../lib/client/storage';
import { FastLyricsIcon, OctaveIcon } from './Icon';
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
  /** Re-sing just the low or the high note, keeping the other. */
  onRedoEnd(end: 'low' | 'high'): void;
}

export function Results({ range, matches, loading, error, hasMore, onSelect, onMore, onRedo, onRedoEnd }: ResultsProps) {
  const low = midiToNoteName(range.low);
  const high = midiToNoteName(range.high);
  const warning = rangeWarning(range);
  const [kept, setKept] = useState(() => isRangeKept(range.low, range.high));
  const keep = () => {
    keepRange(range.low, range.high);
    setKept(true);
  };
  const maybeId = useId();
  // Maybe songs (ranked last by the server) get their own list after the main one, without a label.
  const sure = matches.filter((m) => m.difficulty !== 'maybe');
  const maybe = matches.filter((m) => m.difficulty === 'maybe');
  const row = (m: Match) => {
    const octave = octaveWording(m.octave);
    return (
      <li key={m.track.id}>
        <button
          type="button"
          className={styles.song}
          onClick={() => onSelect(m.track.id)}
          aria-label={`${m.track.title} by ${m.track.artist}, ${difficultyLabel(m.difficulty)}${octave ? `. ${octave}` : ''}${m.range.fastLyrics ? '. Fast lyrics' : ''}`}
        >
          <span className={styles.songText}>
            <span className={styles.songTitle}>{m.track.title}</span>
            <span className={styles.songArtist}>{m.track.artist}</span>
            {m.reasons && m.reasons.length > 0 && <span className={styles.songReasons}>{m.reasons.join(' · ')}</span>}
          </span>
          <span className={styles.songMeta}>
            <OctaveIcon octave={m.octave} className={styles.icon} />
            {m.range.fastLyrics && <FastLyricsIcon className={styles.icon} />}
            {m.difficulty !== 'maybe' && (
              <span className={styles.pill} data-difficulty={m.difficulty}>
                {difficultyLabel(m.difficulty)}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className={styles.results}>
      <div className={styles.resultsBar}>
        <span className={styles.rangeChip} aria-label={`Your range ${low} to ${high}`}>
          <button type="button" className={styles.rangeNote} onClick={() => onRedoEnd('low')} aria-label={`Redo your low note, ${low}`}>
            {low}
          </button>{' '}
          –{' '}
          <button type="button" className={styles.rangeNote} onClick={() => onRedoEnd('high')} aria-label={`Redo your high note, ${high}`}>
            {high}
          </button>
        </span>
        <button type="button" className={styles.redo} onClick={onRedo} aria-label="Redo the singing test">
          redo
        </button>
      </div>

      {warning && !kept && (
        <div className={styles.rangeWarning} role="status">
          <p>{warning.message}</p>
          <div className={styles.rangeWarningActions}>
            <button type="button" className={warning.end === 'low' ? styles.more : styles.redo} onClick={() => onRedoEnd('low')}>
              Redo low note
            </button>
            <button type="button" className={warning.end === 'high' ? styles.more : styles.redo} onClick={() => onRedoEnd('high')}>
              Redo high note
            </button>
            <button type="button" className={styles.textButton} onClick={keep}>
              Keep it
            </button>
          </div>
        </div>
      )}

      <Lyric text="Songs for your voice" />

      {sure.length > 0 && <ol className={styles.songList}>{sure.map(row)}</ol>}

      {maybe.length > 0 && (
        <section className={styles.maybe} aria-labelledby={maybeId}>
          <h2 id={maybeId} className={styles.maybeTitle}>
            Maybe
          </h2>
          <p className={styles.maybeNote}>{MAYBE_NOTE}</p>
          <ol className={styles.songList}>{maybe.map(row)}</ol>
        </section>
      )}

      {!loading && !error && matches.length === 0 && (
        <p className={styles.hint}>None of your songs have range data yet, or none fit your range.</p>
      )}
      {error && <p className={styles.hint}>Couldn’t load songs.</p>}

      {(hasMore || error) && (
        <button type="button" className={styles.more} onClick={onMore} disabled={loading} aria-label={error ? 'Try loading songs again' : 'Generate more songs'}>
          {loading ? 'Loading…' : error ? 'Try again' : 'Generate more'}
        </button>
      )}
      {loading && !hasMore && !error && <p className={styles.hint}>Loading…</p>}
      {!loading && !error && !hasMore && matches.length > 0 && <p className={styles.hint}>That’s every song that fits, for now.</p>}
      <a className={styles.credits} href="/credits">
        Sources and credits
      </a>
    </div>
  );
}
