// Feel labels, and the one tempo the ranking uses for a song (QWW-54).
//
// A measured tempo is wrong in a known way: Deezer, the beat tracker and UltraStar's grid each read a slow song at
// double its felt speed now and then (Hey Jude, 148 for 74), so a ballad can land at the upbeat end of the Tempo
// gear, and a half-time ballad sits wrong whatever rule folds it. No rule on the numbers alone can tell Hey Jude
// from Take On Me. So a song can carry a feel label: "slow", "mid" or "upbeat", made offline from what is known of
// the recording, kept in song_feel, and never worked out while a page loads (npm run tempo:feel).
//
// The label decides which end of the Tempo gear the song sits at; the measurement only orders songs inside that
// end. Each feel has a band of bpm (FEEL_BANDS). effectiveTempo moves the measured tempo into its label's band by
// whole octaves where that is a small step, or else to the band's nearest edge, so a slow song can never sit among
// the upbeat ones and a double-time reading of it cannot lift it there. A measured tempo that no label vouches for is
// not trusted at either end: it is squeezed into the mid band, in the order it had, so only labelled songs reach the two
// ends of the gear (a published tempo counts as one more reading, not as a label). A real sample says why: of 297 songs labelled slow that Deezer
// has a bpm for, 59% were read at 125 bpm or more, which the measured rule alone puts at the upbeat end.
//
// Not every label vouches for its end equally. An independent judge agreed with 95% of the slow labels the strict first
// pass made, but with only 79% of those the band-edge audit made (58% where just two of its three runs agreed), so a
// label from a plain-definition pass ranks behind the clear songs whose readings fit their band (isWeakLabelSource).

import { reviewedBpm } from './reviewed';
import { combineTempo, TEMPO_MAX, TEMPO_MIN, type SongTempoRecord, type TempoSource } from './tempo';

export const FEELS = ['slow', 'mid', 'upbeat'] as const;
export type Feel = (typeof FEELS)[number];
export const isFeel = (v: unknown): v is Feel => typeof v === 'string' && (FEELS as readonly string[]).includes(v);

/** What song_feel keeps for a song. */
export interface SongFeelRecord {
  key: string;
  feel: Feel;
  /** What made the label: the method and prompt version, for example "claude-opus-5-5/feel-v1". */
  source: string;
  /** ISO time the label was stored. */
  labeledAt?: string;
}

/**
 * Whether a label came from a plain-definition pass, which vouches for its end less than the strict first pass or a person's fix.
 * Measured on 12 Nov 2026 over every song that fits a test range, against an independent judge (OpenAI gpt-6-luna, three runs,
 * the majority): it agreed with 95% of the slow and 98% of the upbeat labels from the strict first pass (`…/feel-v1`), 83% and
 * 90% of the second look's (`…/feel-plain-v1`), 79% and 89% of the audit's where all three of its runs agreed
 * (`…/feel-edge-recheck-v1`) and 58% and 61% where two of three did. Other sources (a hand fix, `manual/…`, or a future pass)
 * are not weak until they are named here.
 */
const WEAK_LABEL_SOURCE = /\/feel-(plain|edge-recheck)-/;
export const isWeakLabelSource = (source: string | undefined): boolean => source !== undefined && WEAK_LABEL_SOURCE.test(source);

/**
 * Where each feel sits on the Tempo gear, in bpm; the low end is in the band and the high end is not. The bands
 * touch, so every tempo is in exactly one. Slow songs are mostly ballads and slow jams from 55 to 90, mid songs sit
 * around a walking pace, and anything people dance to from about 125 up is upbeat.
 */
export const FEEL_BANDS: Record<Feel, { min: number; max: number }> = {
  slow: { min: 40, max: 90 },
  mid: { min: 90, max: 125 },
  upbeat: { min: 125, max: 215 },
};

/**
 * Where a labelled song with no measured tempo at all sits: at the edge of its band facing the middle (the middle of
 * the mid band), behind the songs whose numbers back the label up.
 */
export const FEEL_REST: Record<Feel, number> = { slow: FEEL_BANDS.slow.max - 0.5, mid: (FEEL_BANDS.mid.min + FEEL_BANDS.mid.max) / 2, upbeat: FEEL_BANDS.upbeat.min };

/** The band a tempo falls in. */
export const feelOfTempo = (bpm: number): Feel => (bpm < FEEL_BANDS.slow.max ? 'slow' : bpm < FEEL_BANDS.mid.max ? 'mid' : 'upbeat');

