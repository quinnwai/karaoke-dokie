import { useLayoutEffect, useRef, useState } from 'react';
import type { Match, VocalRange } from '../lib/contracts';
import { difficultyLabel, duetPartLine, isCatalogueTrack, octaveWording, rangeBar } from '../lib/client/display';
import { MOOD_LABELS } from '../lib/songs/browse';
import { FastLyricsIcon, OctaveIcon } from './Icon';
import styles from './screen.module.css';
import { SpotifyPlayer } from './SpotifyPlayer';

interface SongDetailProps {
  match: Match;
  userRange: VocalRange;
  feedback: 'up' | 'down' | undefined;
  onFeedback(thumbs: 'up' | 'down'): void;
  /** "Open in Spotify" was tapped (for the beta event log). */
  onSpotify?(): void;
  onBack(): void;
}

export function RangeBarView({ userRange, match }: { userRange: VocalRange; match: Match }) {
  const bar = rangeBar(userRange, match.range, match.octave);
  // Note names stay out of the way until wanted: hover or focus shows them, and so does a tap on a phone.
  const [open, setOpen] = useState(false);
  return (
    <div
      className={styles.rangeBar}
      role="img"
      aria-label={`Song goes from ${bar.song.low} to ${bar.song.high}. You sing from ${bar.user.low} to ${bar.user.high}.`}
      data-open={open || undefined}
      onClick={() => setOpen((o) => !o)}
    >
      <div className={styles.barTrack}>
        <div className={styles.barUser} style={{ left: `${bar.user.left}%`, width: `${bar.user.width}%` }} />
        <div className={styles.barSong} style={{ left: `${bar.song.left}%`, width: `${bar.song.width}%` }} />
      </div>
      <div className={styles.barNames} aria-hidden>
        <span className={styles.barNameSong} style={{ left: `${bar.song.left}%` }}>{bar.song.low}</span>
        <span className={styles.barNameSong} style={{ left: `${bar.song.left + bar.song.width}%` }}>{bar.song.high}</span>
        <span className={styles.barNameUser} style={{ left: `${bar.user.left}%` }}>{bar.user.low}</span>
        <span className={styles.barNameUser} style={{ left: `${bar.user.left + bar.user.width}%` }}>{bar.user.high}</span>
      </div>
      <div className={styles.barLegend} aria-hidden>
        <span><i className={styles.legendSong} /> song range</span>
        <span><i className={styles.legendUser} /> your range</span>
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

export function SongDetail({ match, userRange, feedback, onFeedback, onSpotify, onBack }: SongDetailProps) {
  const octave = octaveWording(match.octave);
  const maybe = match.difficulty === 'maybe';
  const duet = duetPartLine(match);
  const facts = [match.year, match.genre].filter((f) => f !== undefined && f !== '').join(' · ');
  const catalogue = isCatalogueTrack(match.track.id);

  // The screen is one scroller shared with the song list. With the player, a long title can make this page
  // taller than the screen, and it would open scrolled to wherever the list was, past the back button.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (root.current?.parentElement) root.current.parentElement.scrollTop = 0;
  }, []);

  return (
    <div className={styles.detail} ref={root}>
      <button type="button" className={styles.back} onClick={onBack} aria-label="Back to songs">
        ‹
      </button>

      <div className={styles.detailHead}>
        <h2 className={styles.detailTitle}>{match.track.title}</h2>
        <p className={styles.detailArtist}>{match.track.artist}</p>
        {facts && <p className={styles.detailFacts}>{facts}</p>}
      </div>

      <RangeBarView userRange={userRange} match={match} />

      <div className={styles.tags}>
        <span className={maybe ? styles.pillQuiet : styles.pill}>{difficultyLabel(match.difficulty)}</span>
        {match.range.fastLyrics && (
          <span className={`${styles.pillQuiet} ${styles.pillIcon}`}>
            <FastLyricsIcon className={styles.icon} size={16} />
            <span aria-hidden>Fast lyrics</span>
          </span>
        )}
        {match.moods?.map((mood) => (
          <span key={mood} className={styles.pillQuiet}>
            {MOOD_LABELS[mood]}
          </span>
        ))}
      </div>

      {octave && (
        <p className={styles.octave}>
          <OctaveIcon octave={match.octave} className={styles.icon} />
          <span>{octave}</span>
        </p>
      )}

      {duet && <p className={styles.octave}>{duet}</p>}

      {match.reasons && match.reasons.length > 0 && <p className={styles.detailReasons}>{match.reasons.join(' · ')}</p>}

      <SpotifyPlayer
        track={match.track}
        label={catalogue ? 'Find on Spotify' : 'Open in Spotify'}
        onOpen={onSpotify}
      />

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
