import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { gearColor } from '../../lib/setlist/art';
import { pointIsOn, pressWasOn, trackPresses } from '../../lib/setlist/rawPress';
import { DRAG_START_PX, modeAfterDrag, neonVars, sheetLayout } from '../../lib/setlist/sheet';
import { GEAR_META, ERA_META, SHEET_GEARS, SHEET_PARTS } from '../../lib/setlist/gears';
import { isOn, type TunerAction } from '../../lib/setlist/tuner';
import type { GearId, TunerPart, TunerState } from '../../lib/setlist/types';
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
export function Sheet({ tuner, historyAvailable, historyHint, canExpand, onTuner, onGearDone }: SheetProps) {
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

  // Every press in the document is noted where it began, for the handle's click (below).
  useEffect(() => trackPresses(), []);

  // What a drag that turns out to be a swipe up or down puts back (GearStrip's `onRevert`): the gear's value, whether it was on, and which part was open. The first
  // change a gear's press makes saves them, and the end of the adjustment lets them go.
  const undo = useRef<Partial<Record<GearId, Partial<TunerState>>>>({});
  const remember = (g: GearId) => {
    undo.current[g] ??= { [g]: tuner[g], off: tuner.off, open: tuner.open };
  };

  const endPress = (dy: number) => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    if (p.dragged) {
      swallowClick.current = true;
      // The click a mouse drag ends in follows in the same task; a touch drag has none, and its flag used to wait for the next click, which was the first Enter or screen
      // reader's activation after it (the gate on 4e324f5).
      window.setTimeout(() => {
        swallowClick.current = false;
      }, 0);
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
            // Only a press on the handle is the handle's, by where the finger is: its box ends 1 px above the first strip's title, and Chromium hands a touch within a finger's
            // reach of it to it, so a tap on the top of the title, from a big finger, used to fold the sheet (the gates on 1ee41b4 and 5ab0be7).
            if (!pointIsOn(e.currentTarget, e.clientX, e.clientY)) return;
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
          onClick={(e) => {
            if (e.detail > 0 && !pressWasOn(e.currentTarget)) return;
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
          {/* Sheet order, not the contract's: Listening History goes last (R11). */}
          {SHEET_GEARS.map((g) => (
            <GearStrip
              key={g}
              gear={g}
              value={tuner[g]}
              off={off(g)}
              hidden={compact && tuner.open !== g}
              unavailable={g === 'history' && !historyAvailable ? historyHint : undefined}
              onInput={(value) => {
                remember(g);
                onTuner({ type: 'input', gear: g, value });
              }}
              onTouch={() => {
                remember(g);
                onTuner({ type: 'touch', gear: g });
              }}
              onReset={() => onTuner({ type: 'reset', gear: g })}
              onDone={() => {
                delete undo.current[g];
                onGearDone(g);
              }}
              onRevert={() => {
                const back = undo.current[g];
                delete undo.current[g];
                if (back) onTuner({ type: 'patch', patch: back });
              }}
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
          {SHEET_PARTS.map((g) => {
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
                // The colour of the selected tab's border and glow, and of an idle tab's border while it is hovered (R10).
                // Difficulty's follows its tier, so it reads the value.
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
