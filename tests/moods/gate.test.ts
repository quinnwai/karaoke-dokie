import { describe, expect, it } from 'vitest';
import type { Mood } from '../../src/lib/contracts';
import { GATE, gateMoods, labellerAgreement, runAgreement, scoreMood, seededOrder, shippedMoods, sourcesAgreement, splitGold } from '../../src/lib/moods/gate';
import type { GoldSet, GoldSong } from '../../src/lib/moods/gold';
import type { MoodLabel } from '../../src/lib/moods/label';

/** 40 gold songs: every 4th is heartfelt (a lopsided label), every other one upbeat. */
const goldSongs: GoldSong[] = Array.from({ length: 40 }, (_, i) => ({
  key: `artist ${i}|song ${i}`,
  artist: `Artist ${i}`,
  title: `Song ${i}`,
  upbeat: i % 2 === 0,
  heartfelt: i % 4 === 0,
}));
const gold: GoldSet = { labelledBy: 'Quinn-Wai', labelledAt: '2026-11-05', songs: goldSongs };
const { tune, heldOut } = splitGold(goldSongs);

/** What a labeller ships, from a rule per song. */
const shipped = (rule: (g: GoldSong) => Mood[]) => new Map(goldSongs.map((g) => [g.key, rule(g)]));
const perfect = shipped((g) => (['upbeat', 'heartfelt'] as Mood[]).filter((m) => g[m]));

describe('splitGold', () => {
  it('splits into halves by a seeded order, whatever order the songs come in', () => {
    expect(tune).toHaveLength(20);
    expect(heldOut).toHaveLength(20);
    const again = splitGold([...goldSongs].reverse());
    expect(again.heldOut.map((s) => s.key)).toEqual(heldOut.map((s) => s.key));
    expect(new Set([...tune, ...heldOut].map((s) => s.key)).size).toBe(40);
    expect(splitGold(goldSongs, 'another seed').heldOut.map((s) => s.key)).not.toEqual(heldOut.map((s) => s.key));
    expect(splitGold(goldSongs.slice(0, 5)).heldOut).toHaveLength(3);
  });

  it('seededOrder is stable for a seed and not the input order', () => {
    const keys = goldSongs.map((s) => s.key);
    const ordered = seededOrder(keys, 'x', (k) => k);
    expect(seededOrder([...keys].reverse(), 'x', (k) => k)).toEqual(ordered);
    expect(ordered).not.toEqual(keys);
  });
});

describe('scoreMood', () => {
  it('counts right and wrong yes answers; a song with no label counts as no', () => {
    const songs = goldSongs.slice(0, 8); // upbeat: 0 2 4 6
    const said = new Map<string, Mood[]>([
      [songs[0]!.key, ['upbeat']],
      [songs[1]!.key, ['upbeat']],
      [songs[2]!.key, []],
      [songs[3]!.key, ['heartfelt']],
    ]);
    expect(scoreMood(songs, said, 'upbeat')).toEqual({ tp: 1, fp: 1, fn: 3, tn: 3, precision: 0.5, recall: 0.25 });
    expect(scoreMood(songs, new Map(), 'upbeat')).toEqual({ tp: 0, fp: 0, fn: 4, tn: 4, precision: null, recall: 0 });
  });

  it('shippedMoods leaves out songs the model did not know', () => {
    const labels: MoodLabel[] = [
      { key: 'a|1', known: true, upbeat: true, heartfelt: true },
      { key: 'a|2', known: true, upbeat: false, heartfelt: false },
      { key: 'a|3', known: false, upbeat: true, heartfelt: false },
    ];
    expect([...shippedMoods(labels)]).toEqual([['a|1', ['upbeat', 'heartfelt']], ['a|2', []]]);
  });
});

