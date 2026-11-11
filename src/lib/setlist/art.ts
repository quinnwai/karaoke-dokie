// The numbers behind the gear art (Round 6A §6 to §9): which colour, how tall a band, which notes are showing, how the
// metronome swings, which jukebox lights are on. Pure, so each rule from the spec has a test. The SVG itself is
// src/components/setlist/GearArt.tsx; it only applies what these return.

/**
 * The neon palette (Round 6A §3.1). The names are the design's tokens; the screen's CSS carries the same values as
 * custom properties, and the art draws with these because an SVG attribute cannot read a CSS variable that a test can see.
 */
export const UNLIT = '#34313D'; // an unlit neon tube: what an off gear's art is drawn in
export const PINK = '#FF4FA0'; // Era, lit selections, the mic
export const CYAN = '#4FDDE8'; // History
export const AMBER = '#FFC24A'; // Popularity, the Era jukebox lights, Difficulty's middle tier
export const VIOLET = '#B583FF'; // Tempo

/** Difficulty tier colours. `v` is a 0 to 100 difficulty. */
export const EASY = '#4DE89A';
export const MID = AMBER;
export const HARD = '#FF5A8A';
// Cut at exact thirds, as the engine places Easy, Medium and Hard songs. For the whole numbers a slider holds this is the
// spec's "< 34, < 67" (spec §6); only a fractional place such as 33.4 differs, and that is a Medium song.
export const laneColor = (v: number): string => (v < 100 / 3 ? EASY : v < 200 / 3 ? MID : HARD);

/**
 * The colour a part is lit in (Round 6A §3.1, "Gear colours"): Difficulty takes its tier from its own value, History is
 * cyan, Popularity amber, Tempo violet and Era pink. `difficulty` is the Difficulty gear's 0 to 100 value; only that
 * part reads it.
 */
export function gearColor(part: 'difficulty' | 'history' | 'popularity' | 'tempo' | 'era', difficulty: number): string {
  switch (part) {
    case 'difficulty':
      return laneColor(difficulty);
    case 'history':
      return CYAN;
    case 'popularity':
      return AMBER;
    case 'tempo':
      return VIOLET;
    case 'era':
      return PINK;
  }
}

/**
 * What a part of an off gear's art is drawn in (Round 6A §7): every tube is unlit, whatever colour it would have been lit
 * in. The art keeps its shape and its value (the gear's default) and just goes dark, like a switched-off neon sign.
 */
export const tube = (color: string, off: boolean): string => (off ? UNLIT : color);

/** Difficulty art (the pitch lane in a 150×80 viewBox): a band that grows with difficulty, and seven dashes in it. */
export const DASH_OFFSETS = [0.8, 0.2, -1, -0.3, 1, -0.6, -0.9] as const;

/** The band behind the dashes is a faint wash: 12% of the colour (Round 6A §6; Round 5 drew it at 20%). */
export const BAND_OPACITY = 0.12;

export interface LaneArt {
  /** The band and the dashes: the tier colour, or UNLIT while the gear is off. */
  color: string;
  /** The band rect: y and height. */
  bandY: number;
  bandH: number;
  /** The band's fill opacity: 12%, or 0 while the gear is off (the band is hidden, §7). */
  bandOpacity: number;
  /** y of each of the seven dashes. A dash is a round-capped line now, so this is where the line runs, not a rect's top. */
  dashY: number[];
}

export function laneArt(difficulty: number, off = false): LaneArt {
  const bandH = 14 + difficulty * 0.62;
  return {
    color: tube(laneColor(difficulty), off),
    bandY: Math.round(40 - bandH / 2),
    bandH: Math.round(bandH),
    bandOpacity: off ? 0 : BAND_OPACITY,
    dashY: DASH_OFFSETS.map((o) => Math.round(40 + o * (bandH / 2 - 3))),
  };
}

/**
 * History notes and Popularity bolts: seven of each, item `i` shows once the value reaches (i + 0.5) × 100 / 7.
 * Returns the opacity to draw it at. The tab's rays are the same seven items and use the same rule.
 */
