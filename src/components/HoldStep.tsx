import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { midiToNoteName } from '../lib/audio/notes';
import { SCALE_HIGH, SCALE_LOW, scalePosition } from '../lib/client/display';
import type { HoldStatus } from '../lib/client/flow';
import { Lyric } from './Lyric';
import styles from './screen.module.css';

interface HoldStepProps {
  kind: 'low' | 'high';
  status: HoldStatus;
  /** Live pitch while holding (MIDI), null when nothing is heard. */
  live: number | null;
  /** Detected low note, shown small on the high step. */
  lowNote: string | null;
  onPress(): void;
  onRelease(): void;
}

function lyricFor(kind: 'low' | 'high', status: HoldStatus): string {
  switch (status) {
    case 'short':
      return 'Try again and hold the note a little longer';
    case 'order':
      return kind === 'low' ? 'That was higher than your high note. Go lower' : 'That was lower than your low note. Go higher';
    case 'denied':
      return 'We need your mic to hear you';
    default:
      return kind === 'low' ? 'Hold the button and sing your lowest note' : 'Now hold and sing your highest note';
  }
}

const TICKS = Array.from({ length: (SCALE_HIGH - SCALE_LOW) / 12 + 1 }, (_, i) => SCALE_LOW + i * 12);

export function HoldStep({ kind, status, live, lowNote, onPress, onRelease }: HoldStepProps) {
  const down = useRef(false);
  const holding = status === 'holding';

  const press = () => {
    if (down.current) return;
    down.current = true;
    onPress();
  };
  const release = () => {
    if (!down.current) return;
    down.current = false;
    onRelease();
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {}
    press();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) press();
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    release();
  };

  const label = kind === 'low' ? 'Hold to record your lowest note' : 'Hold to record your highest note';

  return (
    <div className={styles.holdStep}>
      <div className={styles.holdText}>
        <Lyric text={lyricFor(kind, status)} />
        {status === 'denied' && (
          <p className={styles.hint}>Allow microphone access in your browser, then press again.</p>
        )}
      </div>

      <div className={styles.holdCenter}>
        <button
          type="button"
          className={`${styles.holdButton} ${holding ? styles.holding : ''}`}
          aria-label={label}
          aria-pressed={holding}
          onPointerDown={onPointerDown}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={release}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className={styles.holdDot} aria-hidden />
        </button>
        <p className={styles.holdCaption} aria-hidden>
          {holding ? 'listening' : 'hold'}
        </p>
      </div>

      <div className={styles.scale} aria-hidden={!holding} role="img" aria-label={live !== null ? `Hearing ${midiToNoteName(live)}` : 'Pitch scale'}>
        {TICKS.map((m) => (
          <span key={m} className={styles.tick} style={{ bottom: `${scalePosition(m)}%` }}>
            {midiToNoteName(m)}
          </span>
        ))}
        {holding && live !== null && (
          <span className={styles.pitchDot} style={{ bottom: `${scalePosition(live)}%` }} data-testid="live-pitch">
            <span className={styles.pitchNote}>{midiToNoteName(live)}</span>
          </span>
        )}
      </div>

      {lowNote && (
        <p className={styles.noteChip}>
          low <strong data-testid="low-note">{lowNote}</strong>
        </p>
      )}
    </div>
  );
}
