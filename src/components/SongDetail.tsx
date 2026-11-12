import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Match, VocalRange } from '../lib/contracts';
import { difficultyLabel, duetPartLine, isCatalogueTrack, NAMES_APART, octaveWording, rangeBar, type Span } from '../lib/client/display';
import { spotifyEmbedUrl } from '../lib/client/spotifyEmbed';
import { MOOD_LABELS } from '../lib/songs/browse';
import { FastLyricsIcon, OctaveIcon } from './Icon';
import { PreviewButton } from './PreviewButton';
import styles from './screen.module.css';
import { SpotifyPlayer } from './SpotifyPlayer';

interface SongDetailProps {
  match: Match;
  userRange: VocalRange;
  feedback: 'up' | 'down' | undefined;
  onFeedback(thumbs: 'up' | 'down'): void;
  /** "Open in Spotify" was tapped (for the beta event log). */
  onSpotify?(): void;
  /**
   * How long, ms, the page's controls but ‹ (the ▶, the Spotify link or player, the thumbs) let a tap through to the screen behind them,
   * from the moment the page is on the screen (KaraokeApp's TAP_GUARD_MS). A double tap on a row puts its second tap here, on whatever
   * the page has under that spot. Unset, nothing is held.
   */
  holdMs?: number;
  onBack(): void;
}

/** One bar's two note names, each under its end (R25). A bar too short for that (NAMES_APART) has them outside its ends, so they never touch. */
function EndNames({ span, className }: { span: Span; className: string | undefined }) {
  const apart = span.width < NAMES_APART || undefined;
  return (
    <>
      <span className={className} data-end="low" data-apart={apart} style={{ left: `${span.left}%` }}>{span.low}</span>
      <span className={className} data-end="high" data-apart={apart} style={{ left: `${span.left + span.width}%` }}>{span.high}</span>
    </>
  );
}

export function RangeBarView({ userRange, match }: { userRange: VocalRange; match: Match }) {
  const bar = rangeBar(userRange, match.range, match.octave, match.shape);
  // The note names are always there (R25). The legend under them waits for a hover, or a tap on a phone, which has no hover (R20).
  const [open, setOpen] = useState(false);
  return (
    <div
      className={styles.rangeBar}
      role="img"
      aria-label={`Song goes from ${bar.song.low} to ${bar.song.high}${bar.original ? ' as you would sing it' : ''}. You sing from ${bar.user.low} to ${bar.user.high}.${bar.shape ? ' Most of the song sits where the taller bars are.' : ''}`}
      data-open={open || undefined}
      onClick={() => setOpen((o) => !o)}
    >
      {bar.shape && (
        <div className={styles.barShape} aria-hidden>
          {bar.shape.map((b, i) => (
            <i key={i} style={{ left: `${b.left}%`, width: `${b.width}%`, height: `${Math.max(b.height, 3)}%` }} />
          ))}
        </div>
      )}
      <div className={styles.barTrack}>
        <div className={styles.barUser} style={{ left: `${bar.user.left}%`, width: `${bar.user.width}%` }} />
        {bar.original && <div className={styles.barOriginal} style={{ left: `${bar.original.left}%`, width: `${bar.original.width}%` }} />}
        <div className={styles.barSong} style={{ left: `${bar.song.left}%`, width: `${bar.song.width}%` }} />
      </div>
      <div className={styles.barNames} aria-hidden>
        <EndNames span={bar.song} className={styles.barNameSong} />
        <EndNames span={bar.user} className={styles.barNameUser} />
      </div>
      <div className={styles.barLegend} aria-hidden>
        <span><i className={styles.legendSong} /> song range</span>
        <span><i className={styles.legendUser} /> your range</span>
        {bar.original && <span><i className={styles.legendOriginal} /> as recorded</span>}
      </div>
    </div>
  );
}

