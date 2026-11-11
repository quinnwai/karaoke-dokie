import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Decade, Match, Mood, ResultsMode, ResultsView, SliderId, VocalRange } from '../lib/contracts';
import { midiToNoteName } from '../lib/audio/notes';
import {
  artistLine,
  difficultyLabel,
  duetPartLine,
  MAYBE_NOTE,
  octaveWording,
  reasonsForSlider,
} from '../lib/client/display';
import {
  activeSliders,
  availableFacets,
  availableSliders,
  chipCounts,
  DECADES,
  hasFilters,
  MOOD_LABELS,
  savedDividerIndex,
  SLIDERS,
  viewMatches,
  type SliderDef,
} from '../lib/songs/browse';
import { BookIcon, FastLyricsIcon, OctaveIcon, ResetIcon, SpotifyIcon } from './Icon';
import { DeezerCredit, PreviewButton } from './PreviewButton';
import styles from './screen.module.css';

interface ResultsProps {
  range: VocalRange;
  mode: ResultsMode;
  /** Every match, in the server's Top picks order. */
  matches: Match[];
  view: ResultsView;
  /** The slider moved last; it leads the lyric line and the reasons. */
  leadSlider: SliderId | null;
  /** How many songs of the view are on screen. */
  shown: number;
  loading: boolean;
  error: boolean;
  /** `position` is the song's 1-based place in the list on screen. */
  onSelect(trackId: string, position: number): void;
  onMore(): void;
  onRetry(): void;
  onRedo(): void;
  /** Re-sing just the low or the high note, keeping the other. */
  onRedoEnd(end: 'low' | 'high'): void;
  onSlider(slider: SliderId, value: number): void;
  /** The thumb was let go (for the event log). */
  onSliderDone(slider: SliderId): void;
  onResetSliders(): void;
  onDecade(decade: Decade): void;
  onMood(mood: Mood): void;
  onDuets(): void;
  onClear(): void;
  /** Catalogue mode: sign in to Spotify for songs from the singer's own library. */
  onConnect(): void;
  /**
   * Signed in, but the server could not read the Spotify library and sent catalogue songs (QWW-55): one quiet line
   * says so, and the connect prompts, which are for someone without Spotify, stay away.
   */
  libraryUnavailable?: boolean;
  /**
   * The singer tried to sign in and Spotify refused (the server's ?authError, QWW-55): one quiet line says so. The
   * connect prompts stay, so they can try again.
   */
  signInFailed?: boolean;
  /** Library mode: the singer's Spotify display name (from GET /api/me). */
  displayName: string | null;
  /** Library mode: ends the session. Rejects when it could not, which the logo's box then says. */
  onLogout(): Promise<void>;
}

