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

  // The mic permission flow (QWW-50), in the order a tester meets it. Their props are short labels from closed sets, never
  // free text: `browser` ('ios-safari', 'android-chrome', 'other', ...), `via` ('prompt' when a tap asked, 'already'
  // when the browser had said), `reason` (denied, dismissed, system, missing, busy or unsupported) and `app` (the
  // in-app browser's name, or 'webview').
  /** Our pre-prompt screen, before the browser's own prompt. Props: `browser`. */
  micPromptShown: 'mic_prompt_shown',
  /** The microphone is on. Props: `via`, `browser`. */
  micGranted: 'mic_granted',
  /** Any way the answer was no. Props: `reason`, `via`, `browser`. */
  micDenied: 'mic_denied',
  /** The how-to-fix screen shown after a denied or dismissed prompt. Props: `reason`, `browser`. */
  micRecoveryShown: 'mic_recovery_shown',
  /** An Instagram, Facebook, LinkedIn or similar in-app browser that hides the mic. Props: `app`, `browser`. */
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

  /** A row's preview started playing, from a tap on its play button (QWW-48): the first sound, not a pause or a resume. Props: `position` (1-based place in the list), and `songKey` for a catalogue song only. */
  rowPlay: 'row_play',
  /** A song's page was opened. Props: `position`, and `songKey` for a catalogue song only. */
  songOpen: 'song_open',
  /** The tester pressed Connect to Spotify. */
  spotifyConnect: 'spotify_connect',
} as const;

/**
 * The prop names an event may carry to PostHog (QWW-51), a third party. Any other prop is dropped on the way there; our own
 * log keeps whatever the tracker accepts. Adding a name here is a privacy decision: never a Spotify id or URI, a person's
 * name or email, or the title or artist of a song from someone's library (a catalogue song's key is public, and fine). A prop
 * an event needs that is missing here is missing in PostHog only, so add it here together with the event that sends it.
 */
export const POSTHOG_PROPS: ReadonlySet<string> = new Set([
  // How the list was viewed: the screen's mode and the setting of each control.
  'mode',
  'difficulty',
  'familiarity',
  'popularity',
  'tempo',
  'decade',
  'mood',
  'duetsOnly',
  // Where and how much: place in the list, a catalogue song's key (a library song carries only its place), counts.
  'position',
  'songKey',
  'matchCount',
  'maybeCount',
  'libraryUnavailable',
  'shown',
  // The mic step (QWW-50): short labels from closed sets, see EVENT.
  'browser',
  'via',
  'reason',
  'app',
  // The range test.
  'step',
  'midi',
  'low',
  'high',
  'spanSemitones',
  'end',
  // Controls, including the tuner's gears and eras.
  'slider',
  'kind',
  'value',
  'on',
  'gear',
  'era',
  'eras',
  'off',
  // The rest of the funnel.
  'from',
  'signedIn',
  'thumbs',
]);
