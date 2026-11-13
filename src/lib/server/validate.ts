import {
  ERA_IDS,
  GEAR_IDS,
  MOODS,
  RANGE_LIMITS,
  SLIDER_IDS,
  type AppEvent,
  type Decade,
  type EraId,
  type EventsRequest,
  type EventValue,
  type FeedbackRequest,
  type GearValues,
  type ResultsView,
  type SetlistRequest,
  type TunerPart,
  type VocalRange,
} from '../contracts';
import { ANON_ID, EVENT_NAME, isEventValue, MAX_EVENTS_PER_REQUEST, MAX_PROP_STRING, MAX_PROPS, PROP_KEY } from '../eventRules';
import { SETLIST_PAGE } from '../songs/setlistConfig';

export const MIDI_MIN = RANGE_LIMITS.midiMin;
export const MIDI_MAX = RANGE_LIMITS.midiMax;
export const SPAN_MIN = RANGE_LIMITS.spanMin;
export const SPAN_MAX = RANGE_LIMITS.spanMax;

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
  // When the singer sang it (QWW-66). Optional, so a caller that sends none (the catalogue's query, feedback, the Setlist tuner) is as it was.
  const { measuredAt } = body;
  if (measuredAt !== undefined && !(typeof measuredAt === 'number' && Number.isSafeInteger(measuredAt) && measuredAt > 0)) {
    return { ok: false, error: 'measuredAt must be a time in milliseconds' };
  }
  return { ok: true, value: { low: lo, high: hi, source, ...(measuredAt === undefined ? {} : { measuredAt }) } };
}

const TUNER_PARTS: readonly TunerPart[] = [...GEAR_IDS, 'era'];

/**
 * The Setlist tuner's state and range (QWW-47). The gears are whole numbers 0 to 100 as the sheet's sliders make
 * them; `off` and `eras` hold only known ids, and a repeated id counts once. `offset` and `limit` are optional.
 */
export function validateSetlistRequest(body: unknown): Validated<SetlistRequest> {
  if (!isObj(body)) return { ok: false, error: 'Body must be a JSON object' };
  const range = validateVocalRange({ ...(isObj(body.range) ? body.range : {}), source: 'test' });
  if (!range.ok) return { ok: false, error: `range: ${range.error}` };
  if (!isObj(body.gears)) return { ok: false, error: 'gears must be an object' };
  const gears = {} as GearValues;
  for (const id of GEAR_IDS) {
    const v = body.gears[id];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) return { ok: false, error: `gears.${id} must be a whole number from 0 to 100` };
    gears[id] = v;
  }
  const ids = <T extends string>(raw: unknown, allowed: readonly T[], name: string): Validated<T[]> => {
    if (!Array.isArray(raw) || raw.length > 20 || !raw.every((x) => oneOf(x, allowed))) {
      return { ok: false, error: `${name} must be a list of ${allowed.join(', ')}` };
    }
    return { ok: true, value: [...new Set(raw as T[])] };
  };
  const off = ids(body.off, TUNER_PARTS, 'off');
  if (!off.ok) return off;
  const eras = ids(body.eras, ERA_IDS as readonly EraId[], 'eras');
  if (!eras.ok) return eras;
  const value: SetlistRequest = { range: { low: range.value.low, high: range.value.high }, gears, off: off.value, eras: eras.value };
  const { offset, limit } = body;
  if (offset !== undefined) {
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return { ok: false, error: 'offset must be a whole number from 0 to 100000' };
    value.offset = offset;
  }
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > SETLIST_PAGE.max) {
      return { ok: false, error: `limit must be a whole number from 1 to ${SETLIST_PAGE.max}` };
    }
    value.limit = limit;
  }
  return { ok: true, value };
}

export function validateFeedback(body: unknown): Validated<FeedbackRequest> {
  if (!isObj(body)) return { ok: false, error: 'Body must be a JSON object' };
  const { trackId, thumbs, difficulty, octave, view } = body;
  if (typeof trackId !== 'string' || !trackId.trim() || trackId.length > 200) {
    return { ok: false, error: 'trackId must be a non-empty string' };
  }
  if (!oneOf(thumbs, ['up', 'down'] as const)) return { ok: false, error: "thumbs must be 'up' or 'down'" };
  if (!oneOf(difficulty, ['easy', 'medium', 'hard', 'maybe'] as const)) return { ok: false, error: 'difficulty is invalid' };
  if (!oneOf(octave, ['none', 'up', 'down'] as const)) return { ok: false, error: 'octave is invalid' };
  const value: FeedbackRequest = { trackId, thumbs, difficulty, octave };
  // Older clients send no view; a view that is sent must be a whole, known one.
  if (view !== undefined) {
    const v = validateView(view);
    if (!v.ok) return v;
    value.view = v.value;
  }
  return { ok: true, value };
}

const DECADES: readonly Decade[] = ['60s', '70s', '80s', '90s', '00s', '10s', '20s'];

/** A slider target: null when the slider was not touched, else a number from 0 to 1. */
const isTarget = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);

/** The results view a tap came from. Only the known fields are kept, so the stored view is just them. */
function validateView(view: unknown): Validated<ResultsView> {
  if (!isObj(view)) return { ok: false, error: 'view must be an object' };
  const { difficulty, familiarity, popularity, tempo, decade, mood, duetsOnly } = view;
  for (const id of SLIDER_IDS) {
    if (id === 'tempo' && tempo === undefined) continue; // a client from before the Tempo slider
    if (!isTarget(view[id])) return { ok: false, error: `view.${id} must be null or a number from 0 to 1` };
  }
  if (decade !== null && !oneOf(decade, DECADES)) return { ok: false, error: `view.decade must be null or one of ${DECADES.join(', ')}` };
  if (mood !== null && !oneOf(mood, MOODS)) return { ok: false, error: `view.mood must be null or one of ${MOODS.join(', ')}` };
  if (typeof duetsOnly !== 'boolean') return { ok: false, error: 'view.duetsOnly must be true or false' };
  return {
    ok: true,
    value: {
      difficulty: difficulty as number | null,
      familiarity: familiarity as number | null,
      popularity: popularity as number | null,
      tempo: (tempo ?? null) as number | null,
      decade,
      mood,
      duetsOnly,
    },
  };
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
