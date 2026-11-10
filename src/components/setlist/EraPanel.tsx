import { useRef } from 'react';
import { ERA_LABEL } from '../../lib/setlist/eras';
import { ERA_META, RESET_TITLE } from '../../lib/setlist/gears';
import type { EraId } from '../../lib/setlist/types';
import { ERA_IDS } from '../../lib/setlist/types';
import { EraIcon } from './GearArt';
import { ResetIcon } from './GearStrip';
import styles from './setlist.module.css';

interface EraPanelProps {
  eras: EraId[];
  off: boolean;
  hidden: boolean;
  onToggle(era: EraId): void;
  onReset(): void;
}

/**
 * The multi-select Era picker (spec §4, §4a). Off, the default picks show outlined ("parked") instead of filled and
 * count for nothing: every era is in the list. On with nothing picked, the list is empty.
 */
export function EraPanel({ eras, off, hidden, onToggle, onReset }: EraPanelProps) {
  const grid = useRef<HTMLDivElement>(null);
  return (
    <div id="era-panel" className={styles.eraPanel} role="group" aria-labelledby="era-label" data-off={off || undefined} hidden={hidden}>
      <div className={styles.gearHead}>
        <span className={styles.eyebrow} id="era-label">
          {ERA_META.eyebrow}
          {off && (
            <span className={styles.offTag} aria-hidden="true">
              {' · OFF'}
            </span>
          )}
        </span>
        <button
          type="button"
          className={styles.resetButton}
          data-reset="era"
          aria-label={ERA_META.resetLabel}
          title={RESET_TITLE}
          hidden={off}
          onClick={() => {
            onReset();
            // The button hides itself, so focus goes to the first era button rather than being lost.
            grid.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }}
        >
          <ResetIcon />
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
              onClick={() => onToggle(era)}
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
