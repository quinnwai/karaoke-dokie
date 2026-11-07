// What a beta event may look like (QWW-16, QWW-20), shared by the device tracker
// (src/lib/client/events.ts) and the server (validateEvents). The server rejects a request that
// breaks a rule; the tracker drops whatever would break one, so one bad prop cannot sink a batch.
import type { AppEvent, EventValue } from './contracts';

/**
 * The random device id (a UUID fits). Only a shape check: it cannot tell a random id from an
 * account id, which is why the device makes its own (loadAnonId) and never derives one.
 */
export const ANON_ID = /^[A-Za-z0-9-]{8,64}$/;
export const EVENT_NAME = /^[a-z][a-z0-9_]{1,48}$/;
export const PROP_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
export const MAX_PROPS = 20;
export const MAX_PROP_STRING = 200;
/** Most events one POST /api/events may carry. */
export const MAX_EVENTS_PER_REQUEST = 50;

export function isEventValue(v: unknown): v is EventValue {
  return (
    v === null ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length <= MAX_PROP_STRING)
  );
}

/**
 * Props that could tie an event to a Spotify account or a song in someone's library. Events are
 * keyed by a random device id, and Spotify's Developer Policy (section III, item 13) forbids
 * building usage statistics from Spotify content, so the tracker never sends these and the
 * server drops them again if they arrive. Matched ignoring case and underscores, so `track_id`
 * and `TrackID` go too.
 */
export const FORBIDDEN_PROPS = ['trackId', 'spotifyId', 'userId', 'displayName', 'email'] as const;

const bare = (key: string) => key.replace(/_/g, '').toLowerCase();
const forbidden = new Set<string>(FORBIDDEN_PROPS.map(bare));

export const isForbiddenProp = (key: string): boolean => forbidden.has(bare(key));

/** The event without forbidden props, and without `props` at all when none are left. */
export function withoutForbiddenProps(event: AppEvent): AppEvent {
  const kept = Object.entries(event.props ?? {}).filter(([key]) => !isForbiddenProp(key));
  const out: AppEvent = { name: event.name, at: event.at };
  if (kept.length) out.props = Object.fromEntries(kept);
  return out;
}