describe('gateMoods', () => {
  it('passes a mood that clears both bars on the held-out half in every one of 3 runs', () => {
    const result = gateMoods(gold, [perfect, perfect, perfect]);
    expect(result.map((r) => [r.mood, r.pass])).toEqual([['upbeat', true], ['heartfelt', true]]);
    expect(result[0]!.heldOut).toHaveLength(3);
    expect(result[0]!.heldOut[0]).toMatchObject({ precision: 1, recall: 1 });
    expect(result[0]!.tune[0]).toMatchObject({ precision: 1, recall: 1 });
    expect(result[0]!.failures).toEqual([]);
  });

  it('fails a constant "no" and a constant "yes", which a 50% accuracy bar would not', () => {
    const never = shipped(() => []);
    const always = shipped(() => ['upbeat', 'heartfelt']);
    const [upNever, heartNever] = gateMoods(gold, [never, never, never]);
    expect(heartNever!.pass).toBe(false);
    expect(heartNever!.failures).toContain('run 1: held-out precision none, needs 0.8');
    expect(heartNever!.failures).toContain('run 1: held-out recall 0.00, needs 0.4');
    expect(upNever!.pass).toBe(false);
    const heartAlways = gateMoods(gold, [always, always, always])[1]!;
    expect(heartAlways.pass).toBe(false);
    expect(heartAlways.heldOut[0]!.recall).toBe(1);
    expect(heartAlways.heldOut[0]!.precision).toBeLessThan(GATE.minPrecision);
  });

  it('must hold in every run, and reports which run failed', () => {
    const heldKeys = new Set(heldOut.map((s) => s.key));
    // Run 2 also says Heartfelt for every held-out upbeat song that is not heartfelt.
    const sloppy = shipped((g) => {
      const moods = (['upbeat', 'heartfelt'] as Mood[]).filter((m) => g[m]);
      return heldKeys.has(g.key) && g.upbeat && !g.heartfelt ? [...moods, 'heartfelt'] : moods;
    });
    const [up, heart] = gateMoods(gold, [perfect, sloppy, perfect]);
    expect(up!.pass).toBe(true);
    expect(heart!.pass).toBe(false);
    expect(heart!.failures).toHaveLength(1);
    expect(heart!.failures[0]).toMatch(/^run 2: held-out precision 0\.\d\d, needs 0\.8$/);
    expect(heart!.heldOut.map((s) => s.precision)).toEqual([1, heart!.heldOut[1]!.precision, 1]);
  });

  it('scores the tune half separately: mistakes there do not change the gate', () => {
    const tuneKeys = new Set(tune.map((s) => s.key));
    const wrongOnTune = shipped((g) => (tuneKeys.has(g.key) ? ['upbeat', 'heartfelt'] : (['upbeat', 'heartfelt'] as Mood[]).filter((m) => g[m])));
    const [up] = gateMoods(gold, [wrongOnTune, wrongOnTune, wrongOnTune]);
    expect(up!.pass).toBe(true);
    expect(up!.tune[0]!.precision).toBeLessThan(1);
  });

  it('needs 3 runs', () => {
    const [up] = gateMoods(gold, [perfect]);
    expect(up!.pass).toBe(false);
    expect(up!.failures).toEqual(['needs 3 labelling runs, got 1']);
  });

  it('drops a mood the two labellers agree on less than 80% of the time', () => {
    const second: GoldSet = {
      labelledBy: 'Second',
      labelledAt: '2026-11-06',
      songs: goldSongs.slice(0, 30).map((s, i) => ({ ...s, heartfelt: i < 9 ? !s.heartfelt : s.heartfelt, upbeat: i < 3 ? !s.upbeat : s.upbeat })),
    };
    expect(labellerAgreement(goldSongs, second.songs, 'upbeat')).toEqual({ songs: 30, agree: 27, rate: 0.9 });
    expect(labellerAgreement(goldSongs, second.songs, 'heartfelt')).toEqual({ songs: 30, agree: 21, rate: 0.7 });
    const [up, heart] = gateMoods(gold, [perfect, perfect, perfect], second);
    expect(up!.pass).toBe(true);
    expect(heart!.pass).toBe(false);
    expect(heart!.failures).toEqual(['the two labellers agree on 0.70 of 30 songs, needs 0.8']);
  });
});

describe('runAgreement', () => {
  const l = (key: string, known: boolean, upbeat = false, heartfelt = false): MoodLabel => ({ key, known, upbeat, heartfelt });

  it('counts songs labelled the same in every run, overall and per chip', () => {
    const runs = [
      [l('a', true, true), l('b', true, false, true), l('c', false), l('d', true), l('only1', true)],
      [l('a', true, true), l('b', true, true, true), l('c', true), l('d', true)],
      [l('a', true, true), l('b', true, false, true), l('c', false, true), l('d', true)],
    ];
    expect(runAgreement(runs)).toEqual({
      songs: 4,
      // a and d always match; b's upbeat flips; c is unknown, then known with no moods.
      same: 2,
      // c shows no chip in any run, so it counts as stable per chip.
      sameByMood: { upbeat: 3, heartfelt: 4 },
      shownByMood: { upbeat: [1, 2, 1], heartfelt: [1, 1, 1] },
    });
    expect(runAgreement([])).toEqual({ songs: 0, same: 0, sameByMood: { upbeat: 0, heartfelt: 0 }, shownByMood: { upbeat: [], heartfelt: [] } });
  });
});

describe('sourcesAgreement', () => {
  const said = (rows: [string, Mood[]][]) => new Map(rows);

  it('counts songs all sources agree on, and pairwise agreement beyond chance (kappa), over songs every source labels', () => {
    const a = said([['s1', ['upbeat']], ['s2', ['upbeat']], ['s3', []], ['s4', []], ['only-a', ['upbeat']]]);
    const b = said([['s1', ['upbeat']], ['s2', []], ['s3', []], ['s4', ['heartfelt']]]);
    const c = said([['s1', ['upbeat']], ['s2', ['upbeat']], ['s3', []], ['s4', ['upbeat']], ['only-c', []]]);
    const r = sourcesAgreement([a, b, c], 'upbeat');
    expect(r.songs).toBe(4);
    expect(r.allAgree).toBe(2);
    expect(r.pairs.map((p) => [p.a, p.b, p.agree])).toEqual([[0, 1, 3], [0, 2, 3], [1, 2, 2]]);
    expect(r.pairs.map((p) => p.kappa)).toEqual([0.5, 0.5, expect.closeTo(0.2, 10)]);
  });

  it('has no kappa when both sources say the same thing about every song', () => {
    const same = said([['s1', []], ['s2', []]]);
    expect(sourcesAgreement([same, same], 'heartfelt').pairs[0]).toEqual({ a: 0, b: 1, agree: 2, kappa: null });
    expect(sourcesAgreement([same, said([])], 'heartfelt')).toEqual({ songs: 0, allAgree: 0, pairs: [{ a: 0, b: 1, agree: 0, kappa: null }] });
  });
});
