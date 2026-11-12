import { useEffect, useRef, type CSSProperties } from 'react';
import { PINK } from '../../lib/setlist/art';
import { ERA_LABEL, ERA_OFF_NOTE } from '../../lib/setlist/eras';
import { ERA_META, RESET_TITLE } from '../../lib/setlist/gears';
import { pressWasOn, trackPresses } from '../../lib/setlist/rawPress';
import { neonVars } from '../../lib/setlist/sheet';
import type { EraId } from '../../lib/setlist/types';
import { ERA_IDS } from '../../lib/setlist/types';
import { EraIcon } from './GearArt';
import { TurnOffIcon } from './GearStrip';
import styles from './sheet.module.css';

interface EraPanelProps {
  eras: EraId[];
  off: boolean;
  hidden: boolean;
  onToggle(era: EraId): void;
  onReset(): void;
}

/**
 * The multi-select Era picker (spec §4, §4a; Round 6A §8). The header says "ERA", and "OFF · all eras" while Era is off; the
 * song count is the screen header's (R19). Off, a default pick would show dashed ("parked") instead of lit and counts for
 * nothing: every era is in the list. Unpicking the last era turns Era off (R23), so it is never on with nothing picked.
 */
export function EraPanel({ eras, off, hidden, onToggle, onReset }: EraPanelProps) {
  const grid = useRef<HTMLDivElement>(null);
  // Every press in the document is noted where it began, for the clicks below.
  useEffect(() => trackPresses(), []);
  return (
    <div
      id="era-panel"
      className={styles.eraPanel}
      role="group"
      aria-labelledby="era-label"
      data-off={off || undefined}
      hidden={hidden}
      style={neonVars(PINK) as CSSProperties}
    >
      <div className={styles.gearHead}>
        <span className={styles.eyebrow} id="era-label">
          {ERA_META.eyebrow}
          {off && (
            <>
              {' '}
              <span className={styles.eraNote} data-off-note="">
                {ERA_OFF_NOTE}
              </span>
            </>
          )}
        </span>
        <button
          type="button"
          className={styles.resetButton}
          data-reset="era"
          aria-label={ERA_META.resetLabel}
          title={RESET_TITLE}
          hidden={off}
          onClick={(e) => {
            // The ✕'s only if the finger pressed on it: the browser may hand it the click of a tap that was beside it (QWW-57, R33, the gate on 1ee41b4).
            if (e.detail > 0 && !pressWasOn(e.currentTarget)) return;
            onReset();
            // The button hides itself, so focus goes to the first era button rather than being lost.
            grid.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }}
        >
          <TurnOffIcon />
        </button>
      </div>
      <div ref={grid} className={styles.eraGrid}>
        {ERA_IDS.map((era) => {
          const picked = eras.includes(era);
          return (
            <button
              key={era}
              type="button"
              className={styles.eraButton}
              data-era={era}
              data-parked={(off && picked) || undefined}
              aria-pressed={!off && picked}
              onClick={(e) => {
                // An era's only if the finger pressed on it, give or take 2 px (half the gap between two): a double tap on the ✕ puts its second tap where the ✕ has
                // gone, a few px above the eras, and the browser hands that to the nearest era, which turned Era back on with the '20s picked (the gate on 1ee41b4).
                if (e.detail > 0 && !pressWasOn(e.currentTarget, 2)) return;
                onToggle(era);
              }}
            >
              <EraIcon era={era} />
              <span>{ERA_LABEL[era]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