/** An outline, and filled once it is the one that was picked, so what was picked is not told by its colour alone. */
function Thumb({ down, picked }: { down?: boolean; picked?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path
        d="M7 10v10H4V10h3zm2 10h8.2a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 18.4 10H14l.8-4a1.6 1.6 0 0 0-2.9-1.2L9 10v10z"
        fill={picked ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SongDetail({ match, userRange, feedback, onFeedback, onSpotify, holdMs = 0, onBack }: SongDetailProps) {
  const octave = octaveWording(match.octave);
  const maybe = match.difficulty === 'maybe';
  const duet = duetPartLine(match);
  const facts = [match.year, match.genre].filter((f) => f !== undefined && f !== '').join(' · ');
  const catalogue = isCatalogueTrack(match.track.id);
  // Spotify's own player (an iframe) where the song's link is a track to embed; the plain link otherwise (the catalogue's search links).
  const embedded = spotifyEmbedUrl(match.track.spotifyUrl) !== null;

  // The screen is one scroller shared with the song list. With the player, a long title can make this page
  // taller than the screen, and it would open scrolled to wherever the list was, past the back button.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (root.current?.parentElement) root.current.parentElement.scrollTop = 0;
  }, []);

  // The page holds its controls for a moment from the commit that puts it on the screen, which is the row's tap (a layout effect, so the
  // moment does not start after a paint). `pointer-events: none` lets a touch or a click through to the screen behind: the ▶ is not
  // pressed, the link does not navigate (a skipped handler would not stop it), no thumb is sent, and Spotify's iframe, which no handler
  // of ours can see into, is held too. Keys are not touched (a key is not a double tap), nor is ‹ (no row sits under it), and nor is
  // anything that is not a control: the text and the chart can still be hit-tested.
  const [holding, setHolding] = useState(holdMs > 0);
  useLayoutEffect(() => {
    if (holdMs <= 0) return;
    const timer = setTimeout(() => setHolding(false), holdMs);
    return () => clearTimeout(timer);
  }, [holdMs]);
  const held: CSSProperties | undefined = holding ? { pointerEvents: 'none' } : undefined;
  const spotify = <SpotifyPlayer track={match.track} label={catalogue ? 'Find on Spotify' : 'Open in Spotify'} onOpen={onSpotify} style={held} />;

  return (
    <div className={styles.detail} ref={root} data-hold={holding || undefined}>
      <button type="button" className={styles.back} onClick={onBack} aria-label="Back to songs">
        ‹
      </button>

      <div className={styles.detailHead}>
        <h2 className={styles.detailTitle}>{match.track.title}</h2>
        <p className={styles.detailArtist}>{match.track.artist}</p>
        {facts && <p className={styles.detailFacts}>{facts}</p>}
      </div>

      {/* The page's first action (R27): the Deezer ▶ with its ring, on the list's one-at-a-time player (leaving the page stops it). Under it,
          the secondary one: "Find on Spotify" as an outlined button. Spotify's own player, where there is one to embed, stays lower down. */}
      <PreviewButton id={match.track.id} deezerId={match.deezerId} title={match.track.title} artist={match.track.artist} large style={held} />
      {!embedded && spotify}

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

      {embedded && spotify}

      {/* A like or dislike stays (R26): after a tap the thanks takes the question's place and stays, and the thumbs stay, the picked one selected
          and neither of them to be tapped again, on later visits too. One live region for both, so a screen reader says the thanks once. */}
      <div className={styles.feedback}>
        <p className={feedback ? styles.thanks : styles.feedbackQ} aria-live="polite">
          {feedback ? 'Thanks! That helps.' : 'How’d it go?'}
        </p>
        <button type="button" className={styles.thumb} aria-label="It went well" aria-pressed={feedback === 'up'} disabled={feedback !== undefined} onClick={() => onFeedback('up')} style={held}>
          <Thumb picked={feedback === 'up'} />
        </button>
        <button type="button" className={styles.thumb} aria-label="It didn't go well" aria-pressed={feedback === 'down'} disabled={feedback !== undefined} onClick={() => onFeedback('down')} style={held}>
          <Thumb down picked={feedback === 'down'} />
        </button>
      </div>
    </div>
  );
}
