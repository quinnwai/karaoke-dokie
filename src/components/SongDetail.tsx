import { useId, useState } from 'react';
import type { DataSourceLogEntry, Match, VocalRange } from '../lib/contracts';
import { difficultyLabel, octaveWording, rangeBar, sourceTooltip } from '../lib/client/display';
import styles from './screen.module.css';

interface SongDetailProps {
  match: Match;
  userRange: VocalRange;
  source: DataSourceLogEntry | undefined;
  feedback: 'up' | 'down' | undefined;
  onFeedback(thumbs: 'up' | 'down'): void;
  onBack(): void;
}

export function RangeBarView({ userRange, match }: { userRange: VocalRange; match: Match }) {
  const bar = rangeBar(userRange, match.range, match.octave);
  return (
    <div className={styles.rangeBar} role="img" aria-label={`Song goes from ${bar.song.low} to ${bar.song.high}. You sing from ${bar.user.low} to ${bar.user.high}.`}>
      <div className={styles.barTrack}>
        <div className={styles.barUser} style={{ left: `${bar.user.left}%`, width: `${bar.user.width}%` }}>
          <span className={styles.barEndLow}>{bar.user.low}</span>
          <span className={styles.barEndHigh}>{bar.user.high}</span>
        </div>
        <div className={styles.barSong} style={{ left: `${bar.song.left}%`, width: `${bar.song.width}%` }}>
          <span className={styles.barEndLow}>{bar.song.low}</span>
          <span className={styles.barEndHigh}>{bar.song.high}</span>
        </div>
      </div>
      <div className={styles.barLegend} aria-hidden>
        <span><i className={styles.legendSong} /> song</span>
        <span><i className={styles.legendUser} /> you</span>
      </div>
    </div>
  );
}

function Thumb({ down }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path
        d="M7 10v10H4V10h3zm2 10h8.2a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 18.4 10H14l.8-4a1.6 1.6 0 0 0-2.9-1.2L9 10v10z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SongDetail({ match, userRange, source, feedback, onFeedback, onBack }: SongDetailProps) {
  const [infoOpen, setInfoOpen] = useState(false);
  const tipId = useId();
  const octave = octaveWording(match.octave);

  return (
    <div className={styles.detail}>
      <button type="button" className={styles.back} onClick={onBack} aria-label="Back to songs">
        ‹
      </button>

      <div className={styles.detailHead}>
        <h2 className={styles.detailTitle}>{match.track.title}</h2>
        <p className={styles.detailArtist}>{match.track.artist}</p>
      </div>

      <RangeBarView userRange={userRange} match={match} />

      <div className={styles.tags}>
        <span className={styles.pill}>{difficultyLabel(match.difficulty)}</span>
        {match.range.fastLyrics && <span className={styles.pillQuiet}>Fast lyrics</span>}
        <span className={styles.infoWrap}>
          <button
            type="button"
            className={styles.info}
            aria-label="Where this came from"
            aria-expanded={infoOpen}
            aria-describedby={infoOpen ? tipId : undefined}
            onClick={() => setInfoOpen((o) => !o)}
          >
            i
          </button>
          {infoOpen && (
            <span role="tooltip" id={tipId} className={styles.tooltip}>
              {sourceTooltip(source)}
            </span>
          )}
        </span>
      </div>

      {octave && <p className={styles.octave}>{octave}</p>}

      <a className={styles.spotify} href={match.track.spotifyUrl} target="_blank" rel="noreferrer">
        Open in Spotify
      </a>

      <div className={styles.feedback}>
        {feedback ? (
          <p className={styles.thanks} aria-live="polite">
            Thanks! That helps.
          </p>
        ) : (
          <>
            <span className={styles.feedbackQ}>How’d it go?</span>
            <button type="button" className={styles.thumb} aria-label="It went well" onClick={() => onFeedback('up')}>
              <Thumb />
            </button>
            <button type="button" className={styles.thumb} aria-label="It didn't go well" onClick={() => onFeedback('down')}>
              <Thumb down />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
