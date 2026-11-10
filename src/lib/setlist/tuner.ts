// The tuner's state and what each control does to it (spec §2, §4 and §4a), as a pure reducer. Nothing here ranks
// songs: it only says which gears are on, where they are set, and which eras are picked.

import { DEFAULTS } from './defaults';
import type { EraId, GearId, SetlistRequest, TunerPart, TunerState } from './types';
import type { Midi } from '../contracts';

/** The state on first load: every gear at its default value, those in `DEFAULTS.off` off. */
export function initialTuner(opts: { mini?: boolean } = {}): TunerState {
  return {
    difficulty: DEFAULTS.difficulty,
    history: DEFAULTS.history,
    popularity: DEFAULTS.popularity,
    tempo: DEFAULTS.tempo,
    eras: [...DEFAULTS.eras],
    off: [...DEFAULTS.off],
    open: DEFAULTS.open,
    mini: opts.mini ?? DEFAULTS.mini,
  };
}

export type TunerAction =
  /** A slider moved: set the gear, turn it on, make it the open gear. */
  | { type: 'input'; gear: GearId; value: number }
  /** A press landed on an off slider. A tap exactly on the default fires no `input`, so this turns the gear on. */
  | { type: 'touch'; gear: GearId }
  /** Reset: back to the default value, and off. Era goes back to the default picks. */
  | { type: 'reset'; gear: TunerPart }
  /** An Era button: toggle that era. If Era was off, the toggle applies to the default picks and Era turns on. */
  | { type: 'era'; era: EraId }
  /** A tab (mini sheet): show that part. */
  | { type: 'open'; gear: TunerPart }
  /** The handle: set the sheet mode. */
  | { type: 'mini'; mini: boolean }
  /** Tests only: set any part of the state. */
  | { type: 'patch'; patch: Partial<TunerState> };

export const isOn = (s: Pick<TunerState, 'off'>, part: TunerPart): boolean => !s.off.includes(part);
const withOff = (s: TunerState, part: TunerPart): TunerPart[] => (s.off.includes(part) ? s.off : [...s.off, part]);
const withoutOff = (s: TunerState, part: TunerPart): TunerPart[] => s.off.filter((p) => p !== part);
const toPercent = (n: number): number => Math.min(100, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

export function tunerReducer(s: TunerState, a: TunerAction): TunerState {
  switch (a.type) {
    case 'input':
      return { ...s, [a.gear]: toPercent(a.value), off: withoutOff(s, a.gear), open: a.gear };
    case 'touch':
      return isOn(s, a.gear) ? s : { ...s, off: withoutOff(s, a.gear), open: a.gear };
    case 'reset':
      if (a.gear === 'era') return { ...s, eras: [...DEFAULTS.eras], off: withOff(s, 'era'), open: 'era' };
      return { ...s, [a.gear]: DEFAULTS[a.gear], off: withOff(s, a.gear), open: a.gear };
    case 'era': {
      const eras = s.eras.includes(a.era) ? s.eras.filter((e) => e !== a.era) : [...s.eras, a.era];
      return { ...s, eras, off: withoutOff(s, 'era'), open: 'era' };
    }
    case 'open':
      return { ...s, open: a.gear };
    case 'mini':
      return { ...s, mini: a.mini };
    case 'patch':
      return { ...s, ...a.patch };
  }
}

/**
 * What the tuner sends to the ranking engine: the state as it is, and the range. The engine decides what counts (History
 * only counts once the singer's library was read) and says so in its answer.
 */
export function toRequest(s: TunerState, range: { low: Midi; high: Midi }): SetlistRequest {
  return {
    range: { low: range.low, high: range.high },
    gears: { difficulty: s.difficulty, history: s.history, popularity: s.popularity, tempo: s.tempo },
    off: [...s.off],
    eras: [...s.eras],
  };
}