/** A reading moved by octaves has to land inside this: nothing is sung at 30 or at 300. (A reading as written is not held to it.) */
const PLAUSIBLE_MIN = 40;
const PLAUSIBLE_MAX = 210;
/**
 * What moving a reading by one octave costs, in octaves (log2) of distance from the band, so a reading 0.3 octaves
 * out of its band and the same reading halved cost the same. Halving costs less than doubling: sources report
 * double time far more often than half time, and a fast label on a song read at 100 is better placed at the
 * bottom of its band (just fast enough) than doubled to 200, above the songs that really are that fast.
 */
const HALVE_COST = 0.3;
const DOUBLE_COST = 0.5;
/**
 * A song forced out of its band sits inside a strip this wide at the band's edge, in the order of what was measured (see
 * effectiveTempo). A reading just inside the edge can land in the strip too, so "the numbers back the label up" holds to
 * within the strip's width.
 */
const EDGE = 0.5;
const STRIP = 0.4;

export type EffectiveSource = TempoSource | 'reviewed' | 'feel';

/** The one tempo the ranking uses for a song, and where it came from. */
export interface EffectiveTempo {
  tempo: number;
  source: EffectiveSource;
  /**
   * How the value differs from the measurement: moved by a whole octave or to the nearest edge of the label's band, or
   * (with no label) squeezed into the mid band. Unset when the measured value is used as it is.
   */
  adjusted?: 'halved' | 'doubled' | 'clamped' | 'compressed';
  /** True when the label is a weak one (isWeakLabelSource) and the song was put in the strip at its band's inner edge, behind the clear songs whose readings fit the band. */
  weak?: true;
}

/** One measured or checked tempo of a song, as written by its source, and which source. */
export interface Reading {
  bpm: number;
  source: EffectiveSource;
}

const validBpm = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** What a song's tempo is read from, best first: its checked tempo alone when it has one (that stands ahead of the measured ones), else Deezer, the tracker and UltraStar's grid. */
export function readingsOf(record: Pick<SongTempoRecord, 'deezerBpm' | 'trackerBpm' | 'ultrastarBpm'> | undefined, reviewed?: number): Reading[] {
  if (validBpm(reviewed)) return [{ bpm: reviewed, source: 'reviewed' }];
  const out: Reading[] = [];
  if (validBpm(record?.deezerBpm)) out.push({ bpm: record.deezerBpm, source: 'deezer' });
  if (validBpm(record?.trackerBpm)) out.push({ bpm: record.trackerBpm, source: 'tracker' });
  if (validBpm(record?.ultrastarBpm)) out.push({ bpm: record.ultrastarBpm / 4, source: 'ultrastar' }); // four grid steps to a beat
  return out;
}

/**
 * The reading, moved by whole octaves, that fits a label's band best, as a plain bpm before it is put inside the band;
 * undefined when no reading can be moved to a plausible tempo. Each reading is tried as it is, halved, doubled and by two
 * octaves; a candidate costs how far it is outside the band plus a price per octave moved (HALVE_COST, DOUBLE_COST), the
 * cheapest wins, and an earlier reading and fewer octaves win a tie.
 */
export function fitReading(readings: Reading[], feel: Feel): { value: number; octaves: number; source: EffectiveSource } | undefined {
  const band = FEEL_BANDS[feel];
  let best: { cost: number; value: number; octaves: number; source: EffectiveSource } | undefined;
  for (const { bpm, source } of readings) {
    for (const octaves of [0, -1, 1, -2, 2]) {
      const value = bpm * 2 ** octaves;
      // A reading as written is always a candidate; only a moved one has to land on a plausible tempo.
      if (octaves !== 0 && (value < PLAUSIBLE_MIN || value > PLAUSIBLE_MAX)) continue;
      const outside = value < band.min ? Math.log2(band.min / value) : value >= band.max ? Math.log2(value / band.max) : 0;
      const cost = outside + Math.abs(octaves) * (octaves < 0 ? HALVE_COST : DOUBLE_COST);
      if (!best || cost < best.cost - 1e-9) best = { cost, value, octaves, source };
    }
  }
  return best && { value: best.value, octaves: best.octaves, source: best.source };
}

