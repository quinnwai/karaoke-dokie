# Screen (frontend)

The whole app is one karaoke TV centered on a dark page. Every step happens on its
screen, with instructions sung in like karaoke lyrics. One accent color: hot pink.

The TV is phone-shaped on every screen and every step (Round 6A §3.3, QWW-57, review item R2): 390 px wide and
min(844 px, the window less 32 px) tall, centred, with the bezel padding 9 9 0, bezel radius 30, screen radius 22 and a
34 px chin with the LED. On a phone (up to 430 px wide) it is the whole screen instead: page padding 14 10 12 (or the
safe-area insets, if larger), no height cap. Text that scales with the window width (`--vw`) stops growing at a phone's
width, so a wide window shows the phone's type, not a bigger one. There is no wider TV and no column inside one. A phone on
its side is wider than 430 px and would get a 328 px TV with no room for songs, so on a touch screen in landscape under 500 px
tall (`(hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 500px)`) a full-screen "Turn your
phone upright" covers every step (`RotateNotice`, drawn by `Tv`). It is only drawn over the page, so turning the phone back
finds the screen, the tuner and a running mic step as they were. A tablet (taller than 500 px) and a desktop never see it.

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
     375x553: an iPhone SE with Safari's toolbars showing. The button has a dark backdrop (to hide the words that scroll
     under it) only while it is held up over them: `Main` in `MicStep.tsx` turns it on when the browser reports a sliver
     of the button cut off at the bottom edge (it is set 2px below it), and off once everything fits or the screen is
     scrolled to its end. A backdrop on a screen that fits would be a dark band across the glow of the screen.
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
   it lands here: `?authError` is taken out of the address and one quiet line, "Couldn’t sign in. Spotify
   sign-in is for invited testers only right now.",
   shows under the arrow, and again under the bar of the results the arrow leads to. `access_denied` is the
   singer pressing Cancel on Spotify's page, which is their answer, so nothing is said.