export const ITEM_COUNT = 7;
export const itemOpacity = (value: number, i: number): 0 | 1 => (value >= ((i + 0.5) * 100) / ITEM_COUNT ? 1 : 0);

/**
 * Which History notes are pink; the rest are cyan (Round 6A §6). Round 5's red notes are pink here and its dark notes cyan,
 * in Round 5's order. The tab's rays take their note's colour.
 */
export const NOTE_PINK = [false, true, true, false, false, true, false] as const;
export const noteColor = (i: number): string => (NOTE_PINK[i] ? PINK : CYAN);

export interface Metronome {
  /** Swing amplitude, degrees each side: ±20 (slow) down to ±8 (fast). */
  amplitude: number;
  /** Beats per minute, whole: the half-swing is timed from this. */
  bpm: number;
  /** Seconds per half-swing. */
  period: string;
  /** The keyframes name (global, in setlist-global.css). */
  keyframes: string;
  /** The whole `animation` value. `none` while the gear is off: an unlit metronome stands still (Round 6A §7). */
  animation: string;
  /** y of the weight on the strip's rod, which runs from y 56 (the pivot) up to y 16. */
  weightY: number;
  /** y of the weight on the tab's rod, to one decimal as a string ("9.9"): the tab is drawn on a 28×22 grid. */
  tabWeightY: string;
  /** The metronome's tube: violet, or UNLIT while the gear is off. */
  color: string;
}

export function metronome(tempo: number, off = false): Metronome {
  const amplitude = 20 - 2 * Math.round((tempo / 100) * 6);
  // The 6A reference rounds the bpm before it takes the period (README §6; Round 5's reference did not). The two agree at 0,
  // 45, 50, 55 and 100 and differ by 0.01 s or 0.02 s at ten other tempos; this follows 6A.
  const bpm = Math.round(50 + tempo * 1.5);
  const period = (60 / bpm).toFixed(2);
  const keyframes = `swing${amplitude}`;
  return {
    amplitude,
    bpm,
    period,
    keyframes,
    animation: off ? 'none' : `${keyframes} ${period}s ease-in-out infinite alternate`,
    weightY: Math.round(18 + tempo * 0.27),
    tabWeightY: (6 + tempo * 0.07).toFixed(1),
    color: tube(VIOLET, off),
  };
}

/** A jukebox light that is not lit (Round 6A §9): a dark rose, not the grey of an unlit body. */
export const LIGHT_OFF = '#3A2A33';

export interface JukeboxArt {
  /** The body, the window and the bars: pink while Era is on, UNLIT while it is off. */
  body: string;
  /** The two lights under the window, left then right. */
  lights: readonly [string, string];
}

/**
 * The Era tab's jukebox (Round 6A §9). `picked` is how many eras are picked. With Era on, the left light is amber for one
 * era or more and the right one for two or more; with Era off both are dark, whatever is parked.
 */
export function jukeboxArt(picked: number, off: boolean): JukeboxArt {
  const light = (needs: number) => (!off && picked >= needs ? AMBER : LIGHT_OFF);
  return { body: tube(PINK, off), lights: [light(1), light(2)] };
}

/**
 * The strip art's turn-on flicker (Round 6A §7), as an `animation` value: once, 0.7 s, linear, on first load and each time
 * the gear goes from off to on. The art sets it as an inline style, so the browser restarts it exactly when the value
 * changes from `none`, and not when only the gear's own value changes. The keyframes are global, in setlist-global.css.
 */
export const neonFlicker = (off: boolean): string => (off ? 'none' : 'neonOn 0.7s linear 1');

/** The glow around a tab icon (Round 6A §7, §9): a 3 px drop-shadow in the gear's colour while it is on, none while it is off. */
export const tabGlow = (color: string, off: boolean): string => (off ? 'none' : `drop-shadow(0 0 3px ${color})`);
