// The art rules from Round 6A §6 (gear art), §7 (the off state) and §9 (the Era tab's jukebox), with the numbers the spec
// gives. The numbers the reference's own view model draws are checked, tempo by tempo and value by value, in gearArt.test.tsx.

import { describe, expect, it } from 'vitest';
import {
  AMBER,
  BAND_OPACITY,
  CYAN,
  EASY,
  HARD,
  ITEM_COUNT,
  LIGHT_OFF,
  MID,
  NOTE_PINK,
  PINK,
  UNLIT,
  VIOLET,
  gearColor,
  itemArt,
  itemLit,
  jukeboxArt,
  laneArt,
  laneColor,
  metronome,
  neonFlicker,
  noteColor,
  tabGlow,
  tube,
} from '../../src/lib/setlist/art';

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
    expect(LIGHT_OFF).toBe('#3A2A33');
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

describe('the Era tab jukebox (Round 6A §9, test 27)', () => {
  // [picked eras, Era off] -> body, left light, right light
  const CASES: Array<{ picked: number; off: boolean; body: string; lights: [string, string] }> = [
    { picked: 0, off: false, body: '#FF4FA0', lights: ['#3A2A33', '#3A2A33'] },
    { picked: 1, off: false, body: '#FF4FA0', lights: ['#FFC24A', '#3A2A33'] },
    { picked: 2, off: false, body: '#FF4FA0', lights: ['#FFC24A', '#FFC24A'] },
    { picked: 3, off: false, body: '#FF4FA0', lights: ['#FFC24A', '#FFC24A'] },
    { picked: 7, off: false, body: '#FF4FA0', lights: ['#FFC24A', '#FFC24A'] },
    // Era off: the body is unlit and both lights are dark, whatever picks are parked.
    { picked: 0, off: true, body: '#34313D', lights: ['#3A2A33', '#3A2A33'] },
    { picked: 1, off: true, body: '#34313D', lights: ['#3A2A33', '#3A2A33'] },
    { picked: 3, off: true, body: '#34313D', lights: ['#3A2A33', '#3A2A33'] },
  ];

  it.each(CASES)('$picked picked, Era off: $off -> body $body, lights $lights', ({ picked, off, body, lights }) => {
    expect(jukeboxArt(picked, off)).toEqual({ body, lights });
  });
});

describe('the turn-on flicker and the tab glow (Round 6A §7, §9)', () => {
  it('plays neonOn once for 0.7 s, linear, while a gear is on, and not at all while it is off', () => {
    expect(neonFlicker(false)).toBe('neonOn 0.7s linear 1');
    expect(neonFlicker(true)).toBe('none');
  });

  it('glows a tab icon with a 3 px drop-shadow in its colour while on, and not at all while off', () => {
    expect(tabGlow(CYAN, false)).toBe('drop-shadow(0 0 3px #4FDDE8)');
    expect(tabGlow(CYAN, true)).toBe('none');
  });
});
