// The admin page's view of the beta event log (GET /api/admin/events). Pure: listEvents output
// in, AdminEventsResponse out. Every grouping uses a Map, because device ids are free text and
// a plain object keyed by "__proto__" or "constructor" would hit its prototype.
import { SLIDER_IDS, type AdminEventsResponse, type AppEvent } from '../contracts';
import type { StoredEvent } from './store';

/**
 * The onboarding funnel in order. note_detected fires for each end of the range, so its `step`
 * prop splits it into two steps.
 */
export const FUNNEL: { label: string; name: string; step?: 'low' | 'high' }[] = [
  { label: 'landing_viewed', name: 'landing_viewed' },
  { label: 'start_pressed', name: 'start_pressed' },
  { label: 'low_note_detected', name: 'note_detected', step: 'low' },
  { label: 'high_note_detected', name: 'note_detected', step: 'high' },
  { label: 'range_shown', name: 'range_shown' },
  { label: 'results_viewed', name: 'results_viewed' },
  { label: 'song_opened', name: 'song_opened' },
  { label: 'spotify_link_pressed', name: 'spotify_link_pressed' },
  { label: 'spotify_connect_pressed', name: 'spotify_connect_pressed' },
];

/** The replay lists this many devices, the most recently active ones. */
export const MAX_SESSIONS = 50;

type ControlStats = AdminEventsResponse['byControl'][string];

export function summarizeEvents(events: StoredEvent[]): AdminEventsResponse {
  return { funnel: funnel(events), byControl: byControl(events), sessions: sessions(events) };
}

/**
 * Distinct devices per step. Each step counts on its own, not only devices that did every step
 * before it: a returning tester lands straight on results, and a device's early events can fall
 * outside the newest-events window.
 */
function funnel(events: StoredEvent[]): AdminEventsResponse['funnel'] {
  return FUNNEL.map((step) => {
    const devices = new Set<string>();
    for (const e of events) {
      if (e.name === step.name && (step.step === undefined || e.props?.step === step.step)) devices.add(e.anonId);
    }
    return { name: step.label, devices: devices.size };
  });
}

/**
 * The controls in use when an event happened, from its view props: each slider that was set
 * (a number), each chip row that had a pick, or 'none' when nothing was set. Empty for an event
 * that carries no view.
 */
export function controlsInUse(props: StoredEvent['props']): string[] {
  // Events from before the sliders (a `sort` prop, no slider props) say nothing about these controls.
  if (!props || !('difficulty' in props)) return [];
  const used: string[] = [];
  for (const slider of SLIDER_IDS) if (typeof props?.[slider] === 'number') used.push(slider);
  if (typeof props?.decade === 'string') used.push('decade');
  if (typeof props?.mood === 'string') used.push('mood');
  if (props?.duetsOnly === true) used.push('duets');
  return used.length ? used : ['none'];
}

/**
 * Per control in use: opens, Spotify opens and thumbs. An event with several controls in use
 * counts toward each, so the numbers say which controls the songs people liked came through.
 */
function byControl(events: StoredEvent[]): AdminEventsResponse['byControl'] {
  const acc = new Map<string, { stats: ControlStats; positions: number[] }>();
  for (const e of events) {
    if (e.name !== 'song_opened' && e.name !== 'spotify_link_pressed' && e.name !== 'feedback_tapped') continue;
    for (const control of controlsInUse(e.props)) {
      let a = acc.get(control);
      if (!a) acc.set(control, (a = { stats: { opened: 0, spotify: 0, up: 0, down: 0, medianPosition: null }, positions: [] }));
      if (e.name === 'song_opened') {
        a.stats.opened++;
        const position = e.props?.position;
        if (typeof position === 'number' && Number.isFinite(position)) a.positions.push(position);
      } else if (e.name === 'spotify_link_pressed') a.stats.spotify++;
      else if (e.props?.thumbs === 'up') a.stats.up++;
      else if (e.props?.thumbs === 'down') a.stats.down++;
    }
  }
  return Object.fromEntries([...acc].map(([control, a]) => [control, { ...a.stats, medianPosition: median(a.positions) }]));
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Each device's events in time order, so a session reads as a replay; the most recently active devices first. */
function sessions(events: StoredEvent[]): AdminEventsResponse['sessions'] {
  const byDevice = new Map<string, { events: AppEvent[]; last: number }>();
  // A stable sort, so events with the same time keep the store's arrival order.
  const inTimeOrder = events.map((e) => ({ e, time: Date.parse(e.at) })).sort((a, b) => a.time - b.time);
  for (const { e, time } of inTimeOrder) {
    let d = byDevice.get(e.anonId);
    if (!d) byDevice.set(e.anonId, (d = { events: [], last: time }));
    d.events.push(e.props ? { name: e.name, at: e.at, props: e.props } : { name: e.name, at: e.at });
    d.last = time; // in time order, so the last one seen is the newest
  }
  return [...byDevice]
    .sort(([, a], [, b]) => b.last - a.last)
    .slice(0, MAX_SESSIONS)
    .map(([anonId, d]) => ({ anonId, events: d.events }));
}
