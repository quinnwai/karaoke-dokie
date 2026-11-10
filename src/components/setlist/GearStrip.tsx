import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { GEAR_META, RESET_TITLE } from '../../lib/setlist/gears';
import type { GearId } from '../../lib/setlist/types';
import { GearArt } from './GearArt';
import styles from './setlist.module.css';

interface GearStripProps {
  gear: GearId;
  /** The gear's value. While it is off this is the default, drawn dimmed. */
  value: number;
  off: boolean;
  /** Not drawn (the mini sheet shows one gear). */
  hidden: boolean;
  /** Set when the gear cannot be used at all (History before Spotify is connected): shown in place of the track. */
  unavailable?: string;
  onInput(value: number): void;
  /** A press landed on the slider while it was off. */
  onTouch(): void;
  onReset(): void;
  /** One adjustment ended: the thumb was let go, or a key or swipe stepped the value. */
  onDone(): void;
}

/** The reset arrow: counterclockwise, 2 px stroke, in the colour of the text, drawn 16 px by the button (spec §4a). */
export function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 12A7.5 7.5 0 1 0 12 4.5" />
      <path d="M14.5 1.75L11.75 4.5L14.5 7.25" />
    </svg>
  );
}

/**
 * One slider gear: its art, its label with a reset button, a custom track, and the real `<input type="range">` laid
 * over the track, invisible (spec §8). Off, the gear shows its default value in a disabled style until it is touched.
 */
export function GearStrip(props: GearStripProps) {
  const { gear, value, off, hidden, unavailable } = props;
  const meta = GEAR_META[gear];
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  // The press that turned an off gear on, until the browser's own `change` says the value moved too, or the press ends.
  const touched = useRef(false);
  const handlers = useRef(props);
  useEffect(() => {
    handlers.current = props;
  });

  // The browser's `change` event ends one adjustment: the thumb let go, a key step or a screen-reader swipe.
  // (`input` fires on every step of a drag instead.)
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const done = () => {
      touched.current = false;
      handlers.current.onDone();
    };
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);

  const endPress = () => {
    setTimeout(() => {
      if (touched.current) {
        touched.current = false;
        handlers.current.onDone();
      }
    }, 0);
  };

  return (
    <div className={styles.strip} data-strip="" data-gear={gear} data-off={off || undefined} hidden={hidden}>
      <GearArt gear={gear} variant="strip" value={value} className={styles.gearArt} />
      <div className={styles.stripBody} style={{ '--pct': `${value}%` } as CSSProperties}>
        <div className={styles.gearHead}>
          <label className={styles.eyebrow} htmlFor={`slider-${gear}`}>
            {meta.eyebrow}
            {off && (
              <span className={styles.offTag} aria-hidden="true">
                {' · OFF'}
              </span>
            )}
          </label>
          <button
            type="button"
            className={styles.resetButton}
            data-reset={gear}
            aria-label={meta.resetLabel}
            title={RESET_TITLE}
            hidden={off}
            onClick={() => {
              props.onReset();
              input.current?.focus();
            }}
          >
            <ResetIcon />
          </button>
        </div>
        {unavailable ? (
          <p className={styles.unavailable} id={hintId}>
            {unavailable}
          </p>
        ) : (
          <>
            <div className={styles.track} aria-hidden="true">
              <div className={styles.trackFill} />
              <div className={styles.trackThumb} />
            </div>
            <div className={styles.ends}>
              <span>{meta.left}</span>
              <span>{meta.right}</span>
            </div>
          </>
        )}
        <input
          ref={input}
          id={`slider-${gear}`}
          className={styles.sliderInput}
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={unavailable !== undefined}
          aria-describedby={unavailable ? hintId : undefined}
          aria-valuetext={off ? 'Off' : undefined}
          onChange={(e) => props.onInput(Number(e.currentTarget.value))}
          // A tap exactly on the default value changes nothing, so no `input` event comes: the press itself turns the gear on.
          // (A right or middle click is not a tap.)
          onPointerDown={(e) => {
            if (!off || e.button > 0) return;
            touched.current = true;
            props.onTouch();
          }}
          // If the press moved nothing, `change` never comes, so the press ends the adjustment. `change` follows
          // pointerup in the same task when the value did move, so look once that task is over. A press the browser
          // cancels (it took the gesture for a scroll) ends the same way, or the next plain tap would be counted twice.
          onPointerUp={endPress}
          onPointerCancel={endPress}
        />
      </div>
    </div>
  );
}
