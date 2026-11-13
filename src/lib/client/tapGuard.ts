/**
 * How long taps on the screen a tap has just brought up are ignored (a double tap's second tap lands there): the range notes, redo, "Back to
 * songs", the quiet step, a song row after "Load more", and the header's Spotify button after the tap that showed its tooltip. KaraokeApp
 * holds the guard and re-exports this; it lives here so that a component KaraokeApp renders can read it without importing KaraokeApp back.
 */
export const TAP_GUARD_MS = 400;
