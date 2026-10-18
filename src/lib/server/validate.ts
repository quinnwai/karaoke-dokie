import type { FeedbackRequest, VocalRange } from '../contracts';

export const MIDI_MIN = 28;
export const MIDI_MAX = 96;
export const SPAN_MIN = 5;
export const SPAN_MAX = 48;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, options: readonly T[]): v is T =>
  typeof v === 'string' && (options as readonly string[]).includes(v);

export function validateVocalRange(body: unknown): Validated<VocalRange> {
  if (!isObj(body)) return { ok: false, error: 'Body must be a JSON object' };
  const { low, high, source } = body;
  if (!Number.isInteger(low) || !Number.isInteger(high)) return { ok: false, error: 'low and high must be integers (MIDI)' };
  const lo = low as number;
  const hi = high as number;
  if (lo < MIDI_MIN || hi > MIDI_MAX) return { ok: false, error: `Notes must be between MIDI ${MIDI_MIN} and ${MIDI_MAX}` };
  if (lo >= hi) return { ok: false, error: 'low must be below high' };
  const span = hi - lo;
  if (span < SPAN_MIN || span > SPAN_MAX) {
    return { ok: false, error: `Range must span ${SPAN_MIN} to ${SPAN_MAX} semitones` };
  }
  if (!oneOf(source, ['test', 'songs'] as const)) return { ok: false, error: "source must be 'test' or 'songs'" };
  return { ok: true, value: { low: lo, high: hi, source } };
}

export function validateFeedback(body: unknown): Validated<FeedbackRequest> {
  if (!isObj(body)) return { ok: false, error: 'Body must be a JSON object' };
  const { trackId, thumbs, difficulty, octave } = body;
  if (typeof trackId !== 'string' || !trackId.trim() || trackId.length > 200) {
    return { ok: false, error: 'trackId must be a non-empty string' };
  }
  if (!oneOf(thumbs, ['up', 'down'] as const)) return { ok: false, error: "thumbs must be 'up' or 'down'" };
  if (!oneOf(difficulty, ['easy', 'medium', 'hard', 'maybe'] as const)) return { ok: false, error: 'difficulty is invalid' };
  if (!oneOf(octave, ['none', 'up', 'down'] as const)) return { ok: false, error: 'octave is invalid' };
  return { ok: true, value: { trackId, thumbs, difficulty, octave } };
}

/** Optional non-negative integer query param within [min, max]. */
export function intParam(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}
