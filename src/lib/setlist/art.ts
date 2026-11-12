// The numbers behind the gear art (Round 6A §6 to §9): which colour, how tall a band, which notes are showing, how the
// metronome swings, which jukebox lights are on. Pure, so each rule from the spec has a test. The SVG itself is
// src/components/setlist/GearArt.tsx; it only applies what these return.

import { ERA_IDS, type EraId } from './types';

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
 * History notes and Popularity bolts: seven of each, item `i` lights once the value reaches (i + 0.5) × 100 / 7. The tab's
 * rays are the same seven items and use the same rule.
 */
export const ITEM_COUNT = 7;
export const itemLit = (value: number, i: number): boolean => value >= ((i + 0.5) * 100) / ITEM_COUNT;

export interface ItemArt {
  /** Lit: its gear is on and the value reaches it. */
  lit: boolean;
  /** What it is drawn in: its colour while it is lit, UNLIT otherwise. */
  color: string;
}

/**
 * How a note, a bolt or a ray is drawn (QWW-57, R7): an item the value does not reach is drawn unlit, at full opacity, like a
 * neon tube that is not turned on, instead of disappearing as the 6A reference has it. So the art keeps its whole shape and
 * only the lit items glow. A gear that is off is all unlit, as every part of it is (§7). `color` is the item's lit colour.
 */
export function itemArt(color: string, value: number, i: number, off: boolean): ItemArt {
  const lit = !off && itemLit(value, i);
  return { lit, color: tube(color, !lit) };
}

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

/** Which of the jukebox's three buttons are lit: left, middle, right (QWW-57, R24). */
export type JukeboxLit = readonly [left: boolean, middle: boolean, right: boolean];

/** How far an era is from the '90s, the jukebox's middle button: negative before them, 0 for the '90s, positive after them. */
const fromThe90s = (era: EraId): number => ERA_IDS.indexOf(era) - ERA_IDS.indexOf('s90');

/**
 * The buttons the picked eras light (QWW-57, R24). Left is before the '90s (Pre-'70s, '70s, '80s), middle is the '90s, right is
 * after them ('00s, '10s, '20s). As many buttons are lit as eras are picked, up to three:
 *
 *   picks                           lit
 *   none                            none (and Era off lights none, whatever is picked: see `jukeboxArt`)
 *   one                             its side's: the '90s middle, before them left, after them right
 *   two, one before and one after   left and right
 *   two, both the '90s or earlier   left and middle
 *   two, both the '90s or later     middle and right
 *   three or more                   all three
 *
 * The three two-pick rows cover all 21 pairs of eras. Two picks on the same side (the '70s and the '80s) are "both the '90s or
 * earlier", so they light that side and the middle.
 */
export function jukeboxLit(eras: readonly EraId[]): JukeboxLit {
  const picked = ERA_IDS.filter((era) => eras.includes(era)).map(fromThe90s);
  const before = picked.filter((d) => d < 0).length;
  const after = picked.filter((d) => d > 0).length;
  if (picked.length === 0) return [false, false, false];
  if (picked.length === 1) return [before === 1, before + after === 0, after === 1];
  if (picked.length === 2) return before === 1 && after === 1 ? [true, false, true] : after === 0 ? [true, true, false] : [false, true, true];
  return [true, true, true];
}

export interface JukeboxArt {
  /** The body, the window and the bars: pink while Era is on, UNLIT while it is off. */
  body: string;
  /**
   * The three buttons under the window, left to right: amber where lit, the unlit grey otherwise. All three are the unlit grey while
   * Era is off. (6A drew an unlit button in a dark rose, #3A2A33, which read as pink on a phone: R24, "grey, not pink".)
   */
  lights: readonly [string, string, string];
}

/**
 * The Era tab's jukebox (Round 6A §9, QWW-57 R24). The buttons are the picked eras' (`jukeboxLit`); with Era off all three are
 * the unlit grey, whatever picks are parked.
 */
export function jukeboxArt(eras: readonly EraId[], off: boolean): JukeboxArt {
  const [left, middle, right] = jukeboxLit(eras);
  const light = (lit: boolean) => tube(AMBER, off || !lit);
  return { body: tube(PINK, off), lights: [light(left), light(middle), light(right)] };
}

/** How long the strip art's turn-on flicker takes, ms: the 0.7 s of `neonFlicker`. */
export const FLICKER_MS = 700;

/**
 * The strip art's turn-on flicker (Round 6A §7), as an `animation` value: once, 0.7 s, linear, on first load and each time
 * the gear goes from off to on, and at no other time. The art sets it as an inline style, so the browser restarts it exactly
 * when the value changes from `none`, and not when only the gear's own value changes. `armed` is whether the flicker is due
 * (GearArt.tsx, StripSvg, says when); it is not due once it has played, because a browser also plays a CSS animation again
 * each time its element goes from `display: none` to shown, and the mini sheet does that to a strip on every tab switch
 * and every expand. The keyframes are global, in setlist-global.css.
 */
export const neonFlicker = (off: boolean, armed: boolean): string => (!off && armed ? `neonOn ${FLICKER_MS / 1000}s linear 1` : 'none');

/**
 * Whether the page has drawn its first strip art. Every strip drawn in the page's first commit flickers (those that are on);
 * one drawn after it does not: the singer coming back from a song, or doing the singing test again, is not a first load. The
 * page's life is this module's, so a new page starts it over. Tests start it over between cases.
 */
export const flickerSession = { done: false };
export const resetFlickerSession = (): void => {
  flickerSession.done = false;
};

/** A tab icon is drawn 34 px wide on a 28 unit grid (GearArt.tsx, TAB). */
export const TAB_PX_PER_UNIT = 34 / 28;

/** The blur of the glow around a tab icon (Round 6A §7, §9), in screen px. */
export const TAB_GLOW_PX = 3;

/**
 * The glow around a tab icon (Round 6A §7, §9): a 3 px drop-shadow in the gear's colour while it is on, none while it is off. It is a
 * CSS filter on the icon's root, so it reaches every part of the icon. Difficulty, Tempo and Era have no unlit ray and keep it;
 * History and Popularity have, and glow only what is lit with `TAB_GLOW_DEVIATION` (QWW-57, R7).
 */
export const tabGlow = (color: string, off: boolean): string => (off ? 'none' : `drop-shadow(0 0 ${TAB_GLOW_PX}px ${color})`);

/**
 * The same 3 px as the `stdDeviation` of an SVG blur inside the icon. CSS `drop-shadow(0 0 3px c)` blurs with a standard deviation
 * of 3 screen px (measured in Chromium, pixel for pixel), and a filter inside the svg counts in grid units of 34 / 28 px.
 */
export const TAB_GLOW_DEVIATION = TAB_GLOW_PX / TAB_PX_PER_UNIT;
