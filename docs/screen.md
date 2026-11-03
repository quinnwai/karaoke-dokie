# Screen (frontend)

The whole app is one karaoke TV centered on a dark page. Every step happens on its
screen, with instructions sung in like karaoke lyrics. One accent color: hot pink.

## Flow

1. **Landing**: カラオケ sign, a round Start button, and "or pick songs you sing well".
2. **Find a quiet spot**: lyric line, moves on by itself after ~2.6 s (or tap).
3. **Lowest note**: press and hold the round button (Space/Enter also work). While held,
   the mic records and a dot moves on a C2–C6 scale with the current note. On release,
   `detectHeldNote` runs on the recording. Too short a hold → "Try again…" lyric.
4. **Highest note**: same button; the low note shows small in the corner. A high note at
   or below the low one asks to go higher.
5. **Range + arrow**: "That's your range A2 – C5" and a wordless arrow bouncing bottom-right
   (`aria-label="Continue"`) that goes to `/api/auth/login`.
6. **After sign-in** (`/?signedIn=1`): the range kept in `sessionStorage` (`kd.test`) is
   PUT to `/api/me/range`, then results load 5 at a time from `/api/recommendations`.
   Songs whose range is only an estimate (`difficulty: 'maybe'`) arrive last and show in
   their own "Maybe" list after the main one, without a difficulty pill.
7. **Song detail**: range bar (song in neon pink over the user's range, note names at the
   ends), difficulty (or a quiet "Maybe"), "Fast lyrics", an "i" button explaining where the
   data came from (for Maybe songs, also that the range is an estimate), Open in Spotify (the
   app first, then the web player; see below), and "How'd it go?" thumbs that POST `/api/feedback`.
8. **Returning user** with a saved range lands on results; "redo" restarts the test.
9. **Pick songs**: a signed-in user picks up to 3 songs from `/api/songs/known`; the lowest
   low and highest high become the range (`source: 'songs'`). Signed-out users sign in first.

## Open in Spotify

The link keeps its real `https://open.spotify.com/...` address, so it still works as a link
with JavaScript off, on middle-click, cmd/ctrl-click and long-press. Only a plain click on a
computer (a mouse or trackpad: `(hover: hover) and (pointer: fine)`) is taken over
(`src/lib/client/spotifyLink.ts`):

1. The address becomes a `spotify:` link (`/track/ID` to `spotify:track:ID`; the offline mock's
   `/search/...` links work too) and the page navigates to it. The browser asks "Open Spotify?".
2. If the page loses focus, hides or unloads within 1.5 s, the app (or its prompt) took over and
   nothing more happens.
3. Otherwise (no app, or the prompt was declined) the web player opens in a new tab, or in this
   tab if the browser blocks the popup.

Phones and tablets keep the plain link: it already opens the Spotify app when it is installed
(universal links on iPhone, app links on Android), and a `spotify:` address is the riskier route
there (iPhone asks first; Chrome on Android shows an error page if the app is missing).

Browsers give a page no "declined" event, so step 3 is a timer: someone who sits on the prompt for
more than 1.5 s without the page losing focus may get the web tab as well. Links that aren't
`open.spotify.com` addresses (for example an empty one) are left to the browser. Only desktop
Chrome has been tried; Firefox and Safari deal with a `spotify:` address that nothing handles in
their own ways, and are untested.

## Code

| File | What |
| --- | --- |
| `src/lib/client/flow.ts` | Pure reducer for the whole flow (steps, hold status, results, picks). |
| `src/lib/client/display.ts` | Plain-word labels, octave wording, info tooltip text, range bar and pitch scale math. |
| `src/lib/client/api.ts` | The only HTTP client (paths and shapes from `contracts.ts`). |
| `src/lib/client/mic.ts` | `Mic`/`MicRecorder` interface; AudioWorklet with ScriptProcessor fallback. |
| `src/lib/client/storage.ts` | Guarded `sessionStorage` for test progress and the pick-songs intent. |
| `src/lib/client/spotifyLink.ts` | "Open in Spotify": `open.spotify.com` link to `spotify:` link, try the app, fall back to the web player. |
| `src/components/KaraokeApp.tsx` | Client component: effects, mic handling, renders each step. Takes `api`, `mic`, `navigate`, `quietMs` props for tests. |
| `src/components/{Tv,Lyric,HoldStep,Results,SongDetail,PickSongs}.tsx` | The screen pieces. |
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
Named screenshots land in `test-results/screens/`.
