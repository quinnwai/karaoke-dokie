import { useRef, useState } from 'react';
import { DRAG_START_PX, modeAfterDrag, sheetLayout } from '../../lib/setlist/sheet';
import { GEAR_META, ERA_META } from '../../lib/setlist/gears';
import { isOn, type TunerAction } from '../../lib/setlist/tuner';
import type { GearId, TunerPart, TunerState } from '../../lib/setlist/types';
import { GEAR_IDS, TUNER_PARTS } from '../../lib/setlist/types';
import { EraPanel } from './EraPanel';
import { EraTabArt, GearArt } from './GearArt';
import { GearStrip } from './GearStrip';
import styles from './setlist.module.css';

interface SheetProps {
  tuner: TunerState;
  /** False before Spotify is connected: the History gear is then off and cannot be turned on. */
  historyAvailable: boolean;
  /** What the History strip says in the place of its track when it is not available. */
  historyHint: string;
  onTuner(action: TunerAction): void;
  onGearDone(gear: GearId): void;
}

/**
 * The bottom sheet (spec §3, §4): a grab handle, then a rack that shows every gear (expanded) or one gear and a tab bar
 * (mini). The handle switches modes by a tap, Enter or Space, or by a vertical drag that resizes the rack live.
 */
export function Sheet({ tuner, historyAvailable, historyHint, onTuner, onGearDone }: SheetProps) {
  // How far the handle has been dragged, px (negative = up); null when idle. Only the sheet cares about it.
  const [dragY, setDragY] = useState<number | null>(null);
  const press = useRef<{ startY: number; dragged: boolean; lastDy: number } | null>(null);
  // The click that follows a drag must not toggle the mode a second time.
  const swallowClick = useRef(false);
  const layout = sheetLayout(tuner.mini, dragY);
  const { compact } = layout;

  const off = (g: TunerPart) => !isOn(tuner, g) || (g === 'history' && !historyAvailable);

  const endPress = (dy: number) => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    if (p.dragged) {
      swallowClick.current = true;
      onTuner({ type: 'mini', mini: modeAfterDrag(tuner.mini, dy) });
    }
    setDragY(null);
  };

  return (
    <section id="sheet" className={styles.sheet} aria-label="Setlist controls" data-compact={compact || undefined}>
      <div className={styles.handleRow}>
        <button
          type="button"
          id="handle"
          className={styles.handle}
          aria-controls="rack"
          aria-expanded={!tuner.mini}
          aria-label={tuner.mini ? 'Show all gears' : 'Show one gear'}
          onPointerDown={(e) => {
            press.current = { startY: e.clientY, dragged: false, lastDy: 0 };
            swallowClick.current = false;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // A pointer that is already gone: the drag just does not start.
            }
            setDragY(0);
          }}
          onPointerMove={(e) => {
            const p = press.current;
            if (!p) return;
            const dy = e.clientY - p.startY;
            p.lastDy = dy;
            if (Math.abs(dy) > DRAG_START_PX) p.dragged = true;
            setDragY(dy);
          }}
          onPointerUp={(e) => endPress(e.clientY - (press.current?.startY ?? e.clientY))}
          // A cancelled pointer can report zeroed coordinates, so finish from where the drag last was.
          onPointerCancel={() => endPress(press.current?.lastDy ?? 0)}
          onClick={() => {
            if (swallowClick.current) {
              swallowClick.current = false;
              return;
            }
            onTuner({ type: 'mini', mini: !tuner.mini });
          }}
        >
          <span />
        </button>
      </div>

      <div id="rack" className={styles.rack} style={{ height: layout.rackHeight }} data-dragging={layout.dragging || undefined}>
        <div id="strips" className={styles.strips} hidden={compact && tuner.open === 'era'}>
          {GEAR_IDS.map((g) => (
            <GearStrip
              key={g}
              gear={g}
              value={tuner[g]}
              off={off(g)}
              hidden={compact && tuner.open !== g}
              unavailable={g === 'history' && !historyAvailable ? historyHint : undefined}
              onInput={(value) => onTuner({ type: 'input', gear: g, value })}
              onTouch={() => onTuner({ type: 'touch', gear: g })}
              onReset={() => onTuner({ type: 'reset', gear: g })}
              onDone={() => onGearDone(g)}
            />
          ))}
        </div>

        <EraPanel
          eras={tuner.eras}
          off={!isOn(tuner, 'era')}
          hidden={compact && tuner.open !== 'era'}
          onToggle={(era) => onTuner({ type: 'era', era })}
          onReset={() => onTuner({ type: 'reset', gear: 'era' })}
        />

        <div id="tabs" className={styles.tabs} role="group" aria-label="Choose gear" hidden={!compact}>
          {TUNER_PARTS.map((g) => (
            <button
              key={g}
              type="button"
              className={styles.tab}
              data-tab=""
              data-gear={g}
              data-off={off(g) || undefined}
              aria-pressed={tuner.open === g}
              onClick={() => onTuner({ type: 'open', gear: g })}
            >
              {g === 'era' ? <EraTabArt eras={tuner.eras} /> : <GearArt gear={g} variant="tab" value={tuner[g]} />}
              <span>{g === 'era' ? ERA_META.tab : GEAR_META[g].tab}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
