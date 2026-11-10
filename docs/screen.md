# Screen (frontend)

The whole app is one karaoke TV centered on a dark page. Every step happens on its
screen, with instructions sung in like karaoke lyrics. One accent color: hot pink.

## Flow

1. **Landing**: カラオケ sign and a round Start button. "or pick songs you sing well" shows only while the
   server has `PICK_SONGS=on` (off by default, QWW-55: the first release has one onboarding flow). `app/page.tsx`
   reads it on every request and passes it to `KaraokeApp` as `pickSongs`; off, the link is not drawn and a
   pick left over in `sessionStorage` (`kd.wantsPick`) from an earlier visit is dropped. The pick screen's code stays.
   The same switch also decides the link under the range (step 6).
2. **Find a quiet spot**: lyric line, moves on by itself after ~2.6 s (or tap).
3. **Microphone** (QWW-50). The browser's own question is a step we do not control, and older singers often miss,
   close or block it, so this step comes first and none of its screens is a dead end. In order:
   - **Inside another app** (Instagram, Facebook, Messenger, LinkedIn, TikTok, Snapchat, LINE, WeChat, or any
     webview; read from the user agent in `src/lib/client/browser.ts`): "Open this in Safari" or "Chrome". On Android a
     real "Open in Chrome" link (an `intent://` address that falls back to this page), on iPhone the menu route
     (there is no way to open Safari from a page), a copy-link button, the address in a field to copy by hand, and
     "Try here anyway", because a user agent is only a guess. "Try here anyway" is remembered for the visit, and a
     refusal after it shows this screen again with "Try again", since that browser has no site settings to open.
   - **Our own screen first**, "Set up your microphone": one line, "Your phone will ask to use the microphone. Tap
     **Allow**." ("browser" on a computer), and one round button with a microphone on it. Nothing else: no picture, no
     other words. The button has no text, so its name is "Turn on microphone" (`aria-label`); it is the record
     button's own component (`RoundButton.tsx`: the same size, ring and glow). That tap itself calls `getUserMedia`
     (iOS Safari wants a tap for audio). While the browser's question is up the button is lit and pulsing (`aria-busy`)
     and does not take a second tap; screen readers get a hidden status line, "Waiting for your phone…". If the
     question never comes, "Nothing happened? Reload this page" appears after 12 s: it is the only way out then. The screen is skipped when `navigator.permissions.query({ name: 'microphone' })`
     already says *granted* (the microphone opens by itself) or *denied* (straight to the steps below). Where the
     browser cannot say, or does not answer within 0.4 s, the screen shows.
   - **Once the microphone is on, the step is over**: straight to the low (or high) note, whether the tap just allowed
     it or the browser had already. There is no level meter and no "Continue". The same microphone carries on into the
     two notes, so the browser is not asked again.
   - **When the answer is no**, told apart by reason (blocked, question closed, Android's own switch for the browser,
     no microphone, busy, unsupported): the steps for this browser (iPhone Safari: aA, Website Settings, Microphone;
     Android Chrome: lock icon, Permissions; other iPhone browsers: the Settings app; Android's own switch: Settings,
     Apps, the browser, Permissions), "Try again", "Reload this page" (on an iPhone, Safari asks again after a reload;
     it is `reload` on the component, not `navigate`, which does nothing on an address with a `#fragment`), and that
     Safari may ask again each visit. A second no says "Still not working". "Unsupported" tells a browser we do not
     point to to open Safari or Chrome, and tells Safari or Chrome to try again.
   - Type is 18 px or more and every button 48 px or more (the main one 56 px or more: the round button is 112 px). The
     one thing to tap on each screen is sticky at the bottom of the scrolling screen, so a small phone, or one set to
     larger text, never hides it. `mic-permission.spec.ts` checks the sizes, and that the main button is in view, on
     375x553: an iPhone SE with Safari's toolbars showing.
   - Events: `inapp_browser_detected`, `mic_prompt_shown`, `mic_granted`, `mic_denied` (any way the answer was no, with
     a `reason`) and `mic_recovery_shown`, with only `browser`, `app`, `reason` and `via` (asked by a tap, or already
     answered) as props. They come from the flow's own transitions (`funnel.ts`), through the usual tracker.
     `mic_granted` is logged on the grant itself, once per grant: the grant leaves the mic step for the note, so there
     is no screen it could be tied to, and an answer the flow ignores (a late one) logs nothing. A lost microphone
     shows our screen again, so that pass logs `mic_prompt_shown` and a second `mic_granted` (`via: 'prompt'`) even when
     the browser, already allowing it, shows no question: a funnel per visitor takes the first of each.

   Every way into a note with no microphone open goes through this step: the first run, redoing the test or one end of
   it, resuming a half-done test after a reload, and a microphone taken away during a note (`MicRecorder.live()`
   false, or a hold that recorded only zeros, or audio that never started: a microphone the system muted is not a
   quiet singer). After a microphone is lost, **our own screen shows even when the browser says allowed**
   (`MicGate.lost`): an allowed but silent microphone would otherwise open by itself and drop the singer straight
   back on the note with no word, and it is the tap on the round button that starts the audio again. A *quick tap* on
   the record button is not a lost microphone: it says "hold a little longer" (a take shorter than
   `MIN_MUTED_SAMPLES` from a running recorder).
