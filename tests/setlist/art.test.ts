// The art rules from Round 6A §6 (gear art), §7 (the off state) and §9 (the Era tab's jukebox, QWW-57 R24), with the numbers the spec
// gives. The numbers the reference's own view model draws are checked, tempo by tempo and value by value, in gearArt.test.tsx.

import { describe, expect, it } from 'vitest';
import {
  AMBER,
  BAND_OPACITY,
  CYAN,
  EASY,
  FLICKER_MS,
  HARD,
  ITEM_COUNT,
  MID,
  NOTE_PINK,
  PINK,
  TAB_GLOW_DEVIATION,
  TAB_GLOW_PX,
  TAB_PX_PER_UNIT,
  UNLIT,
  VIOLET,
  flickerSession,
  gearColor,
  itemArt,
  itemLit,
  jukeboxArt,
  jukeboxLit,
  laneArt,
  laneColor,
  metronome,
  neonFlicker,
  noteColor,
  resetFlickerSession,
  tabGlow,
  tube,
} from '../../src/lib/setlist/art';
import { ERA_IDS, type EraId } from '../../src/lib/setlist/types';

describe('the palette (Round 6A §3.1)', () => {
  it('has the neon tokens', () => {
    expect({ UNLIT, PINK, CYAN, AMBER, VIOLET, EASY, HARD }).toEqual({
      UNLIT: '#34313D',
      PINK: '#FF4FA0',
      CYAN: '#4FDDE8',
      AMBER: '#FFC24A',
      VIOLET: '#B583FF',
      EASY: '#4DE89A',
      HARD: '#FF5A8A',
    });
    // Difficulty's middle tier is the same amber as Popularity's bolts.
    expect(MID).toBe(AMBER);
  });

  it('lights each part in its colour: Difficulty by its tier, History cyan, Popularity amber, Tempo violet, Era pink (§3.1)', () => {
    expect([gearColor('difficulty', 10), gearColor('difficulty', 50), gearColor('difficulty', 90)]).toEqual([EASY, MID, HARD]);
    expect([gearColor('history', 10), gearColor('popularity', 10), gearColor('tempo', 10), gearColor('era', 10)]).toEqual([
      CYAN,
      AMBER,
      VIOLET,
      PINK,
    ]);
    // Only Difficulty reads the number.
    expect(gearColor('history', 90)).toBe(CYAN);
  });

  it('draws a tube in its colour when its gear is on and unlit when it is off (§7)', () => {
    expect(tube(CYAN, false)).toBe(CYAN);
    expect(tube(CYAN, true)).toBe(UNLIT);
    expect([PINK, AMBER, VIOLET, EASY].map((color) => tube(color, true))).toEqual([UNLIT, UNLIT, UNLIT, UNLIT]);
  });
});

describe('laneColor (Round 6A §3.1, §6)', () => {
  it('is green below 34, amber below 67 and pink-red from there, for the whole numbers a slider holds', () => {
    expect([0, 1, 33].map(laneColor)).toEqual([EASY, EASY, EASY]);
    expect([34, 50, 66].map(laneColor)).toEqual([MID, MID, MID]);
    expect([67, 100].map(laneColor)).toEqual([HARD, HARD]);
  });

  it('cuts at exact thirds, the thirds the engine places Easy, Medium and Hard songs in: 33.4 is Medium and 66.7 is Hard', () => {
    // A row's place has a decimal, and a song at 33.4 is in the Medium third. For whole numbers this is the spec's 34 and 67.
    expect([33.3, 33.33].map(laneColor)).toEqual([EASY, EASY]);
    expect([33.4, 33.9].map(laneColor)).toEqual([MID, MID]);
    expect([66.6, 66.66].map(laneColor)).toEqual([MID, MID]);
    expect([66.7, 66.9].map(laneColor)).toEqual([HARD, HARD]);
    // The cuts themselves belong to the next tier up: 100 / 3 is amber, 200 / 3 is pink-red.
    expect([100 / 3, 200 / 3].map(laneColor)).toEqual([MID, HARD]);
  });

  it("agrees with a whole number's tier at every whole number from 0 to 100, as the spec's cuts do", () => {
    const spec = (v: number) => (v < 34 ? EASY : v < 67 ? MID : HARD);
    for (let v = 0; v <= 100; v++) expect(laneColor(v), `at ${v}`).toBe(spec(v));
  });
});

