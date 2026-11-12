// sessionStorage helpers. Every access is guarded: private windows and
// blocked storage must not break the flow, only forget progress.

import type { TestProgress } from './flow';

const PROGRESS_KEY = 'kd.test';
const PICK_KEY = 'kd.wantsPick';

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isMidi(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The time a range was sung (QWW-66): milliseconds since 1970. Anything else is as good as no time. */
function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

export function loadProgress(): TestProgress | null {
  try {
    const raw = store()?.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TestProgress>;
    const low = isMidi(parsed.low) ? parsed.low : null;
    const high = isMidi(parsed.high) ? parsed.high : null;
    if (low === null && high === null) return null;
    return isTime(parsed.measuredAt) ? { low, high, measuredAt: parsed.measuredAt } : { low, high };
  } catch {
    return null;
  }
}

export function saveProgress(progress: TestProgress): void {
  try {
    if (progress.low === null && progress.high === null) store()?.removeItem(PROGRESS_KEY);
    else store()?.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {}
}

export function clearProgress(): void {
  saveProgress({ low: null, high: null });
}

/** Remembers that the user tapped "pick songs" before being sent to sign in. */
export function setWantsPick(on: boolean): void {
  try {
    if (on) store()?.setItem(PICK_KEY, '1');
    else store()?.removeItem(PICK_KEY);
  } catch {}
}

export function takeWantsPick(): boolean {
  try {
    const on = store()?.getItem(PICK_KEY) === '1';
    store()?.removeItem(PICK_KEY);
    return on;
  } catch {
    return false;
  }
}

/** localStorage, which outlasts the tab; null where the browser blocks it. */
function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

// ---- no-Spotify mode (QWW-2 Track B) ----

const SAVED_RANGE_KEY = 'kd.range';

/** A range kept on this device, with the time it was sung when that is known (QWW-66; one kept earlier has none). */
export interface DeviceRange {
  low: number;
  high: number;
  measuredAt?: number;
}

/**
 * The range kept on this device: the signed-out list's, and the one a signed-in singer's list is checked against.
 * The device keeps the range of the list the singer last saw, whether or not they were signed in.
 */
export function loadSavedRange(): DeviceRange | null {
  try {
    const raw = local()?.getItem(SAVED_RANGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { low?: unknown; high?: unknown; measuredAt?: unknown };
    if (!isMidi(parsed.low) || !isMidi(parsed.high) || parsed.low >= parsed.high) return null;
    return isTime(parsed.measuredAt) ? { low: parsed.low, high: parsed.high, measuredAt: parsed.measuredAt } : { low: parsed.low, high: parsed.high };
  } catch {
    return null;
  }
}

export function saveRangeOnDevice(range: DeviceRange): void {
  try {
    local()?.setItem(SAVED_RANGE_KEY, JSON.stringify({ low: range.low, high: range.high, measuredAt: range.measuredAt }));
  } catch {}
}

export function clearSavedRange(): void {
  try {
    local()?.removeItem(SAVED_RANGE_KEY);
  } catch {}
}