4. **Lowest note**: press and hold the round button (Space/Enter also work). While held,
   the mic records and a dot moves on a C2–C6 scale with the current note. On release,
   `detectHeldNote` runs on the recording. Too short a hold → "Try again…" lyric.
5. **Highest note**: same button; the low note shows small in the corner. A high note at
   or below the low one asks to go higher.
6. **Range + arrow**: "That's your range A2 – C5" and a wordless arrow bouncing bottom-right
   (`aria-label="Continue"`). The arrow goes straight to catalogue results with no sign-in
   (QWW-2 Track B); the range is kept on the device (`localStorage` `kd.range`). "or use songs from your
   Spotify" under it shows only while `PICK_SONGS=on`, the switch of step 1 (QWW-55); it keeps the range in
   `sessionStorage` (`kd.test`) and goes to `/api/auth/login`. With the switch off, the Spotify logo on the
   results (step 7) is the one way to sign in.
   A sign-in that fails (Spotify says wait, one of the sign-in's Spotify calls fails, the sign-in cookie is gone,
   ...) is sent back by the callback as `/?authError=<reason>`. The range was kept for the round trip, so
   it lands here: `?authError` is taken out of the address and one quiet line, "Couldn’t sign in to Spotify.",
   shows under the arrow, and again under the bar of the results the arrow leads to. `access_denied` is the
   singer pressing Cancel on Spotify's page, which is their answer, so nothing is said.
7. **Results**: one request for every match (`/api/catalogue/recommendations?...&all=1` without
   Spotify, `/api/recommendations?all=1` with it), then the phone orders, filters and pages them
   (`src/lib/songs/browse.ts`), 5 at a time. Two panels sit above the list: **Tune** (pink), sliders
   that reorder and never remove a song, untouched until moved, with a circular-arrow Reset icon
   (`aria-label` "Reset sliders") once one is set (a song sits on a slider by its rank in the list, so
   every tenth of the track holds about a tenth of the songs); and **Pick** (cyan),
   chips for decades, and for moods and duets only while the server has `DUETS_AND_MOODS=on` (off by
   default, QWW-43: it then sends no mood labels or duet markers, so those chips and the "Duet: take ..."
   lines never appear, and the order of the songs does not change) (one pick per row, a count on each, disabled at zero). The
   lyric line says what the slider moved last does. Songs whose range is only an estimate
   (`difficulty: 'maybe'`) show last in their own "Maybe" list, without a difficulty pill. In
   catalogue mode "Connect Spotify" saves the range for the sign-in round trip; back from Spotify,
   it is PUT to `/api/me/range` and library results load. The Spotify logo at the top right shows
   which mode this is: grey ("Connect to Spotify") without an account, Spotify green when signed in.
   Signed in, pointing at it (or a tap) opens a small box, "Logged in as <display name> · Log out";
   Log out POSTs `/api/auth/logout`, forgets the library and shows catalogue results for the same
   range, which stays on the device (`kd.range`). If the request fails the box says so and nothing changes.
   When the server cannot read the singer's Spotify library (Spotify says wait, fails or is down) it answers
   `/api/recommendations?all=1` with the catalogue's songs for their range and `libraryUnavailable: true` (QWW-55).
   The list is then a catalogue list (no "Rediscover to On repeat" slider, no connect prompts) for a singer who stays
   signed in, with the green logo, Log out and one quiet line under the bar: "Couldn’t reach Spotify, showing
   popular songs." The next range save or redo asks the server again.