describe('difficulty art (Round 6A §6)', () => {
  it('draws a band of 14 + difficulty × 0.62 around y = 40', () => {
    // 20 -> 26.4 high, top 40 - 13.2 = 26.8
    expect(laneArt(20)).toMatchObject({ bandH: 26, bandY: 27, color: EASY });
    // 0 -> 14 high; 100 -> 76 high
    expect(laneArt(0)).toMatchObject({ bandH: 14, bandY: 33 });
    expect(laneArt(100)).toMatchObject({ bandH: 76, bandY: 2, color: HARD });
  });

  it('washes the band at 12%, where Round 5 had 20%', () => {
    expect(BAND_OPACITY).toBe(0.12);
    expect(laneArt(60).bandOpacity).toBe(0.12);
  });

  it('puts seven dashes at round(40 + o × (bandH / 2 - 3)), with no further offset: they are round-capped lines now, not rects', () => {
    // difficulty 60: bandH = 51.2, so y = round(40 + o × 22.6), o = 0.8, 0.2, -1, -0.3, 1, -0.6, -0.9
    expect(laneArt(60).dashY).toEqual([58, 45, 17, 33, 63, 26, 20]);
    // difficulty 30 (the README's mock default): bandH = 32.6, so y = round(40 + o × 13.3)
    expect(laneArt(30).dashY).toEqual([51, 43, 27, 36, 53, 32, 28]);
    expect(laneArt(30)).toMatchObject({ bandY: 24, bandH: 33 });
  });

  it('spreads the dashes wider as the song gets harder', () => {
    const spread = (d: number) => Math.max(...laneArt(d).dashY) - Math.min(...laneArt(d).dashY);
    expect(spread(100)).toBeGreaterThan(spread(60));
    expect(spread(60)).toBeGreaterThan(spread(0));
  });

  it("draws the band and the dashes in the gear's tier colour, the one gearColor gives (§3.1)", () => {
    for (const d of [0, 33, 34, 66, 67, 100]) expect(laneArt(d).color, `at ${d}`).toBe(gearColor('difficulty', d));
    expect(laneArt(60).color).toBe(MID);
  });

  it('draws an off gear unlit with its band hidden, and its dashes where its value puts them (§7)', () => {
    const off = laneArt(60, true);
    expect(off).toMatchObject({ color: UNLIT, bandOpacity: 0 });
    expect({ ...off, color: '', bandOpacity: 0 }).toEqual({ ...laneArt(60), color: '', bandOpacity: 0 });
    expect(laneArt(60, false)).toEqual(laneArt(60));
  });
});

