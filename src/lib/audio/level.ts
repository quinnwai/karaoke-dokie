// How loud the microphone is hearing, for the level meter on the mic step (QWW-50): "Say ahh, see the bar move".

/** The meter is empty at this level (dBFS, a quiet room)... */
export const LEVEL_FLOOR_DB = -66;
/** ...and full at this one (a loud "ahh" close to the phone). */
export const LEVEL_CEIL_DB = -18;
/** A level a voice reaches and a quiet room does not (about -49 dBFS). The screen says "We can hear you" from here. */
export const HEARD_LEVEL = 0.35;

/** Loudness of a block of samples on a 0 to 1 scale: its root-mean-square in decibels, between the floor and the ceiling. */
export function levelOf(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB)));
}

/**
 * True for nothing at all, or only exact zeros: not a quiet room (even a quiet room's microphone wobbles), but a
 * microphone the system has muted (a call, another app, a permission taken back) or audio that never started.
 */
export function isDigitalSilence(samples: ArrayLike<number>): boolean {
  for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) return false;
  return true;
}