/**
 * The song's one tempo for the ranking, in bpm, with its source:
 * - No label: the published tempo (reviewed.ts), else the measured one (combineTempo), else null, squeezed into the mid
 *   band. The squeeze is a straight line from 70 to 180 (a value outside it is clamped first) onto 90 to 125, so it keeps
 *   the order and ties of the measured tempos, and no song without a label reaches an end of the gear.
 * - A label: the reading that fits its band best, from the published tempo alone when there is one (it stands ahead
 *   of the measured ones) or else from Deezer, the tracker and UltraStar in that order. Each reading is tried as
 *   it is, halved, doubled and by two octaves; a candidate costs how far it is outside the band plus a price per
 *   octave moved (HALVE_COST, DOUBLE_COST), the cheapest wins, an earlier reading and fewer octaves win a tie (that
 *   is fitReading), and a value still outside the band goes into a thin strip just inside its nearest edge. With no
 *   reading the song sits at FEEL_REST.
 * - A weak label (`weak`, from isWeakLabelSource) at either end: the same band, but the song goes into the strip at the band's
 *   inner edge, in the order of its tempo, so it ranks behind the clear songs whose readings fit the band. A clear song that had
 *   to be forced to the band's edge by its reading shares that strip with it, so "behind every clear song" is not what this
 *   promises (a mid label has no end to be behind). With no reading a weak label sits at the inner end of the strip, behind the
 *   weak songs whose readings back their label.
 */
export function effectiveTempo(input: {
  key?: string;
  record?: Pick<SongTempoRecord, 'deezerBpm' | 'trackerBpm' | 'ultrastarBpm'>;
  feel?: Feel;
  /** The label is a weak one (isWeakLabelSource of the label's source). */
  weak?: boolean;
}): EffectiveTempo | null {
  const { key, record, feel } = input;
  const reviewed = key === undefined ? undefined : reviewedBpm(key);
  if (feel === undefined) {
    // No label: a published tempo and a measured one are treated alike. Neither says which end the song belongs at (a
    // published one is a notated beat, which is not always the felt one: Piano Man is quarter = 168 in 3/4), so the value
    // goes into the mid band in the order it had, clamped to 70 to 180 first so that holds for every song.
    const base: { tempo: number; source: EffectiveSource } | null = validBpm(reviewed) ? { tempo: reviewed, source: 'reviewed' } : record ? combineTempo(record) : null;
    if (!base) return null;
    const { min, max } = FEEL_BANDS.mid;
    const t = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, base.tempo));
    return { tempo: min + ((t - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN)) * (max - min - EDGE), source: base.source, adjusted: 'compressed' };
  }

  const best = fitReading(readingsOf(record, reviewed), feel);
  const band = FEEL_BANDS[feel];
  if (!best) {
    // Nothing backs the label but the label. A weak one goes last in the strip at the band's inner edge (the end of it nearest the
    // middle), behind the weak songs whose readings fit; a clear one rests at FEEL_REST.
    if (input.weak && feel !== 'mid') return { tempo: feel === 'slow' ? band.max - EDGE + STRIP : band.min, source: 'feel', weak: true };
    return { tempo: FEEL_REST[feel], source: 'feel' };
  }

  // Out of its band, a value goes into a thin strip at the nearest edge: the strip at the top is the last half bpm before
  // the band ends, the one at the bottom is its first. Inside it the order follows the reading (the slower the reading,
  // the lower), so songs forced to an edge are not all tied, and the ones that fill an end when there are too few
  // labelled songs are the nearest to it by their numbers.
  const t = Math.min(1, Math.max(0, (best.value - PLAUSIBLE_MIN) / (PLAUSIBLE_MAX - PLAUSIBLE_MIN)));
  const tempo = best.value < band.min ? band.min + t * STRIP : best.value >= band.max ? band.max - EDGE + t * STRIP : best.value;
  const clamped = best.value < band.min || best.value >= band.max;
  const adjusted = clamped ? 'clamped' : best.octaves < 0 ? 'halved' : best.octaves > 0 ? 'doubled' : undefined;
  if (input.weak && feel !== 'mid') {
    // Behind the clear songs whose readings fit: the inner edge of the band, the strip next to the middle, in the order the song had.
    const place = Math.min(1, Math.max(0, (tempo - band.min) / (band.max - band.min)));
    const inner = feel === 'slow' ? band.max - EDGE + STRIP * place : band.min + STRIP * place;
    return { tempo: inner, source: best.source, ...(adjusted ? { adjusted } : {}), weak: true };
  }
  return { tempo, source: best.source, ...(adjusted ? { adjusted } : {}) };
}