describe('history notes and popularity bolts (Round 6A §1, §6; QWW-57, R7)', () => {
  it('lights item i once the value reaches (i + 0.5) × 100 / 7', () => {
    expect(ITEM_COUNT).toBe(7);
    const lit = (v: number) => [0, 1, 2, 3, 4, 5, 6].map((i) => itemLit(v, i));
    expect(lit(0)).toEqual([false, false, false, false, false, false, false]);
    expect(lit(7)).toEqual([false, false, false, false, false, false, false]); // threshold of the first is 7.14
    expect(lit(8)).toEqual([true, false, false, false, false, false, false]);
    expect(lit(50)).toEqual([true, true, true, true, false, false, false]);
    expect(lit(100)).toEqual([true, true, true, true, true, true, true]);
  });

  it('lights five notes at 65 and six bolts at 80, the README mock defaults (§6, test 26)', () => {
    const lit = (v: number) => [0, 1, 2, 3, 4, 5, 6].filter((i) => itemLit(v, i)).length;
    expect(lit(65)).toBe(5);
    expect(lit(80)).toBe(6);
  });

  it('draws an item the value does not reach unlit, at full strength, and one it reaches in its own colour (R7)', () => {
    // Popularity at 30: the first two bolts are lit, the other five are the unlit tube's colour, not gone.
    const bolts = [0, 1, 2, 3, 4, 5, 6].map((i) => itemArt(AMBER, 30, i, false));
    expect(bolts.map((b) => b.lit)).toEqual([true, true, false, false, false, false, false]);
    expect(bolts.map((b) => b.color)).toEqual([AMBER, AMBER, UNLIT, UNLIT, UNLIT, UNLIT, UNLIT]);
    // History at 65: five notes lit, in their own colours (pink or cyan), and the last two unlit.
    const notes = [0, 1, 2, 3, 4, 5, 6].map((i) => itemArt(noteColor(i), 65, i, false));
    expect(notes.map((n) => n.lit)).toEqual([true, true, true, true, true, false, false]);
    expect(notes.map((n) => n.color)).toEqual([CYAN, PINK, PINK, CYAN, CYAN, UNLIT, UNLIT]);
  });

  it('lights nothing of a gear that is off, whatever its value: it is all unlit, as every part of an off gear is (§7)', () => {
    for (const value of [0, 30, 65, 100]) {
      for (const i of [0, 1, 2, 3, 4, 5, 6]) expect(itemArt(CYAN, value, i, true), `item ${i} at ${value}`).toEqual({ lit: false, color: UNLIT });
    }
    // Its tubes are drawn exactly as every other part of an off gear is.
    expect(itemArt(AMBER, 100, 0, true).color).toBe(tube(AMBER, true));
    expect(itemArt(AMBER, 100, 0, false).color).toBe(tube(AMBER, false));
  });

  it("colours the notes pink or cyan in the reference's order: Round 5's red notes are pink and its dark notes cyan (§6)", () => {
    expect(NOTE_PINK).toEqual([false, true, true, false, false, true, false]);
    expect([0, 1, 2, 3, 4, 5, 6].map(noteColor)).toEqual([CYAN, PINK, PINK, CYAN, CYAN, PINK, CYAN]);
  });
});

describe('metronome (Round 6A §6, Round 5 test 12)', () => {
  it('Tempo 55 swings ±14° with a half-swing of 0.45 s', () => {
    expect(metronome(55)).toMatchObject({
      amplitude: 14,
      keyframes: 'swing14',
      period: '0.45',
      animation: 'swing14 0.45s ease-in-out infinite alternate',
    });
  });

  it('swings ±20° at the slow end and ±8° at the fast end', () => {
    expect(metronome(0)).toMatchObject({ amplitude: 20, keyframes: 'swing20', period: '1.20' });
    expect(metronome(100)).toMatchObject({ amplitude: 8, keyframes: 'swing8', period: '0.30' });
  });

  it('times the half-swing from a whole bpm, bpm = round(50 + 1.5 × tempo), as the 6A reference does', () => {
    expect(metronome(55).bpm).toBe(133); // 132.5 rounds up
    expect(metronome(0).bpm).toBe(50);
    expect(metronome(100).bpm).toBe(200);
    // At tempo 1 the bpm is 51.5, so 52, and 60 / 52 is 1.15 (an unrounded 60 / 51.5 would give 1.17).
    expect(metronome(1)).toMatchObject({ bpm: 52, period: '1.15' });
    expect(metronome(63)).toMatchObject({ bpm: 145, period: '0.41' });
  });

  it('slides the strip weight down the rod as tempo rises: y = round(18 + tempo × 0.27)', () => {
    expect(metronome(0).weightY).toBe(18);
    expect(metronome(45).weightY).toBe(30);
    expect(metronome(55).weightY).toBe(33);
    expect(metronome(100).weightY).toBe(45);
  });

  it('puts the tab weight at 6 + tempo × 0.07, to one decimal, as a string: 9.9 at tempo 55 (test 28)', () => {
    expect(metronome(55).tabWeightY).toBe('9.9');
    expect(metronome(0).tabWeightY).toBe('6.0');
    expect(metronome(50).tabWeightY).toBe('9.5');
    expect(metronome(100).tabWeightY).toBe('13.0');
    for (let t = 0; t <= 100; t++) expect(metronome(t).tabWeightY, `at ${t}`).toBe((6 + t * 0.07).toFixed(1));
  });

  it('is violet while on and, while off, unlit and still, at the default value it is drawn at (§7, test 25)', () => {
    expect(metronome(55).color).toBe(VIOLET);
    expect(metronome(55, false).animation).toBe('swing14 0.45s ease-in-out infinite alternate');
    const off = metronome(55, true);
    expect(off).toMatchObject({ color: UNLIT, animation: 'none' });
    // Everything else is the value's, so the unlit metronome keeps its shape.
    expect({ ...off, color: '', animation: '' }).toEqual({ ...metronome(55), color: '', animation: '' });
  });

  it('only uses keyframes that exist', () => {
    const names = new Set([20, 18, 16, 14, 12, 10, 8].map((n) => `swing${n}`));
    for (let t = 0; t <= 100; t++) expect(names.has(metronome(t).keyframes)).toBe(true);
  });
});

