import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Decade, Match, Mood, ResultsMode, ResultsView, SortId, VocalRange } from '../lib/contracts';
import { midiToNoteName } from '../lib/audio/notes';
import {
  artistLine,
  CATALOGUE_NOTE,
  difficultyLabel,
  duetPartLine,
  MAYBE_NOTE,
  octaveWording,
  reasonsForSort,
} from '../lib/client/display';
import { rangeWarning } from '../lib/client/rangeCheck';
import { isRangeKept, keepRange } from '../lib/client/storage';
import {
  availableFacets,
  availableSorts,
  chipCounts,
  DECADES,
  hasFilters,
  MOOD_LABELS,
  savedDividerIndex,
  SORTS,
  viewMatches,
} from '../lib/songs/browse';
import { FastLyricsIcon, OctaveIcon } from './Icon';
import { Lyric } from './Lyric';
import styles from './screen.module.css';

interface ResultsProps {
  range: VocalRange;
  mode: ResultsMode;
  /** Every match, in the server's Top picks order. */
  matches: Match[];
  view: ResultsView;
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
  onSort(sort: SortId): void;
  onDecade(decade: Decade): void;
  onMood(mood: Mood): void;
  onDuets(): void;
  onClear(): void;
  /** Catalogue mode: sign in to Spotify for songs from the singer's own library. */
  onConnect(): void;
}

export function Results(props: ResultsProps) {
  const { range, mode, matches, view, shown, loading, error } = props;
  const low = midiToNoteName(range.low);
  const high = midiToNoteName(range.high);
  const warning = rangeWarning(range);
  const [kept, setKept] = useState(() => isRangeKept(range.low, range.high));
  const keep = () => {
    keepRange(range.low, range.high);
    setKept(true);
  };
  const maybeId = useId();

  const sorts = useMemo(() => availableSorts(mode, matches), [mode, matches]);
  const facets = useMemo(() => availableFacets(matches), [matches]);
  const counts = useMemo(() => chipCounts(matches, view), [matches, view]);
  const list = useMemo(() => viewMatches(matches, view, range, mode), [matches, view, range, mode]);
  const visible = list.slice(0, shown);
  // Maybe songs (estimated ranges) sort last in every view and get their own list, without a label.
  const sure = visible.filter((m) => m.difficulty !== 'maybe');
  const maybe = visible.filter((m) => m.difficulty === 'maybe');
  const divider = savedDividerIndex(visible, mode);
  const sortDef = SORTS.find((s) => s.id === view.sort) ?? SORTS[0]!;
  const showFilters = facets.decades || facets.moods.length > 0 || facets.duets;

  const row = (m: Match, position: number) => {
    const octave = octaveWording(m.octave);
    const duet = duetPartLine(m);
    const reasons = [...(duet ? [duet] : []), ...reasonsForSort(m.reasons, view.sort)].slice(0, 2);
    const yearText = typeof m.year === 'number' ? `, ${m.year}` : '';
    return (
      <button
        type="button"
        className={styles.song}
        onClick={() => props.onSelect(m.track.id, position)}
        aria-label={`${m.track.title} by ${m.track.artist}${yearText}, ${difficultyLabel(m.difficulty)}${octave ? `. ${octave}` : ''}${m.range.fastLyrics ? '. Fast lyrics' : ''}${duet ? `. ${duet}` : ''}`}
      >
        <span className={styles.songText}>
          <span className={styles.songTitle}>{m.track.title}</span>
          <span className={styles.songArtist}>{artistLine(m)}</span>
          {reasons.length > 0 && <span className={styles.songReasons}>{reasons.join(' · ')}</span>}
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
    );
  };

  return (
    <div className={styles.results}>
      <div className={styles.resultsBar}>
        <span className={styles.rangeChip} aria-label={`Your range ${low} to ${high}`}>
          <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('low')} aria-label={`Redo your low note, ${low}`}>
            {low}
          </button>{' '}
          –{' '}
          <button type="button" className={styles.rangeNote} onClick={() => props.onRedoEnd('high')} aria-label={`Redo your high note, ${high}`}>
            {high}
          </button>
        </span>
        <span className={styles.barActions}>
          {mode === 'catalogue' && (
            <button type="button" className={styles.connect} onClick={props.onConnect}>
              Connect Spotify
            </button>
          )}
          <button type="button" className={styles.redo} onClick={props.onRedo} aria-label="Redo the singing test">
            redo
          </button>
        </span>
      </div>

      {warning && !kept && (
        <div className={styles.rangeWarning} role="status">
          <p>{warning.message}</p>
          <div className={styles.rangeWarningActions}>
            <button type="button" className={warning.end === 'low' ? styles.more : styles.redo} onClick={() => props.onRedoEnd('low')}>
              Redo low note
            </button>
            <button type="button" className={warning.end === 'high' ? styles.more : styles.redo} onClick={() => props.onRedoEnd('high')}>
              Redo high note
            </button>
            <button type="button" className={styles.textButton} onClick={keep}>
              Keep it
            </button>
          </div>
        </div>
      )}

      {matches.length > 0 && (
        <div className={styles.controls}>
          <ChipRow label="Sort songs" selected={view.sort}>
            {SORTS.filter((s) => sorts.includes(s.id)).map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.sortPill}
                aria-pressed={view.sort === s.id}
                data-selected={view.sort === s.id || undefined}
                onClick={() => props.onSort(s.id)}
              >
                {s.label}
              </button>
            ))}
          </ChipRow>
          {showFilters && (
            <ChipRow label="Filter songs" selected={view.decade ?? view.mood ?? (view.duetsOnly ? 'duets' : null)}>
              {facets.decades &&
                DECADES.map((d) => (
                  <Chip
                    key={d.id}
                    id={d.id}
                    label={d.label}
                    count={counts.decades[d.id]}
                    on={view.decade === d.id}
                    onClick={() => props.onDecade(d.id)}
                  />
                ))}
              {facets.moods.length > 0 && <span className={styles.chipDivider} aria-hidden />}
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
              {facets.duets && (
                <>
                  <span className={styles.chipDivider} aria-hidden />
                  <Chip id="duets" label="Duets" count={counts.duets} on={view.duetsOnly} onClick={props.onDuets} />
                </>
              )}
              {hasFilters(view) && (
                <button type="button" className={styles.clearChip} onClick={props.onClear}>
                  Clear
                </button>
              )}
            </ChipRow>
          )}
        </div>
      )}

      <Lyric text={matches.length > 0 ? sortDef.lyric : 'Songs for your voice'} />

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
        <button type="button" className={styles.more} onClick={props.onMore} aria-label="Generate more songs">
          Generate more
        </button>
      )}
      {loading && <p className={styles.hint}>Loading…</p>}
      {!loading && !error && list.length > 0 && visible.length >= list.length && (
        <p className={styles.hint}>That’s every song that fits, for now.</p>
      )}
      {mode === 'catalogue' && matches.length > 0 && (
        <p className={styles.catalogueNote}>
          {CATALOGUE_NOTE}{' '}
          <button type="button" className={styles.textButton} onClick={props.onConnect}>
            Connect Spotify
          </button>
        </p>
      )}
      <a className={styles.credits} href="/credits">
        Sources and credits
      </a>
    </div>
  );
}

/** A horizontally scrolling row of pills that keeps the picked one in view. */
function ChipRow({ label, selected, children }: { label: string; selected: string | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const picked = ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    picked?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  return (
    <div ref={ref} className={styles.chipRow} role="group" aria-label={label}>
      {children}
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
