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

export function loadProgress(): TestProgress | null {
  try {
    const raw = store()?.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TestProgress>;
    const low = isMidi(parsed.low) ? parsed.low : null;
    const high = isMidi(parsed.high) ? parsed.high : null;
    return low === null && high === null ? null : { low, high };
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

// A range the user said to keep despite the warning, remembered on this device.
const RANGE_OK_KEY = 'kd.rangeOk';
const rangeKey = (low: number, high: number) => `${low}-${high}`;

function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isRangeKept(low: number, high: number): boolean {
  try {
    return local()?.getItem(RANGE_OK_KEY) === rangeKey(low, high);
  } catch {
    return false;
  }
}

export function keepRange(low: number, high: number): void {
  try {
    local()?.setItem(RANGE_OK_KEY, rangeKey(low, high));
  } catch {}
}

// ---- no-Spotify mode (QWW-2 Track B) ----

const ANON_KEY = 'kd.anon';
const SAVED_RANGE_KEY = 'kd.range';

/** A random id for this device, never a Spotify id. Used for feedback and the beta event log. */
let sessionAnonId: string | null = null;
export function getAnonId(): string {
  try {
    const existing = local()?.getItem(ANON_KEY);
    if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
    const fresh = newId();
    local()?.setItem(ANON_KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked: one id for this page, forgotten on reload.
    sessionAnonId ??= newId();
    return sessionAnonId;
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `kd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The range of someone without Spotify, kept on this device so they come back to their songs. */
export function loadSavedRange(): { low: number; high: number } | null {
  try {
    const raw = local()?.getItem(SAVED_RANGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { low?: unknown; high?: unknown };
    return isMidi(parsed.low) && isMidi(parsed.high) && parsed.low < parsed.high ? { low: parsed.low, high: parsed.high } : null;
  } catch {
    return null;
  }
}

export function saveRangeOnDevice(range: { low: number; high: number }): void {
  try {
    local()?.setItem(SAVED_RANGE_KEY, JSON.stringify({ low: range.low, high: range.high }));
  } catch {}
}

export function clearSavedRange(): void {
  try {
    local()?.removeItem(SAVED_RANGE_KEY);
  } catch {}
}