8. **Song detail**: range bar (song in neon pink over the user's range, note names at the
   ends; a song sung an octave away is drawn as sung, with the recording as a dashed outline;
   faint bars above it show where the song's singing time sits across your range, `Match.shape`,
   so an Easy song that spans most of your range reads as Easy: one bar for each twelfth of your range
   that has singing in it, none for a twelfth without, and each cut to the song's pink stretch so none
   sticks out of it (the shape only counts notes inside the song's range, `shapeOf` in `score.ts`;
   `rangeBar` in `display.ts` does the cutting)), difficulty (or a quiet "Maybe"), "Fast lyrics", an "i" button explaining where the
   data came from (for Maybe songs, also that the range is an estimate), Spotify's own player
   (see below), and "How'd it go?" thumbs that POST `/api/feedback`.
9. **Returning user** with a saved range lands on results; "redo" restarts the test. Someone
   without Spotify whose range is kept on the device lands on catalogue results.
10. **Pick songs**: a signed-in user picks up to 3 songs from `/api/songs/known`; the lowest
   low and highest high become the range (`source: 'songs'`). Signed-out users sign in first.

## Spotify player

The song detail embeds Spotify's own player: the plain iframe from Spotify's
[creating an embed](https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed)
tutorial (`SpotifyPlayer.tsx`). No script and no package, and the app never signs in to Spotify for it.

- **Address**: `https://open.spotify.com/embed/track/<id>`. The ID comes from the song's `spotifyUrl`
  (`spotifyEmbed.ts`) and only letters and digits are copied, so the frame can only point at
  Spotify's player. A link that is not a track link (the offline mock only has search links) shows
  the plain "Open in Spotify" link instead.
- **Size**: 152px tall, Spotify's compact size for one song. Spotify wants at least 280px of width.
  A 360px phone leaves the screen 264px, so the player reaches 12px into the screen's padding
  (288px); a page narrower than 352px gets less than 280px.
- **Fit**: the player is about 110px taller than the old button. A one-line title still fits a
  664px-high phone without scrolling; a three-line title or the open info tooltip makes the screen
  scroll (the tooltip already did on short phones). The screen is one scroller shared with the song
  list, so the song page resets it to the top when it opens.
- **Playing**: all of it is Spotify's own controls. Seen in Chrome 156 with no Spotify sign-in: a
  "Preview" badge, playback in the page, and after about 30 seconds a "Listen to the full track and
  millions more on Spotify" panel with a Get Spotify button and a close button that brings the
  player back. Not tried signed in to Spotify. Spotify also says the embed will in some situations
  "only stream a preview clip of less than 30 seconds", and that without `encrypted-media` in the
  iframe's `allow` list it only allows previews, so keep that list as Spotify gives it. Going back
  to the list removes the frame and stops the song.
- **Opening the song in the Spotify app**: the Spotify logo in the player's corner, the title and
  (after the preview) Get Spotify all lead to `open.spotify.com/track/<id>?go=1...`. On a computer
  that opens a new tab; with `go=1` the page navigates to `spotify://track/<id>` and stays on the
  web page when nothing takes that over. All of this was seen in Chrome 156, except the browser's
  own "Open Spotify?" prompt, which headless Chrome cannot show. The plain
  `open.spotify.com/track/<id>` link the old button used did not try the app. On a phone the same
  tap replaces our page with Spotify's mobile track page, whose deep link is what opens the app
  (seen in phone emulation only, not on a real phone), and Back returns to the results list, not
  to the song.
- **Not handled**: if Spotify's page cannot load (an extension blocks it, no network) the frame shows
  the browser's error page and no fallback link appears. The page cannot tell: Chrome still fires
  `load` for the error page, and the frame is unreadable either way. Telling would take a second
  request to Spotify or its iFrame API script.
