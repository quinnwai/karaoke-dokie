import { useEffect, useId, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { gearColor } from '../../lib/setlist/art';
import { faderValue, touchIntent } from '../../lib/setlist/fader';
import { GEAR_META, RESET_TITLE } from '../../lib/setlist/gears';
import { neonVars } from '../../lib/setlist/sheet';
import type { GearId } from '../../lib/setlist/types';
import { GearArt } from './GearArt';
import styles from './sheet.module.css';

interface GearStripProps {
  gear: GearId;
  /** The gear's value. While it is off this is the default, drawn unlit. */
  value: number;
  off: boolean;
  /** Not drawn (the mini sheet shows one gear). */
  hidden: boolean;
  /**
   * Set when the gear cannot be used at all (History before Spotify is connected, or when the library could not be read):
   * the gear is drawn off, with its track, and this says why in the place of the end labels.
   */
  unavailable?: string;
  onInput(value: number): void;
  /** A press landed on the fader while it was off. */
  onTouch(): void;
  onReset(): void;
  /** One adjustment ended: the thumb was let go, or a key or swipe stepped the value. */
  onDone(): void;
}

/**
 * The ✕ that turns a gear off (QWW-57, R21): the spec drew a counterclockwise reset arrow here, but the button does not undo anything,
 * it takes the gear out of the ranking, so it says so. 2 px stroke, in the colour of the text, drawn 16 px by the button.
 */
export function TurnOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6L18 18M18 6L6 18" />
    </svg>
  );
}

/** One finger, pen or mouse button down on a fader (QWW-57, R33). */
interface Press {
  id: number;
  /** Where it landed, to tell a drag from a scroll. */
  x: number;
  y: number;
  /** A finger waits to see which way it goes, since it may be a scroll; a mouse or a pen is on the fader at once. */
  touch: boolean;
  /** It is on the fader: the gear is on and the value follows it. */
  live: boolean;
  /** It went up or down, so the browser takes it for a scroll: the fader leaves it alone. */
  scrolling: boolean;
  /** The last value it sent, so a drag sends each step once. */
  sent: number;
  /** It turned the gear on or moved it, which makes it one adjustment when it ends. */
  changed: boolean;
}

/**
 * One slider gear: its neon art, its label with a reset button, a custom track, a transparent hit area over it that takes the pointer
 * (R33), and the real `<input type="range">` under that, invisible, for the keyboard and screen readers (spec §8). Off, the gear is a
 * switched-off sign (Round 6A §7): unlit art, a dark knob at the default value and no fill, until it is touched.
 */
export function GearStrip(props: GearStripProps) {
  const { gear, value, off, hidden, unavailable } = props;
  const meta = GEAR_META[gear];
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const press = useRef<Press | null>(null);
  const handlers = useRef(props);
  useEffect(() => {
    handlers.current = props;
  });

  // The browser's `change` event ends one adjustment by the keyboard or a screen reader: a key step or a swipe.
  // (`input` fires on every step. A press on the fader never sets the input's own value, so it sends neither.)
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const done = () => handlers.current.onDone();
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);

  // What a press does once it is on the fader: an off gear is turned on (a press that lands exactly on its default moves nothing,
  // so this is what says so), and the value follows the pointer, each step once, as the input's own `input` events used to.
  const grip = (p: Press, e: ReactPointerEvent<HTMLElement>) => {
    if (!p.live) {
      p.live = true;
      if (off) {
        p.changed = true;
        props.onTouch();
      }
    }
    const area = e.currentTarget.getBoundingClientRect();
    const next = faderValue(e.clientX, area.left, area.width);
    if (next === p.sent) return;
    p.sent = next;
    p.changed = true;
    props.onInput(next);
  };

  // A press ends when its pointer goes: the thumb let go, or the browser took the touch. It is one adjustment if it did anything.
  const release = () => {
    const p = press.current;
    press.current = null;
    if (p?.changed) props.onDone();
  };

  return (
    // The strip carries the gear's lit colour for its label, fill and glow (an off strip ignores it, §7). Its border is the
    // rail's grey whatever the state (R5), so the colour does not reach it.
    <div
      className={styles.strip}
      data-strip=""
      data-gear={gear}
      data-off={off || undefined}
      hidden={hidden}
      style={neonVars(gearColor(gear, value)) as CSSProperties}
    >
      <GearArt gear={gear} variant="strip" value={value} off={off} className={styles.gearArt} />
      <div className={styles.stripBody} style={{ '--pct': `${value}%` } as CSSProperties}>
        <div className={styles.gearHead}>
          <label className={styles.eyebrow} htmlFor={`slider-${gear}`}>
            {meta.eyebrow}
            {/* A gear that cannot be used at all says why under its track, so it does not say " · OFF" as well (R6). */}
            {off && !unavailable && (
              <span className={styles.offTag} data-offtag="" aria-hidden="true">
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
            <TurnOffIcon />
          </button>
        </div>
        {/* The data-* hooks are stable names for the browser tests, which read computed styles and cannot see CSS-module classes. */}
        <div className={styles.track} aria-hidden="true">
          <div className={styles.trackFill} data-fill="" />
          <div className={styles.knob} data-knob="" />
          {/* The fader's hit area (R33): the pointer goes here and not to the input, which takes a touch only on its own small thumb. A
              mouse or a pen jumps the value to the pointer and drags; a finger that lands waits to see which way it goes, and only a sideways
              one (or a tap) moves it, so a swipe up or down scrolls and leaves the gear alone. A gear that cannot be used has none. */}
          {!unavailable && (
            <div
              className={styles.faderHit}
              data-fader=""
              onPointerDown={(e) => {
                // A right or middle click is not a press, and a second finger is not the first one's.
                if (e.button > 0 || (press.current && press.current.id !== e.pointerId)) return;
                const p: Press = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', live: false, scrolling: false, sent: value, changed: false };
                press.current = p;
                // A mouse or a pen leaves the focus on the slider, as a native one took it, so the arrow keys carry on from the press (a finger has no keys).
                if (!p.touch) input.current?.focus({ preventScroll: true });
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // A pointer that is already gone: the press just does not follow it outside the area.
                }
                if (!p.touch) grip(p, e);
              }}
              onPointerMove={(e) => {
                const p = press.current;
                if (!p || p.id !== e.pointerId || p.scrolling) return;
                if (!p.live) {
                  const intent = touchIntent(e.clientX - p.x, e.clientY - p.y);
                  if (intent === 'wait') return;
                  if (intent === 'scroll') {
                    p.scrolling = true;
                    return;
                  }
                }
                grip(p, e);
              }}
              onPointerUp={(e) => {
                const p = press.current;
                if (!p || p.id !== e.pointerId) return;
                // A finger that never went far is a tap: the thumb jumps to where it lifted.
                if (!p.live && !p.scrolling) grip(p, e);
                release();
              }}
              onPointerCancel={(e) => {
                if (press.current?.id === e.pointerId) release();
              }}
            />
          )}
        </div>
        {unavailable ? (
          <p className={styles.unavailable} id={hintId} data-ends="hint">
            {unavailable}
          </p>
        ) : (
          <div className={styles.ends} data-ends="">
            <span>{meta.left}</span>
            <span>{meta.right}</span>
          </div>
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
        />
      </div>
    </div>
  );
}