describe('the Era tab jukebox (Round 6A §9, test 27; QWW-57, R24)', () => {
  // The table of R24. Left is before the '90s (Pre-'70s, '70s, '80s), middle is the '90s, right is after them ('00s, '10s, '20s).
  type Button = 'left' | 'middle' | 'right';
  /** The buttons a row of the table says are lit, as [left, middle, right]. */
  const lit = (...buttons: Button[]): [boolean, boolean, boolean] => [buttons.includes('left'), buttons.includes('middle'), buttons.includes('right')];
  /** Every set of eras that can be picked: the 128 subsets of the seven. */
  const subsets = ERA_IDS.reduce<EraId[][]>((all, era) => [...all, ...all.map((set) => [...set, era])], [[]]);

  it('lights none when none is picked', () => {
    expect(jukeboxLit([])).toEqual(lit());
  });

  it.each<[EraId, Button]>([
    ['pre', 'left'],
    ['s70', 'left'],
    ['s80', 'left'],
    ['s90', 'middle'],
    ['s00', 'right'],
    ['s10', 'right'],
    ['s20', 'right'],
  ])('lights one button for one pick: %s lights %s', (era, button) => {
    expect(jukeboxLit([era])).toEqual(lit(button));
  });

  // The three two-pick rows, for all 21 pairs written out: one before and one after the '90s (9 pairs) is left and right, both the
  // '90s or earlier (6) is left and middle, both the '90s or later (6) is middle and right.
  const PAIRS: Array<[EraId, EraId, Button[]]> = [
    ['pre', 's70', ['left', 'middle']],
    ['pre', 's80', ['left', 'middle']],
    ['pre', 's90', ['left', 'middle']],
    ['s70', 's80', ['left', 'middle']],
    ['s70', 's90', ['left', 'middle']],
    ['s80', 's90', ['left', 'middle']],
    ['pre', 's00', ['left', 'right']],
    ['pre', 's10', ['left', 'right']],
    ['pre', 's20', ['left', 'right']],
    ['s70', 's00', ['left', 'right']],
    ['s70', 's10', ['left', 'right']],
    ['s70', 's20', ['left', 'right']],
    ['s80', 's00', ['left', 'right']],
    ['s80', 's10', ['left', 'right']],
    ['s80', 's20', ['left', 'right']],
    ['s90', 's00', ['middle', 'right']],
    ['s90', 's10', ['middle', 'right']],
    ['s90', 's20', ['middle', 'right']],
    ['s00', 's10', ['middle', 'right']],
    ['s00', 's20', ['middle', 'right']],
    ['s10', 's20', ['middle', 'right']],
  ];

  it('has a row for each of the 21 pairs of eras, and no other', () => {
    const every = ERA_IDS.flatMap((a, i) => ERA_IDS.slice(i + 1).map((b) => `${a}+${b}`));
    expect(every).toHaveLength(21);
    expect(PAIRS.map(([a, b]) => `${a}+${b}`).sort()).toEqual(every.sort());
  });

  it.each(PAIRS)('lights two buttons for two picks: %s and %s light %j, whichever is picked first', (a, b, buttons) => {
    expect(jukeboxLit([a, b])).toEqual(lit(...buttons));
    expect(jukeboxLit([b, a])).toEqual(lit(...buttons));
  });

  it('lights all three for three or more picks, whichever they are: all 99 sets of three to seven eras', () => {
    const many = subsets.filter((set) => set.length >= 3);
    expect(many).toHaveLength(99);
    for (const eras of many) expect(jukeboxLit(eras), eras.join()).toEqual(lit('left', 'middle', 'right'));
  });

  it('lights as many buttons as eras are picked, up to three, and does not mind the order they were picked in', () => {
    for (const eras of subsets) {
      expect(jukeboxLit(eras).filter(Boolean), eras.join()).toHaveLength(Math.min(eras.length, 3));
      expect(jukeboxLit([...eras].reverse()), eras.join()).toEqual(jukeboxLit(eras));
    }
  });

  it('draws a lit button amber and an unlit one in the unlit grey, on a pink body, while Era is on', () => {
    expect(jukeboxArt(['s90'], false)).toEqual({ body: PINK, lights: [UNLIT, AMBER, UNLIT] });
    expect(jukeboxArt(['s80', 's00'], false)).toEqual({ body: PINK, lights: [AMBER, UNLIT, AMBER] });
    expect(jukeboxArt(['s70', 's80'], false)).toEqual({ body: PINK, lights: [AMBER, AMBER, UNLIT] });
    expect(jukeboxArt(['s00', 's20'], false)).toEqual({ body: PINK, lights: [UNLIT, AMBER, AMBER] });
    expect(jukeboxArt([...ERA_IDS], false)).toEqual({ body: PINK, lights: [AMBER, AMBER, AMBER] });
    // Era on with nothing picked, which the engine still answers ("no-era-picked"), though unpicking cannot get there (R23): nothing lit.
    expect(jukeboxArt([], false)).toEqual({ body: PINK, lights: [UNLIT, UNLIT, UNLIT] });
  });

  it('is the unlit grey all over while Era is off, whatever picks are parked: all three buttons grey, none pink or amber, and not 6A\'s dark rose', () => {
    for (const eras of subsets) {
      const art = jukeboxArt(eras, true);
      expect(art, eras.join()).toEqual({ body: UNLIT, lights: [UNLIT, UNLIT, UNLIT] });
      expect(art.lights, eras.join()).not.toContain('#3A2A33');
    }
  });
});