- **Cookies**: the player comes from `open.spotify.com` and sets Spotify's own cookies. The credits
  page says so, as Spotify's embed terms ask of sites that embed.
- There is no Content-Security-Policy today. If one is added, it needs `frame-src https://open.spotify.com`.

## Code

| File | What |
| --- | --- |
| `src/lib/client/flow.ts` | Pure reducer for the whole flow (steps, the mic step's screens, hold status, results, picks). |
| `src/lib/client/display.ts` | Plain-word labels, octave wording, info tooltip text, range bar and pitch scale math. |
| `src/lib/client/api.ts` | The only HTTP client (paths and shapes from `contracts.ts`). |
| `src/lib/client/mic.ts` | `Mic`/`MicRecorder` interface (`permission()`, `open()`, `live()`, `resume()`); `MicError` and what each `getUserMedia` failure means (`classifyMicError`); AudioWorklet with ScriptProcessor fallback. `open()` never waits for the audio to start (a browser may hold it back until a tap, and a promise that never settles would leave a blank screen) and lets go of the microphone if anything after the question fails; the sample buffer keeps only the latest sound while nobody is recording. |
| `src/lib/client/browser.ts` | The browser and OS from the user agent, and which app's built-in browser it is (`detectBrowser`); the Android Chrome intent link. |
| `src/lib/audio/level.ts` | `isDigitalSilence`: a take of only zeros, which is a microphone the system muted, not a quiet singer; `MIN_MUTED_SAMPLES`, below which a take is a tap. |
| `src/lib/client/storage.ts` | Guarded `sessionStorage` for test progress and the pick-songs intent; `localStorage` for a range kept on the device. |
| `src/lib/songs/browse.ts` | Sliders, chips, counts and the "Saved, not played lately" divider, as pure functions over every match. |
| `src/lib/client/funnel.ts`, `events.ts` | What each action records in the beta event log, and the batching tracker that sends it. |
| `src/lib/client/spotifyEmbed.ts` | A song's `open.spotify.com/track/ID` link to the address of Spotify's player, or null. |
| `src/components/KaraokeApp.tsx` | Client component: effects, mic handling, renders each step. Takes `api`, `mic`, `navigate`, `reload`, `quietMs` props for tests. |
| `src/components/{Tv,Lyric,HoldStep,Results,SongDetail,PickSongs}.tsx` | The screen pieces. |
| `src/components/RoundButton.tsx` | The round pink-ringed button, shared by the record button (`HoldStep.tsx`, a dot in it) and "Turn on microphone" (`MicStep.tsx`, a microphone in it), so the two keep one look. |
| `src/components/MicStep.tsx` | The mic step's screens. |
| `src/components/SpotifyPlayer.tsx` | Spotify's player iframe, or the plain "Open in Spotify" link when there is no track to embed. |
| `src/components/screen.module.css`, `app/globals.css` | Styles; `prefers-reduced-motion` stops all animation. |

## Tests

```sh
npx vitest run tests/screen      # reducer, display math, API client, sample buffer, app with fake mic/API
npx playwright test              # builds + starts the app, mocks /api/*, fake mic WAVs
E2E_PORT=3107 npx playwright test  # same, on another port (avoids reusing another checkout's server)
```

The e2e spec generates a 110 Hz (A2) and a 523.25 Hz (C5) WAV and feeds them to
Chromium's fake microphone. Chromium takes one file per launch, so the low note is sung
in one browser and the high note in a second one that picks up the saved progress.
`mic-permission.spec.ts` covers the mic step with Chromium's fake microphone and the user agents of iPhone Safari, Android
Chrome and the in-app browsers: granted, refused (and closed without an answer), already allowed, already blocked, the
browser's question left unanswered (and the reload after 12 s), a microphone taken away mid-note (our screen again
though the browser says yes), a quick tap on the record button, and the sizes. What a real iPhone and Android phone do
with those screens is checked by hand.
Named screenshots land in `test-results/screens/`. The specs never load Spotify's player from
Spotify: the screen spec answers `https://open.spotify.com/embed/**` with a stand-in page, and the
full-stack spec (offline mock, search links only) shows the plain link.