7. **Results: the Setlist tuner** (QWW-46, the round 5 design, spec and reference in `docs/setlist-round5/`; reskinned in
   QWW-57 as Round 6A, "neon signs", in `docs/setlist-round6a/`, which also lists where production differs from it).
   It is on the TV like every other step, with no second bezel; it fills the TV's screen and only its list scrolls. The
   TV is phone-shaped and fills the viewport on a phone (see the top of this file). One request for every
   match (`/api/catalogue/recommendations?...&all=1` without Spotify, `/api/recommendations?all=1` with it); then
   the screen sends what is set on the sheet to the ranking engine (`src/lib/setlist/engine.ts`, asked through
   `useRankedSetlist`) and draws the ranked list it gets back (`SetlistResponse`, the shape of QWW-47's
   `POST /api/setlist`). The screen holds no ranking: the server's engine
   (QWW-47, `src/lib/songs/setlist.ts`) ranks, and `createNetworkEngine` asks it with the request (`limit` 200, the most one
   request may ask for; the screen shows 40 at a time). A slider drag asks once the thumb has rested 120 ms, and a request
   a newer one replaced is aborted. The list keeps the last answer until its own arrives. `libraryUnavailable` comes in the answer.
   - **The header**: a 28 px row with the singer's range (each note re-sings that end), **redo** (re-sings both), the
     カラオケ sign and the Spotify logo at the far right. The sign is centred on the row's own middle (R1: the row's
     centre, to a pixel, not the room between redo and the logo). It shrinks from 16 px down to 13 px to keep 8 px clear of
     redo and the logo, and is hidden, not moved, only when 13 px does not fit (`signSize` in `fit.ts`, measured by
     `useSignFit`; the longest range on a 360 px phone). The notes
     and redo are 44 px tall to tap, and turn pink on hover and on keyboard focus (R9). The heading is below the row.
   - **The list**: a row (66 px) is the slot (44 px) with the rank number, the title over "Artist · Era" (`’90s`) over a
     **reason line**, and a **difficulty badge**. The slot holds the rank number and the ▶ on top of each other (R3): on a
     pointer device the number shows and a hover on the row, or keyboard focus on the ▶, swaps it for the ▶ (the glyph
     alone, no ring or circle); on a touch screen, which cannot hover, the ▶ stands in the number's place and the number
     is not drawn. A ▶ that cannot play (the song has no preview) is faded and disabled; a preview that is loading, playing or
     paused shows its ⏸ or ▶ with no hover. The number is hidden from a screen reader (the list is an `<ol>`) and the rank is also in
     `data-rank`. The reason line is
     `whyOf` in `src/lib/setlist/rows.ts`: the first two of "In your sweet spot" (Difficulty on, the song's place within 15
     of it), "Crowd favourite" or "Deep cut" (place on Popularity at least 85, or at most 35), "On repeat" or "Rediscover"
     (History at least 85, or at most 20), and when none holds "Gets the room moving" / "Slow burner" / "Solid pick"
     (Tempo at least 70, at most 25, or unknown). The places are the engine's, percentiles among the songs that fit the
     singer; a place that is null skips its rule, so a signed-out singer never sees the History ones. A song that fits only an octave away says "Shifted down to fit range" or "Shifted up to fit range" and nothing else (R13; its badge stays). The badge is the song's
     own label (what the song page shows); a Maybe song has none. Each title fills in once, left to right (about 0.6 s,
     `useFillIn`), as its row scrolls into view, and ends the normal white. It plays once per visit, and a visit lasts until the
     singer's range changes (redo) or the page is reloaded: a row that scrolls out and back, is re-ranked, leaves when an era
     is untapped and comes back, or comes back after a song page and Back, does not replay it (R12; `KaraokeApp` keeps the
     memory, `useFillMemory`; with reduced motion there is no fill). The ▶ is QWW-48's
     play button (Play from the list, below), and a line under the list, over the credits link, shows Deezer's logo while a song on
     screen has a preview. Rows are in rank order in the DOM, and slide to their new place when
     the order changes (`flip.ts`; reduced motion turns it off). Tapping a row opens the song page; the ▶ does not.
     40 songs show at first, then "Load more". Songs with no year are in the list while Era is off and out of it
     while Era is on. When there are no songs the engine says why (`empty`): "Pick an era to see songs." (Era on,
     nothing picked), or a line saying none of the picked eras fit the range.
   - **The sheet**: four gears (Difficulty, Popularity, Tempo, Listening history: the one that has to be unlocked is last,
     in the strips and in the tabs, R11; `SHEET_GEARS` in `gears.ts`) and a multi-select Era. The History strip reads
     "LISTENING HISTORY" (its tab says "History") and sets its type by the strip's width so it is never cut off (R6). Every
     strip and the Era panel have a grey border (`--sl-rail`) in every state; only the selected mini tab has a gear-coloured
     border and glow, and on a pointer device an idle tab shows its border when hovered and an unpicked era button a pink
     one, with no glow (R5, R10). The top of the sheet has no pink (R8). **Reset** on
     a gear puts it back to its default (`src/lib/setlist/defaults.ts`, the one place) and turns it **off**: it
     counts for nothing, its art goes dark (unlit neon tubes; no dimming), and touching it again turns it on from the
     default, with a short neon flicker. The History notes, the Popularity bolts and the tabs' rays that the value has not
     reached are drawn unlit rather than hidden, and light as it reaches them (R7). Era off means every era. The Era panel's header counts the songs that fit
     (`SetlistResponse.total`, every song that fits the range and the picked eras, not the loaded page): "ERA · 1,204 songs".
     **Defaults** (QWW-47's decision): Popularity 100 and Difficulty 0 on; History 100, Tempo 50 and Era off, and Era
     has no default picks (the first tap on an era picks just that era). Signed out, History is also disabled and says
     "Connect Spotify to use your listening history" (or the unreachable line, when the engine says the library could
     not be read), drawn as an off gear in place of its end labels; signed in, it can be switched on. **Expanded** shows
     every gear (rack 416 px); **mini** shows one gear and a tab bar (164 px). The grab handle switches by tap, Enter or
     Space, or by a vertical drag (`touch-action: none`, so it never scrolls the page) that resizes the rack live.
     **Which mode it opens in** (`src/lib/setlist/fit.ts`, measured in `useSheetFit`): mini when the expanded sheet
     would leave fewer than 3 whole rows (every phone but a tall one; a 390×844 still opens expanded), and where the
     expanded sheet cannot fit inside the screen at all (an iPhone SE with Safari's bars) the handle
     keeps it mini. `?mini=1` always starts in mini mode.
   - **Type**: Inter 400, 500, 600 and 700, self-hosted (`@fontsource/inter`, SIL OFL 1.1), and Noto Sans JP 700
     subset to the four characters of the sign (`src/components/setlist/fonts/`). The earlier steps keep the system font.
   - **Events**: `gear_change` (gear, value, on) when a thumb is let go or a gear is reset, `era_change` (era, picked,
     on, eras) on an era tap or reset. `song_opened` and the like carry each gear's target (null when off).
   - **Tests**: `window.setlist` (`getState`, `setState`, `ranking`, `songs`) exists only in a build made with
     `NEXT_PUBLIC_SETLIST_TEST_HOOK=1`, which is the e2e build (`playwright.config.ts`); production has none.
   In catalogue mode "Connect Spotify" saves the range for the sign-in round trip; back from Spotify,
   it is PUT to `/api/me/range` and library results load. The Spotify logo at the top right shows
   which mode this is: grey ("Connect to Spotify") without an account, Spotify green when signed in.
   Signed in, pointing at it (or a tap) opens a small box, "Logged in as <display name> · Log out";
   Log out POSTs `/api/auth/logout`, forgets the library and shows catalogue results for the same
   range, which stays on the device (`kd.range`). If the request fails the box says so and nothing changes.
   When the server cannot read the singer's Spotify library (Spotify says wait, fails or is down) it answers
   `/api/recommendations?all=1` with the catalogue's songs for their range and `libraryUnavailable: true` (QWW-55).
   The list is then a catalogue list (History disabled, no connect prompts) for a singer who stays
   signed in, with the green logo, Log out and one quiet line above the list: "Couldn’t reach Spotify, showing
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

## Play from the list (QWW-48)

The first slot of each song row holds a play button that plays the song's 30 s Deezer preview, so a singer can hear a
song without leaving the list. Spotify's player stays on the song page (below); it was too slow to start from our own
button and must stay on screen (spike QWW-44).

- **One player.** Every button shares one `<audio>` element (`src/lib/client/preview.ts`), so one song plays at a
  time and a tap on another row switches at once. The latest tap always wins: five taps in five seconds end with the
  fifth song playing. The player holds a row (its track id), not a Deezer track, so two rows that share a Deezer
  track never both show ⏸.
- **iOS.** The tap handler sets the element's address to `/api/preview/<deezerId>` and calls `play()` in the same
  tick; iOS plays audio only when it starts inside the tap. That route redirects to Deezer's preview link (see
  backend.md), which expires after 15 minutes, so links are never stored.
- **What it shows.** ▶ until tapped; then ⏸. Tapped again it pauses; a pause by the phone (a call, the lock screen,
  headphones) shows the same, and a resume from there shows ⏸ again. At the end it goes back to ▶. The button is 44 px
  square. The button itself draws a thin pink ring that fills as the preview plays and marks the playing row's title in
  pink, as Spotify marks the track it is on; in the tuner neither is shown (QWW-57: R3 has no ring or circle in any state,
  R12 has every title end white), so the row that sounds is the one with ⏸ in its slot.
- **When there is nothing to play.** A song with no Deezer match (`Match.deezerId` unset) gets a disabled button. A
  preview that fails to load before making a sound goes back to ▶ at once, and the player asks the route why: only a
  404 (Deezer has no preview) disables the button for the rest of the visit. Any other failure (Deezer slow or down,
  the network) leaves ▶ ready for another tap. A resume after a pause of more than 4 minutes, or after the load failed
  while paused, starts from a fresh link at the same spot, since a link can run out.
- **The row.** The play button (in the slot) and the song button sit side by side, never one inside the other: the play
  button never opens the song page, and the rest of the row still does. Opening the song page (or a filter taking the song off
  the list) stops the preview.
- **Deezer.** Deezer's API terms ask every app that uses it to show its logo clearly, so a line under the list reads
  "Previews from [logo] Deezer" whenever a song on it has a preview. It links to the credits page, which says the
  previews stream from Deezer for private, non-commercial listening and that no audio is kept, as the terms ask
  listeners to be told.
- **In the tuner (QWW-46, QWW-57).** `PreviewButton` takes the row's track id (`id`), the song's `deezerId`, title and
  artist, and needs nothing else; `DeezerCredit` is the logo line. `KaraokeApp` hands the screen a `renderPlay` that
  mounts the button in each row's slot (a test can pass its own), and the slot's CSS (`rows.module.css`) restyles it: the
  44 px target, the glyph alone, the swap with the rank number, the faded disabled look. Without a `renderPlay` the
  screen shows an inert, disabled ▶ and no Deezer line.

## Spotify player

The song detail embeds Spotify's own player: the plain iframe from Spotify's
[creating an embed](https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed)
tutorial (`SpotifyPlayer.tsx`). No script and no package, and the app never signs in to Spotify for it.

- **Address**: `https://open.spotify.com/embed/track/<id>`. The ID comes from the song's `spotifyUrl`
  (`spotifyEmbed.ts`) and only letters and digits are copied, so the frame can only point at
  Spotify's player. A link that is not a track link (the offline mock only has search links) shows
  the plain "Open in Spotify" link instead. That link and the "Find on Spotify" one end with an external-link icon
  (a box with an arrow leaving it, about 0.8 em, in the link's own colour and hidden from a screen reader; R4): the
  names a screen reader hears are unchanged.
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
| `src/lib/setlist/` | The Setlist tuner without React: `types.ts`, `defaults.ts` (every default), `tuner.ts` (reducer, request), `sheet.ts` (geometry, drag rules), `art.ts` (gear art and lane maths), `engine.ts` (the ranking port and the network engine), `rows.ts`, `eras.ts`, `gears.ts` (labels). |
| `src/lib/client/useRankedSetlist.ts` | Asks the engine for the list that goes with the tuner, drops answers that arrive after a newer request. |
| `src/lib/songs/browse.ts` | The old sliders, chips and counts (no longer used by the screen; QWW-47 owns what becomes of them), and `difficultyBand` and `decadeOf`, which the tuner reads. |
| `src/lib/client/funnel.ts`, `events.ts` | What each action records in the beta event log, and the batching tracker that sends it. |
| `src/lib/client/spotifyEmbed.ts` | A song's `open.spotify.com/track/ID` link to the address of Spotify's player, or null. |
| `src/components/KaraokeApp.tsx` | Client component: effects, mic handling, renders each step. Takes `api`, `mic`, `navigate`, `reload`, `quietMs` props for tests. |
| `src/components/{Tv,Lyric,HoldStep,SongDetail,PickSongs}.tsx` | The screen pieces. |
| `src/components/RotateNotice.tsx` | "Turn your phone upright", over every step on a touch screen in landscape under 500 px tall (drawn by `Tv`; its media query is in `screen.module.css`). |
| `src/components/setlist/` | The Setlist tuner: `SetlistScreen`, `Sheet`, `GearStrip`, `EraPanel`, `SongRows` (+ `flip.ts`), `GearArt`, and `setlist.module.css` (its tokens are `--sl-*`). |
| `src/components/SpotifyAccount.tsx` | The signed-in Spotify logo and its "Logged in as ... · Log out" box. |
| `src/components/RoundButton.tsx` | The round pink-ringed button, shared by the record button (`HoldStep.tsx`, a dot in it) and "Turn on microphone" (`MicStep.tsx`, a microphone in it), so the two keep one look. |
| `src/components/MicStep.tsx` | The mic step's screens. |
| `src/components/SpotifyPlayer.tsx` | Spotify's player iframe, or the plain "Open in Spotify" link when there is no track to embed. |
| `src/components/PreviewButton.tsx`, `src/lib/client/preview.ts` | The play button in each row, its hook and the one shared `<audio>` they drive (QWW-48); the Deezer logo line. |
| `src/components/screen.module.css`, `app/globals.css` | Styles; `prefers-reduced-motion` stops all animation. |

## Tests

```sh
npx vitest run tests/screen      # reducer, display math, API client, sample buffer, app with fake mic/API
npx playwright test              # builds + starts the app, mocks /api/*, fake mic WAVs
E2E_PORT=3107 npx playwright test  # same, on another port (avoids reusing another checkout's server)
```

`tests/e2e/setlist.spec.ts` is the Setlist tuner's acceptance suite (spec section 9, tests 1 to 21, at 390×844, plus
touch drag, short phones and long titles). CI runs it in Chromium. It also passes in WebKit, the engine behind iPhone
Safari (a config with `browserName: 'webkit'`; the three DevTools touch tests are Chromium-only and skip there), which
is how the drag and slider behavior was checked without a real iPhone. Its fixture is the spec's 25 mock songs
(`tests/fixtures/setlist.ts`).
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