describe('the turn-on flicker and the tab glow (Round 6A §7, §9)', () => {
  it('plays neonOn once for 0.7 s, linear, while a gear is on and the flicker is due, and not at all otherwise', () => {
    expect(neonFlicker(false, true)).toBe('neonOn 0.7s linear 1');
    // Off: unlit, nothing plays, whether or not the next turn-on is due.
    expect(neonFlicker(true, true)).toBe('none');
    expect(neonFlicker(true, false)).toBe('none');
    // On but not due: it has played, so showing the strip again must not play it again.
    expect(neonFlicker(false, false)).toBe('none');
  });

  it('is as long as the animation it asks for: FLICKER_MS is the 0.7 s of its duration', () => {
    const [name, duration, easing, count] = neonFlicker(false, true).split(' ');
    expect([name, easing, count]).toEqual(['neonOn', 'linear', '1']);
    expect(Number.parseFloat(duration ?? '') * 1000).toBe(FLICKER_MS);
    expect(FLICKER_MS).toBe(700);
  });

  it('remembers that the page has drawn its first strip art, until it is told to start over', () => {
    resetFlickerSession();
    expect(flickerSession).toEqual({ done: false });
    flickerSession.done = true;
    expect(flickerSession.done).toBe(true);
    resetFlickerSession();
    expect(flickerSession.done).toBe(false);
  });

  it('glows a tab icon with a 3 px drop-shadow in its colour while on, and not at all while off', () => {
    expect(tabGlow(CYAN, false)).toBe('drop-shadow(0 0 3px #4FDDE8)');
    expect(tabGlow(CYAN, true)).toBe('none');
  });

  // QWW-57, R7: the History and Popularity tab icons glow only what is lit, with an SVG filter inside the icon, which counts in the
  // grid's units. The same 3 px blur is 3 divided by the px a unit takes on screen: the icon is 34 px wide on a 28 unit grid.
  it('has the tab glow\'s 3 px blur as 2.47 grid units for an SVG filter: a unit is 34 / 28 px on screen', () => {
    expect(TAB_GLOW_PX).toBe(3);
    expect(TAB_PX_PER_UNIT).toBeCloseTo(1.2143, 4);
    expect(TAB_GLOW_DEVIATION).toBeCloseTo(2.4706, 4);
    expect(TAB_GLOW_DEVIATION * TAB_PX_PER_UNIT).toBeCloseTo(3, 10);
  });
});
