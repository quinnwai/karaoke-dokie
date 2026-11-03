import type { AppEvent, EventsRequest, EventValue, FeedbackRequest, VocalRange } from '../contracts';
import { ANON_ID, EVENT_NAME, isEventValue, MAX_EVENTS_PER_REQUEST, MAX_PROP_STRING, MAX_PROPS, PROP_KEY } from '../eventRules';

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

/** An ISO 8601 time with a zone (Z or an offset); without one, the server would have to guess it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** A device clock can be a little off; a week off is a wrong clock or a made-up event, and would scramble the replay. */
export const EVENT_CLOCK_SKEW_MS = 7 * 86_400_000;

/**
 * A batch of beta events (rules in src/lib/eventRules.ts). `at` comes back as UTC ISO, so events
 * sort by time as text in both stores. `now` is the server's clock, epoch ms.
 */
export function validateEvents(body: unknown, now: number = Date.now()): Validated<EventsRequest> {
  if (!isObj(body)) return { ok: false, error: 'Body must be a JSON object' };
  const { anonId, events } = body;
  if (typeof anonId !== 'string' || !ANON_ID.test(anonId)) {
    return { ok: false, error: 'anonId must be 8 to 64 letters, digits or dashes' };
  }
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS_PER_REQUEST) {
    return { ok: false, error: `events must be a list of 1 to ${MAX_EVENTS_PER_REQUEST} events` };
  }
  const out: AppEvent[] = [];
  for (const [i, raw] of events.entries()) {
    const v = validateEvent(raw, now);
    if (!v.ok) return { ok: false, error: `events[${i}]: ${v.error}` };
    out.push(v.value);
  }
  return { ok: true, value: { anonId, events: out } };
}

function validateEvent(raw: unknown, now: number): Validated<AppEvent> {
  if (!isObj(raw)) return { ok: false, error: 'must be an object' };
  const { name, at, props } = raw;
  if (typeof name !== 'string' || !EVENT_NAME.test(name)) {
    return { ok: false, error: 'name must be 2 to 49 lowercase letters, digits or underscores, starting with a letter' };
  }
  const time = typeof at === 'string' && ISO_TIME.test(at) ? Date.parse(at) : NaN;
  if (!Number.isFinite(time)) return { ok: false, error: 'at must be an ISO time with a time zone' };
  if (Math.abs(time - now) > EVENT_CLOCK_SKEW_MS) return { ok: false, error: 'at must be within 7 days of now' };
  const event: AppEvent = { name, at: new Date(time).toISOString() };
  if (props === undefined) return { ok: true, value: event };
  if (!isObj(props)) return { ok: false, error: 'props must be an object' };
  const entries = Object.entries(props);
  if (entries.length > MAX_PROPS) return { ok: false, error: `props can have at most ${MAX_PROPS} keys` };
  const checked: [string, EventValue][] = [];
  for (const [key, value] of entries) {
    if (!PROP_KEY.test(key)) {
      return { ok: false, error: 'prop names must be 1 to 41 letters, digits or underscores, starting with a letter' };
    }
    if (!isEventValue(value)) {
      const allowed = `a string of at most ${MAX_PROP_STRING} characters, a finite number, true, false or null`;
      return { ok: false, error: `prop ${key} must be ${allowed}` };
    }
    checked.push([key, value]);
  }
  event.props = Object.fromEntries(checked);
  return { ok: true, value: event };
}

/** Optional non-negative integer query param within [min, max]. */
export function intParam(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}