export function Results(props: ResultsProps) {
  const { range, mode, matches, view, leadSlider, shown, loading, error } = props;
  const low = midiToNoteName(range.low);
  const high = midiToNoteName(range.high);
  const maybeId = useId();
  const tuneId = useId();
  const pickId = useId();
  // Reset and Clear disappear once pressed; focus moves to their panel instead of the page.
  const tuneRef = useRef<HTMLElement>(null);
  const pickRef = useRef<HTMLElement>(null);

  const sliders = useMemo(() => availableSliders(mode, matches), [mode, matches]);
  const facets = useMemo(() => availableFacets(matches), [matches]);
  const counts = useMemo(() => chipCounts(matches, view), [matches, view]);
  const list = useMemo(() => viewMatches(matches, view, range, mode), [matches, view, range, mode]);
  const visible = list.slice(0, shown);
  // Maybe songs (estimated ranges) come last in every view and get their own list, without a label.
  const sure = visible.filter((m) => m.difficulty !== 'maybe');
  const maybe = visible.filter((m) => m.difficulty === 'maybe');
  const divider = savedDividerIndex(visible, mode, view);
  const showPicks = facets.decades || facets.moods.length > 0 || facets.duets;
  const tuned = activeSliders(view).length > 0;

  const row = (m: Match, position: number) => {
    const octave = octaveWording(m.octave);
    const duet = duetPartLine(m);
    const reasons = [...(duet ? [duet] : []), ...reasonsForSlider(m.reasons, leadSlider)].slice(0, 2);
    const yearText = typeof m.year === 'number' ? `, ${m.year}` : '';
    return (
      <div className={styles.songRow}>
        <PreviewButton id={m.track.id} deezerId={m.deezerId} title={m.track.title} artist={m.track.artist} />
        <button
          type="button"
          className={styles.song}
          onClick={() => props.onSelect(m.track.id, position)}
          aria-label={`${m.track.title} by ${m.track.artist}${yearText}, ${difficultyLabel(m.difficulty)}${octave ? `. ${octave}` : ''}${m.range.fastLyrics ? '. Fast lyrics' : ''}${duet ? `. ${duet}` : ''}`}
        >
          <span className={styles.songText}>
            <span className={styles.songTitle}>{m.track.title}</span>
            <span className={styles.songArtist}>{artistLine(m)}</span>
            {reasons.length > 0 && <SungReasons key={reasons.join(' · ')} reasons={reasons} />}
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
      </div>
    );
  };

  return (
    <div className={styles.results}>
      <div className={styles.resultsBar}>
        {/* The range and its redo sit together on the left: redo is about the range. */}
        <span className={styles.rangeGroup}>
          <span className={styles.rangeChip} aria-label={`Your range ${low} to ${high}`}>
            <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('low')} aria-label={`Redo your low note, ${low}`}>
              {low}
            </button>{' '}
            –{' '}
            <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('high')} aria-label={`Redo your high note, ${high}`}>
              {high}
            </button>
          </span>
          <button type="button" className={styles.redo} onClick={props.onRedo} aria-label="Redo the singing test">
            redo
          </button>
        </span>
        {mode === 'catalogue' && !props.libraryUnavailable && (
          <button type="button" className={styles.connect} onClick={props.onConnect} aria-label="Connect to Spotify">
            <SpotifyIcon />
            <span className={styles.connectTip} aria-hidden>
              Connect to Spotify
            </span>
          </button>
        )}
        {(mode === 'library' || props.libraryUnavailable) && <SpotifyAccount name={props.displayName} onLogout={props.onLogout} />}
      </div>

      {props.libraryUnavailable && (
        <p className={styles.libraryNote} role="status">
          Couldn’t reach Spotify, showing popular songs.
        </p>
      )}
      {props.signInFailed && (
        <p className={styles.libraryNote} role="status">
          Couldn’t sign in. Spotify sign-in is for invited testers only right now.
        </p>
      )}

      {matches.length > 0 && (
        <div className={styles.controls}>
          {/* Sliders reorder: continuous preferences, pink. */}
          <section ref={tuneRef} tabIndex={-1} className={styles.tune} aria-labelledby={tuneId}>
            <div className={styles.controlsHead}>
              <h2 id={tuneId} className={styles.tuneLabel}>
                Tune
              </h2>
              {tuned && (
                <button
                  type="button"
                  className={styles.headIcon}
                  aria-label="Reset sliders"
                  title="Reset sliders"
                  onClick={() => {
                    props.onResetSliders();
                    tuneRef.current?.focus();
                  }}
                >
                  <ResetIcon size={16} />
                </button>
              )}
            </div>
            {SLIDERS.filter((s) => sliders.includes(s.id)).map((s) => (
              <PreferenceSlider
                key={s.id}
                def={s}
                value={view[s.id]}
                onChange={(v) => props.onSlider(s.id, v)}
                onDone={() => props.onSliderDone(s.id)}
              />
            ))}
          </section>

          {/* Chips filter: discrete labels, one pick per row, cyan. */}
          {showPicks && (
            <section ref={pickRef} tabIndex={-1} className={styles.pick} aria-labelledby={pickId}>
              <div className={styles.controlsHead}>
                <h2 id={pickId} className={styles.pickLabel}>
                  Pick
                </h2>
                <span className={styles.controlsCount} aria-live="polite">
                  {list.length} {list.length === 1 ? 'song' : 'songs'}
                </span>
                {hasFilters(view) && (
                  <button
                    type="button"
                    className={styles.headAction}
                    onClick={() => {
                      props.onClear();
                      pickRef.current?.focus();
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {/* Chips wrap onto new lines rather than scroll sideways: decades, then moods and duets. */}
              <div className={styles.chipRows} role="group" aria-label="Filter songs">
                {facets.decades && (
                  <div className={styles.chipRow}>
                    {DECADES.map((d) => (
                      <Chip
                        key={d.id}
                        id={d.id}
                        label={d.label}
                        count={counts.decades[d.id]}
                        on={view.decade === d.id}
                        onClick={() => props.onDecade(d.id)}
                      />
                    ))}
                  </div>
                )}
                {(facets.moods.length > 0 || facets.duets) && (
                  <div className={styles.chipRow}>
                    {facets.moods.map((mood) => (
                      <Chip
                        key={mood}
                        id={mood}
                        label={MOOD_LABELS[mood]}
                        count={counts.moods[mood]}
                        on={view.mood === mood}
                        onClick={() => props.onMood(mood)}
                      />
                    ))}
                    {facets.duets && <Chip id="duets" label="Duets" count={counts.duets} on={view.duetsOnly} onClick={props.onDuets} />}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      )}

      {visible.some((m) => m.deezerId !== undefined) && <DeezerCredit />}

      {sure.length > 0 && (
        <ol className={styles.songList}>
          {sure.map((m, i) => (
            <li key={m.track.id} className={i === divider ? styles.afterDivider : undefined}>
              {i === divider && (
                <span className={styles.savedDivider} role="separator">
                  Saved, not played lately
                </span>
              )}
              {row(m, i + 1)}
            </li>
          ))}
        </ol>
      )}

      {maybe.length > 0 && (
        <section className={styles.maybe} aria-labelledby={maybeId}>
          <h2 id={maybeId} className={styles.maybeTitle}>
            Maybe
          </h2>
          <p className={styles.maybeNote}>{MAYBE_NOTE}</p>
          <ol className={styles.songList}>
            {maybe.map((m, i) => (
              <li key={m.track.id}>{row(m, sure.length + i + 1)}</li>
            ))}
          </ol>
        </section>
      )}

      {!loading && !error && matches.length === 0 && (
        <p className={styles.hint}>
          {mode === 'catalogue'
            ? 'None of our catalogue songs fit this range yet.'
            : 'None of your songs have range data yet, or none fit your range.'}
        </p>
      )}
      {error && <p className={styles.hint}>Couldn’t load songs.</p>}

      {error && (
        <button type="button" className={styles.more} onClick={props.onRetry} aria-label="Try loading songs again">
          Try again
        </button>
      )}
      {!error && visible.length < list.length && (
        <button type="button" className={styles.loadMore} onClick={props.onMore} aria-label="Load more songs">
          Load more
        </button>
      )}
      {loading && <p className={styles.hint}>Loading…</p>}
      {mode === 'library' && !loading && !error && list.length > 0 && visible.length >= list.length && (
        <p className={styles.hint}>That’s every song that fits, for now.</p>
      )}
      {mode === 'catalogue' && !props.libraryUnavailable && matches.length > 0 && (
        <div className={styles.catalogueNote}>
          <p>Want personalized recommendations?</p>
          <button type="button" className={styles.textButton} onClick={props.onConnect}>
            Connect to Spotify
          </button>
          <p>Invited testers only for now.</p>
        </div>
      )}
      <a className={styles.credits} href="/credits" aria-label="Sources and credits" title="Sources and credits">
        <BookIcon />
      </a>
    </div>
  );
}

/**
 * The Spotify logo of a singer who is signed in: green, with a small box that says who and offers
 * Log out. A mouse pointing at the logo shows the box (CSS, only where a pointer can hover); a tap
 * on it, or Enter, opens and closes it, and a tap elsewhere or Escape closes it. Logging out is one
 * more tap on purpose, so a stray tap on the logo cannot end the session.
 */
function SpotifyAccount({ name, onLogout }: { name: string | null; onLogout(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'working' | 'failed'>('idle');
  const root = useRef<HTMLDivElement>(null);
  const logo = useRef<HTMLButtonElement>(null);
  const boxId = useId();

  useEffect(() => {
    if (!open) return;
    const tapAway = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      logo.current?.focus();
    };
    document.addEventListener('pointerdown', tapAway);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', tapAway);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const logOut = async () => {
    setStatus('working');
    try {
      await onLogout();
      // Done: the screen switches to the signed-out view and this box goes with it.
    } catch {
      setStatus('failed');
    }
  };

  return (
    <div ref={root} className={styles.account} data-open={open || undefined}>
      <button
        ref={logo}
        type="button"
        className={`${styles.connect} ${styles.connectOn}`}
        aria-label="Spotify account"
        aria-expanded={open}
        aria-controls={boxId}
        onClick={() => setOpen((o) => !o)}
      >
        <SpotifyIcon />
      </button>
      <div id={boxId} className={styles.accountMenu}>
        <div className={styles.accountBox}>
          <span className={styles.accountName}>{name ? `Logged in as ${name}` : 'Logged in'}</span>
          <span aria-hidden>·</span>
          <button type="button" className={styles.logout} disabled={status === 'working'} onClick={() => void logOut()}>
            Log out
          </button>
          {status === 'failed' && (
            <p className={styles.accountError} role="alert">
              Couldn’t log out. Try again.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Seconds between one sung word of a reason line and the next. */
const REASON_WORD_GAP = 0.14;
/** Share of a reason line that must be on screen before it is sung. */
const SEEN = 0.6;

/**
 * A song's reasons, sung in like a karaoke lyric the first time its row scrolls into view: each
 * word lights up pink in turn, then settles back to the line's own pink. Sings again when the
 * reasons change (the caller keys it on their text). Wraps only between reasons: the words of one
 * reason are joined by no-break spaces, so none is split across lines unless it alone is too wide.
 */
function SungReasons({ reasons }: { reasons: string[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  // Without IntersectionObserver there is no way to tell when the row is seen: show it settled.
  const [sing, setSing] = useState<'waiting' | 'singing' | 'settled'>(() =>
    typeof IntersectionObserver === 'undefined' ? 'settled' : 'waiting',
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || sing !== 'waiting') return;
    // No root: the viewport, after clipping by every scrolling box around the row (the TV screen).
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.intersectionRatio >= SEEN)) {
          setSing('singing');
          observer.disconnect();
        }
      },
      { threshold: SEEN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [sing]);

  let beat = 0;
  const word = (text: string) => (
    <span className={styles.reasonWord} style={{ animationDelay: `${(beat++ * REASON_WORD_GAP).toFixed(2)}s` }}>
      {text}
    </span>
  );
  return (
    <span ref={ref} className={styles.songReasons} data-reasons data-sing={sing}>
      {reasons.map((reason, i) => (
        <Fragment key={i}>
          {i > 0 && <> {word('·')} </>}
          {reason
            .split(' ')
            .filter(Boolean)
            .map((w, j) => (
              <Fragment key={j}>
                {j > 0 && '\u00a0'}
                {word(w)}
              </Fragment>
            ))}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * One continuous preference. Untouched it does nothing and sits dim in the middle; moving it (a
 * drag, a tap, a key or a screen-reader swipe) sets a target, and the songs closest to it come first.
 */
function PreferenceSlider({
  def,
  value,
  onChange,
  onDone,
}: {
  def: SliderDef;
  value: number | null;
  onChange(value: number): void;
  onDone(): void;
}) {
  const active = value !== null;
  const position = Math.round((value ?? 0.5) * 100);
  const where = !active ? 'not set' : position < 34 ? `towards ${def.left}` : position > 66 ? `towards ${def.right}` : 'in between';
  const set = (raw: string) => onChange(Number(raw) / 100);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  // The browser's own change event marks the end of one adjustment: the thumb let go, a key step or
  // a screen-reader swipe. React's onChange fires on every step of a drag instead.
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const record = () => done.current();
    input.addEventListener('change', record);
    return () => input.removeEventListener('change', record);
  }, []);
  return (
    <div
      className={styles.sliderRow}
      data-active={active || undefined}
      // Pink fills the track up to the thumb only: progress, not the whole line.
      style={{ '--fill': position / 100 } as CSSProperties}
    >
      <span className={styles.sliderEnd} aria-hidden>
        {def.left}
      </span>
      <input
        ref={ref}
        type="range"
        min={0}
        max={100}
        step={1}
        value={position}
        className={styles.slider}
        aria-label={`${def.left} to ${def.right}`}
        aria-valuetext={where}
        onChange={(e) => set(e.currentTarget.value)}
        // A tap on the thumb of an untouched slider moves nothing, so no change event comes: it
        // switches on when the tap ends. A scroll that starts on the track ends in pointercancel.
        onPointerUp={(e) => {
          if (active || e.button > 0) return; // not a right or middle click
          set(e.currentTarget.value);
          onDone();
        }}
      />
      <span className={styles.sliderEnd} aria-hidden>
        {def.right}
      </span>
    </div>
  );
}

function Chip({ id, label, count, on, onClick }: { id: string; label: string; count: number; on: boolean; onClick(): void }) {
  // A chip with no songs, given the other picks, is shown but cannot be picked.
  const disabled = count === 0 && !on;
  return (
    <button
      type="button"
      className={styles.chip}
      data-chip={id}
      aria-pressed={on}
      aria-label={`${label}, ${count} ${count === 1 ? 'song' : 'songs'}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label} <span className={styles.chipCount}>{count}</span>
    </button>
  );
}
