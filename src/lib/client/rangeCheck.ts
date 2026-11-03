// A growl, vocal fry or whistle can land far past where songs go, and a range that is too wide
// makes every song look easy and mislabels difficulty. Pop songs stay roughly within E2..C6, so a
// sung note is held to that span when the range is built. The singer is never asked about it.

/** E2: lower than almost any pop melody. */
export const LOWEST_LIKELY = 40;
/** C6: higher than almost any pop melody. */
export const HIGHEST_LIKELY = 84;

/** The note itself, or the nearer end of E2..C6 when it falls outside. */
export function plausibleNote(midi: number): number {
  return Math.min(HIGHEST_LIKELY, Math.max(LOWEST_LIKELY, midi));
}
