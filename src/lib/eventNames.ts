// The names of the events the first tester release is judged by (QWW-51), in one place so the tickets that
// emit them (the mic flow, the Setlist tuner, the play row) and the two sinks that read them (our event log and
// PostHog) cannot drift apart. Each name passes EVENT_NAME (eventRules.ts). Events outside the release funnel
// (start_pressed, range_shown, feedback_tapped, ...) keep their literal names in funnel.ts.
//
// The release funnel is title_view to list_view (the sprint's criterion 8 is the share of devices that get from
// one to the other); the rest are what testers do once the list is up. Listed in the order a tester meets them.

export const EVENT = {
  /** The title screen is on screen. */
  titleView: 'title_view',

  // The mic permission flow (QWW-50), in the order a tester meets it.
  /** Our pre-prompt screen, before the browser's own prompt. */
  micPromptShown: 'mic_prompt_shown',
  micGranted: 'mic_granted',
  /** Props: `step` ('low' or 'high') where the test itself found no mic; the flow may add the reason. */
  micDenied: 'mic_denied',
  /** The how-to-fix screen shown after a denied or dismissed prompt. */
  micRecoveryShown: 'mic_recovery_shown',
  /** An Instagram, Facebook, LinkedIn or similar in-app browser that hides the mic. */
  inappBrowserDetected: 'inapp_browser_detected',

  /** The lowest note was held and heard. Props: `midi`. */
  lowNoteDone: 'low_note_done',
  /** The highest note was held and heard. Props: `midi`. */
  highNoteDone: 'high_note_done',
  /** The ranked song list came up. Props: `mode`, `matchCount`, `maybeCount`. */
  listView: 'list_view',

  // The Setlist tuner (QWW-46).
  /** A gear moved or was reset. Props: `gear` ('difficulty', 'history', 'popularity' or 'tempo'), `value` (0 to 100), `on` (true while the gear counts toward the ranking). */
  gearChange: 'gear_change',
  /** An era was toggled, or Era was reset. Props: `era` (the one toggled, null for a reset), `on` (that era is picked now), `eras` (all picked, comma-separated), `off` (Era is reset, so every era counts). */
  eraChange: 'era_change',

  /** The play button in a list row was pressed (QWW-48). Props: `position` (1-based place in the list). */
  rowPlay: 'row_play',
  /** A song's page was opened. Props: `position`, and `songKey` for a catalogue song only. */
  songOpen: 'song_open',
  /** The tester pressed Connect to Spotify. */
  spotifyConnect: 'spotify_connect',
} as const;
