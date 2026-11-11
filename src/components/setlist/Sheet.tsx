import { useRef, useState, type CSSProperties } from 'react';
import { gearColor } from '../../lib/setlist/art';
import { DRAG_START_PX, modeAfterDrag, neonVars, sheetLayout } from '../../lib/setlist/sheet';
import { GEAR_META, ERA_META } from '../../lib/setlist/gears';
import { isOn, type TunerAction } from '../../lib/setlist/tuner';
import type { GearId, TunerPart, TunerState } from '../../lib/setlist/types';
import { GEAR_IDS, TUNER_PARTS } from '../../lib/setlist/types';
import { EraPanel } from './EraPanel';
import { EraTabArt, GearArt } from './GearArt';
import { GearStrip } from './GearStrip';
import styles from './sheet.module.css';

interface SheetProps {
  tuner: TunerState;
  /** False before Spotify is connected: the History gear is then off and cannot be turned on. */
  historyAvailable: boolean;
  /** What the History strip says in the place of its end labels when it is not available. */
  historyHint: string;
  /** `SetlistResponse.total`: every song that fits the range and the picked eras, for the Era panel's header; null before the first answer. */
  songCount: number | null;
  /**
   * False where the expanded sheet cannot fit inside the screen at all (an iPhone SE with Safari's bars, a phone on its
   * side): the handle then keeps the sheet in its mini mode. The screen measures it.
   */
  canExpand: boolean;
  onTuner(action: TunerAction): void;
  onGearDone(gear: GearId): void;
}

/**
 * The bottom sheet (spec §3, §4): a grab handle, then a rack that shows every gear (expanded) or one gear and a tab bar
 * (mini). The handle switches modes by a tap, Enter or Space, or by a vertical drag that resizes the rack live.
 */
export function Sheet({ tuner, historyAvailable, historyHint, songCount, canExpand, onTuner, onGearDone }: SheetProps) {
  // How far the handle has been dragged, px (negative = up); null when idle. Only the sheet cares about it.
  const [dragY, setDragY] = useState<number | null>(null);
  const press = useRef<{ startY: number; dragged: boolean; lastDy: number } | null>(null);
  // The click that follows a drag must not toggle the mode a second time.
  const swallowClick = useRef(false);
  // A screen that cannot hold the expanded sheet keeps it in mini, whatever the tuner remembers (QWW-57, decision 1). The
  // tuner's own mode is left alone, so the sheet opens again where it was if the screen grows (a phone turned upright).
  const mini = tuner.mini || !canExpand;
  const layout = sheetLayout(mini, dragY, canExpand);
  const { compact } = layout;

  const off = (g: TunerPart) => !isOn(tuner, g) || (g === 'history' && !historyAvailable);

  const endPress = (dy: number) => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    if (p.dragged) {
      swallowClick.current = true;
      if (canExpand) onTuner({ type: 'mini', mini: modeAfterDrag(tuner.mini, dy) });
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
          aria-expanded={!mini}
          // Disabled but still focusable, so a keyboard or screen-reader user finds it and hears why nothing happens.
          aria-disabled={canExpand ? undefined : true}
          aria-label={mini ? 'Show all gears' : 'Show one gear'}
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
            if (!canExpand) return;
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
          songCount={songCount}
          hidden={compact && tuner.open !== 'era'}
          onToggle={(era) => onTuner({ type: 'era', era })}
          onReset={() => onTuner({ type: 'reset', gear: 'era' })}
        />

        <div id="tabs" className={styles.tabs} role="group" aria-label="Choose gear" hidden={!compact}>
          {TUNER_PARTS.map((g) => {
            const tabOff = off(g);
            return (
              <button
                key={g}
                type="button"
                className={styles.tab}
                data-tab=""
                data-gear={g}
                data-off={tabOff || undefined}
                aria-pressed={tuner.open === g}
                // The colour of the selected tab's border and glow. Difficulty's follows its tier, so it reads the value.
                style={neonVars(gearColor(g, tuner.difficulty)) as CSSProperties}
                onClick={() => onTuner({ type: 'open', gear: g })}
              >
                {g === 'era' ? <EraTabArt eras={tuner.eras} off={tabOff} /> : <GearArt gear={g} variant="tab" value={tuner[g]} off={tabOff} />}
                <span>{g === 'era' ? ERA_META.tab : GEAR_META[g].tab}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
