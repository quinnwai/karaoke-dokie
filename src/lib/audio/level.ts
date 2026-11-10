// Telling a microphone the system muted from a singer who is just quiet (QWW-50), for the two note steps.

/** Fewest samples that can say "muted": more than two recorder chunks (2048 each at most), so a tap is never mistaken for it. */
export const MIN_MUTED_SAMPLES = 4800;

/**
 * True for a long enough run of exact zeros: not a quiet room (even a quiet room's microphone wobbles), but a
 * microphone the system has muted (a call, another app, a permission taken back). Too short a take (a quick tap on the
 * hold button gives nothing at all) is a short hold, not a muted mic.
 */
export function isDigitalSilence(samples: ArrayLike<number>): boolean {
  if (samples.length < MIN_MUTED_SAMPLES) return false;
  for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) return false;
  return true;
}
