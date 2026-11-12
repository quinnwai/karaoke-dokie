import { useEffect, useId, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { gearColor } from '../../lib/setlist/art';
import { dragStanding, faderValue, liftsOnTheFader, touchIntent } from '../../lib/setlist/fader';
import { GEAR_META, RESET_TITLE } from '../../lib/setlist/gears';
import { pressWasOn, trackPresses } from '../../lib/setlist/rawPress';
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
  /** A drag that had put the gear on or moved it turned out to be a swipe up or down: put the gear back as it was, and record nothing. */
  onRevert(): void;
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
  /** A finger waits to see which way it goes, since it may be a scroll (touchIntent); a mouse or a pen is on the fader at once. */
  touch: boolean;
  /** It is on the fader: the gear is on and the value follows it. */
  live: boolean;
  /** The drag it was called stands for good (dragStanding): it follows the finger wherever it goes now. Until then it can be taken back. */
  final: boolean;
  /** It went up or down, so the browser takes it for a scroll: the fader leaves it alone. */
  scrolling: boolean;
  /** The last value it sent, so a drag sends each step once. */
  sent: number;
  /** It turned the gear on or moved it, which makes it one adjustment when it ends. */
  changed: boolean;
}

/**
 * One slider gear: its neon art, its label with a reset button, a custom track, a transparent hit area over it that marks where the pointer
 * is the fader's (R33), and the real `<input type="range">` under that, invisible, for the keyboard and screen readers (spec §8). Off, the
 * gear is a switched-off sign (Round 6A §7): unlit art, a dark knob at the default value and no fill, until it is touched.
 *
 * The pointer is read at the strip's body, by where the finger is, and not by the element that is named. Chromium hands the pointer events and the click of a
 * touch with a radius to a button or label near it (the ✕, the title), a little more than the radius away, so a press in the fader's area was named for the
 * ✕ or the title and a press outside it was named for the fader; the position stays the finger's (QWW-57, R33, the gate on 1ee41b4).
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

  // Every press in the document is noted where it began, for the ✕'s click (below).
  useEffect(() => trackPresses(), []);
  // The fader's hit area, whose box says where a press is the fader's.
  const hit = useRef<HTMLDivElement>(null);
  // The title, a label for the slider (what a click on it does is the browser's way of giving the slider the focus, below).
  const title = useRef<HTMLLabelElement>(null);
  // A mouse or pen press on the fader has not yet given the slider the focus its click will give it (see `afterClick`).
  const focusAfterClick = useRef(false);

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
  const grip = (p: Press, x: number) => {
    const area = hit.current?.getBoundingClientRect();
    if (!area) return;
    if (!p.live) {
      p.live = true;
      if (off) {
        p.changed = true;
        props.onTouch();
      }
    }
    const next = faderValue(x, area.left, area.width);
    if (next === p.sent) return;
    p.sent = next;
    p.changed = true;
    props.onInput(next);
  };

  // A drag that was called early and then turned up or down is a scroll after all (dragStanding): the gear goes back as it was, and nothing is recorded.
  const revoke = (p: Press) => {
    p.scrolling = true;
    p.live = false;
    if (p.changed) {
      p.changed = false;
      props.onRevert();
    }
  };

  // A press ends when its pointer goes: the thumb let go, or the browser took the touch. It is one adjustment if it did anything.
  const release = () => {
    const p = press.current;
    press.current = null;
    if (p?.changed) props.onDone();
  };

  const pointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only a press that is in the fader's area (by where it is, whichever element the browser names) is the fader's.
    const area = hit.current?.getBoundingClientRect();
    if (!area || e.clientX < area.left || e.clientX >= area.right || e.clientY < area.top || e.clientY >= area.bottom) return;
    // A right or middle click is not a press, and a second finger is not the first one's.
    if (e.button > 0 || (press.current && press.current.id !== e.pointerId)) return;
    const p: Press = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', live: false, final: false, scrolling: false, sent: value, changed: false };
    press.current = p;
    focusAfterClick.current = !p.touch;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone: the press just does not follow it outside the strip.
    }
    if (!p.touch) grip(p, e.clientX);
  };

  const pointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId || p.scrolling) return;
    if (p.touch) {
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.live) {
        const intent = touchIntent(dx, dy);
        if (intent === 'wait') return;
        if (intent === 'scroll') {
          p.scrolling = true;
          return;
        }
      }
      // The drag that was called stands once the finger has gone far enough sideways, and is taken back if the finger turns up or down before that.
      if (!p.final) {
        const standing = dragStanding(dx, dy);
        if (standing === 'revoke') {
          revoke(p);
          return;
        }
        if (standing === 'final') p.final = true;
      }
    }
    grip(p, e.clientX);
  };

  const pointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    // A finger that never went far is a tap: the thumb jumps to where it lifted. So does one that lifts after a short drag; a short swipe up
    // or down presses nothing.
    if (!p.live && !p.scrolling && liftsOnTheFader(e.clientX - p.x, e.clientY - p.y)) grip(p, e.clientX);
    release();
  };

  const pointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (press.current?.id === e.pointerId) release();
  };

  // The slider is given the focus when a mouse press on the fader ends in its click, and as a mouse's: where the browser does that for a label, by a click on the title
  // (Chromium focuses the control of a label as a mouse's focus, and then `:focus-visible` is false until a key is pressed; a script's `focus()` shows the keyboard
  // ring in Chromium and WebKit alike, and Chromium has no `focusVisible: false`). WebKit does not focus a slider for a label, so there the slider gets it with
  // `focusVisible: false`, which WebKit has. A finger has no keys, and a key (Tab) is the browser's own.
  const afterClick = () => {
    if (!focusAfterClick.current) return;
    focusAfterClick.current = false;
    const el = input.current;
    if (!el || document.activeElement === el) return;
    title.current?.click();
    if (document.activeElement !== el) el.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
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
      <div
        className={styles.stripBody}
        style={{ '--pct': `${value}%` } as CSSProperties}
        onPointerDown={unavailable ? undefined : pointerDown}
        onPointerMove={unavailable ? undefined : pointerMove}
        onPointerUp={unavailable ? undefined : pointerUp}
        onPointerCancel={unavailable ? undefined : pointerCancel}
        onClick={unavailable ? undefined : afterClick}
      >
        <div className={styles.gearHead}>
          <label ref={title} className={styles.eyebrow} htmlFor={`slider-${gear}`}>
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
            onClick={(e) => {
              // A click is the ✕'s only if the finger pressed on it: the browser may hand it the click of a tap that was elsewhere, on the fader above all (a
              // finger's tap near the thumb, or a second tap of a double tap on the ✕, which has gone by then). A key or a screen reader's click has no
              // press (`detail` 0) and counts.
              if (e.detail > 0 && !pressWasOn(e.currentTarget)) return;
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
          {/* The fader's hit area (R33): where a press is the fader's, which the strip's pointer handlers above go by. The pointer is not taken here and not by the
              input, which takes a touch only on its own small thumb. A mouse or a pen jumps the value to the pointer and drags; a finger that lands waits to see which
              way it goes, and only a sideways one (or a tap) moves it, so a swipe up or down scrolls and leaves the gear alone. A gear that cannot be used has none.
              A click on it gives the slider the focus as a mouse's (see `afterClick`): the arrow keys carry on from the click, as they did with the native slider, and
              the knob shows no keyboard ring until a key is pressed. */}
          {!unavailable && <div ref={hit} className={styles.faderHit} data-fader="" />}
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
