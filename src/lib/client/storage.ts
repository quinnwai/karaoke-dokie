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
