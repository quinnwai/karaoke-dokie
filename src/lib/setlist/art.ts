// The numbers behind the gear art (spec §6) and the row lanes (spec §5): which colour, how tall a band, which notes
// are showing, how the metronome swings. Pure, so each rule from the spec has a test. The SVG itself is
// src/components/setlist/GearArt.tsx; it only applies what these return.

/** Difficulty tier colours. `v` is a 0 to 100 difficulty. */
export const EASY = '#4FD17A';
export const MID = '#F5B82E';
export const HARD = '#FF6B70';
// Cut at exact thirds, as the engine places Easy, Medium and Hard songs. For the whole numbers a slider holds this is the
// spec's "< 34, < 67" (spec §6); only a fractional place such as 33.4 differs, and that is a Medium song.
export const laneColor = (v: number): string => (v < 100 / 3 ? EASY : v < 200 / 3 ? MID : HARD);

/** Difficulty art (the pitch lane in a 150×80 viewBox): a band that grows with difficulty, and seven dashes in it. */
export const DASH_OFFSETS = [0.8, 0.2, -1, -0.3, 1, -0.6, -0.9] as const;

export interface LaneArt {
  color: string;
  /** The band rect: y and height, 20% opacity. */
  bandY: number;
  bandH: number;
  /** y of each of the seven dashes. */
  dashY: number[];
}

export function laneArt(difficulty: number): LaneArt {
  const bandH = 14 + difficulty * 0.62;
  return {
    color: laneColor(difficulty),
    bandY: Math.round(40 - bandH / 2),
    bandH: Math.round(bandH),
    dashY: DASH_OFFSETS.map((o) => Math.round(40 + o * (bandH / 2 - 3) - 3)),
  };
}

/**
 * History notes and Popularity bolts: seven of each, item `i` shows once the value reaches (i + 0.5) × 100 / 7.
 * Returns the opacity to draw it at.
 */
export const ITEM_COUNT = 7;
export const itemOpacity = (value: number, i: number): 0 | 1 => (value >= ((i + 0.5) * 100) / ITEM_COUNT ? 1 : 0);

export interface Metronome {
  /** Swing amplitude, degrees each side: ±20 (slow) down to ±8 (fast). */
  amplitude: number;
  /** Seconds per half-swing. */
  period: string;
  /** The keyframes name (global, in setlist-global.css) and the whole `animation` value. */
  keyframes: string;
  animation: string;
  /** How far the weight has slid down the rod. */
  weightY: number;
}

export function metronome(tempo: number): Metronome {
  const amplitude = 20 - 2 * Math.round((tempo / 100) * 6);
  const period = (60 / (50 + tempo * 1.5)).toFixed(2);
  const keyframes = `swing${amplitude}`;
  return {
    amplitude,
    period,
    keyframes,
    animation: `${keyframes} ${period}s ease-in-out infinite alternate`,
    weightY: Math.round(16 + tempo * 0.27),
  };
}

/** The mini difficulty lane at the end of each row (44×30). `d` is that song's 0 to 100 difficulty. */
export interface RowLane {
  color: string;
  bandTop: number;
  bandHeight: number;
  /** Top of each of the three dashes. */
  dashTop: [number, number, number];
}

export const ROW_DASH_OFFSETS = [0.7, -1, 0.2] as const;

export function rowLane(d: number): RowLane {
  const band = 6 + d * 0.22;
  const dashTop = (o: number) => Math.round(15 + o * (band / 2 - 1.5) - 1.5);
  return {
    color: laneColor(d),
    bandTop: Math.round(15 - band / 2),
    bandHeight: Math.round(band),
    dashTop: [dashTop(ROW_DASH_OFFSETS[0]), dashTop(ROW_DASH_OFFSETS[1]), dashTop(ROW_DASH_OFFSETS[2])],
  };
}
