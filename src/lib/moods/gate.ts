// The precision gate for mood labels (QWW-11). A mood ships as a chip only when its labels are
// shown to be right on songs a person labelled by hand. A chip lives or dies on precision: when
// it says Heartfelt, the songs under it must be heartfelt. Recall has a floor too, so a labeller
// that almost never says yes cannot pass on a few easy songs.
// The gold set is split in two halves by a fixed seed: prompts and thresholds are tuned on one
// half and scored on the other, and the score must hold in every labelling run (Quinn-Wai's rule
// that LLM evals run 2 or 3 times; all runs are reported, not the best one). When a second person
// labelled some of the same songs and the two agree on a mood less often than the precision bar,
// the bar is above what people manage, so the mood is dropped rather than tuned against noise.

import { MOODS, type Mood } from '../contracts';
import type { GoldSet, GoldSong } from './gold';
import { moodsOf, type MoodLabel } from './label';

export const GATE = {
  minPrecision: 0.8,
  minRecall: 0.4,
  minAgreement: 0.8,
  /** Separate labelling runs the gate needs (QWW-11 asks for 3). */
  minRuns: 3,
  splitSeed: 'moods-gold-split-v1',
} as const;

/** FNV-1a: a small string hash that is the same on every machine. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Items in a fixed pseudo-random order for the seed, independent of the order they came in. */
export function seededOrder<T>(items: readonly T[], seed: string, id: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, id: id(item), h: hash32(`${seed}|${id(item)}`) }))
    .sort((a, b) => a.h - b.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ item }) => item);
}

/** The two halves of the gold set: tune on the first, gate on the held-out one (the larger when odd). */
export function splitGold<T extends { key: string }>(songs: readonly T[], seed: string = GATE.splitSeed): { tune: T[]; heldOut: T[] } {
  const ordered = seededOrder(songs, seed, (s) => s.key);
  const half = Math.floor(ordered.length / 2);
  return { tune: ordered.slice(0, half), heldOut: ordered.slice(half) };
}

/** What a run would ship: the moods of each song the model knew. Unknown songs have no entry. */
export function shippedMoods(labels: readonly MoodLabel[]): Map<string, Mood[]> {
  return new Map(labels.filter((l) => l.known).map((l) => [l.key, moodsOf(l)]));
}

export interface MoodScore {
  /** Said yes and the gold set says yes; said yes wrongly; missed; rightly left out. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Null when there is nothing to divide by (no yes answers, or no gold yes). */
  precision: number | null;
  recall: number | null;
}

/** A song with no label counts as "no", as it would in the app. */
export function scoreMood(gold: readonly GoldSong[], shipped: ReadonlyMap<string, readonly Mood[]>, mood: Mood): MoodScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const g of gold) {
    const said = shipped.get(g.key)?.includes(mood) ?? false;
    if (said && g[mood]) tp++;
    else if (said) fp++;
    else if (g[mood]) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}

export interface Agreement {
  /** Songs both people labelled, and how many of them they labelled the same. */
  songs: number;
  agree: number;
  rate: number | null;
}

export function labellerAgreement(a: readonly GoldSong[], b: readonly GoldSong[], mood: Mood): Agreement {
  const other = new Map(b.map((s) => [s.key, s]));
  let songs = 0;
  let agree = 0;
  for (const s of a) {
    const t = other.get(s.key);
    if (!t) continue;
    songs++;
    if (s[mood] === t[mood]) agree++;
  }
  return { songs, agree, rate: songs ? agree / songs : null };
}

export interface MoodGate {
  mood: Mood;
  pass: boolean;
  /** Why it failed; empty when it passed. */
  failures: string[];
  /** One score per labelling run: on the held-out half (the gate), and on the tune half (for tuning only). */
  heldOut: MoodScore[];
  tune: MoodScore[];
  /** Between the gold set and the second labeller, when there is one. */
  agreement: Agreement | null;
}

const show = (n: number | null) => (n === null ? 'none' : n.toFixed(2));

/** Scores every run against the gold set and decides, per mood, whether it may ship. */
export function gateMoods(gold: GoldSet, runs: readonly ReadonlyMap<string, readonly Mood[]>[], second: GoldSet | null = null): MoodGate[] {
  const { tune, heldOut } = splitGold(gold.songs, GATE.splitSeed);
  return MOODS.map((mood) => {
    const held = runs.map((r) => scoreMood(heldOut, r, mood));
    const failures: string[] = [];
    if (runs.length < GATE.minRuns) failures.push(`needs ${GATE.minRuns} labelling runs, got ${runs.length}`);
    held.forEach((s, i) => {
      if (s.precision === null || s.precision < GATE.minPrecision) {
        failures.push(`run ${i + 1}: held-out precision ${show(s.precision)}, needs ${GATE.minPrecision}`);
      }
      if (s.recall === null || s.recall < GATE.minRecall) {
        failures.push(`run ${i + 1}: held-out recall ${show(s.recall)}, needs ${GATE.minRecall}`);
      }
    });
    const agreement = second ? labellerAgreement(gold.songs, second.songs, mood) : null;
    if (agreement && (agreement.rate === null || agreement.rate < GATE.minAgreement)) {
      failures.push(`the two labellers agree on ${show(agreement.rate)} of ${agreement.songs} songs, needs ${GATE.minAgreement}`);
    }
    return { mood, pass: failures.length === 0, failures, heldOut: held, tune: runs.map((r) => scoreMood(tune, r, mood)), agreement };
  });
}

export interface RunAgreement {
  /** Songs labelled in every run. */
  songs: number;
  /** Of those, songs that got the same label every time: same known flag and, when known, the same moods. */
  same: number;
  /** Songs whose chip would be the same in every run (an unknown song has no chip). */
  sameByMood: Record<Mood, number>;
  /** Per run, how many songs it would show under each chip. */
  shownByMood: Record<Mood, number[]>;
}

/** How stable labelling is across runs, over the songs every run labelled. */
export function runAgreement(runs: readonly (readonly MoodLabel[])[]): RunAgreement {
  const maps = runs.map((r) => new Map(r.map((l) => [l.key, l])));
  const keys = [...(maps[0]?.keys() ?? [])].filter((k) => maps.every((m) => m.has(k)));
  const outcome = (l: MoodLabel) => (l.known ? `known ${l.upbeat} ${l.heartfelt}` : 'unknown');
  const sameByMood = Object.fromEntries(MOODS.map((m) => [m, 0])) as Record<Mood, number>;
  let same = 0;
  for (const k of keys) {
    const labels = maps.map((m) => m.get(k)!);
    if (new Set(labels.map(outcome)).size === 1) same++;
    for (const mood of MOODS) if (new Set(labels.map((l) => l.known && l[mood])).size === 1) sameByMood[mood]++;
  }
  const shownByMood = Object.fromEntries(
    MOODS.map((m) => [m, runs.map((r) => r.filter((l) => l.known && l[m]).length)]),
  ) as Record<Mood, number[]>;
  return { songs: keys.length, same, sameByMood, shownByMood };
}
