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
5. **Range + arrow**: "That's your range A2 – C5", a wordless arrow bouncing bottom-right
   (`aria-label="Continue"`) and "or use songs from your Spotify". The arrow goes straight to
   catalogue results with no sign-in (QWW-2 Track B); the range is kept on the device
   (`localStorage` `kd.range`). The text button keeps the range in `sessionStorage` (`kd.test`) and
   goes to `/api/auth/login`.
6. **Results**: one request for every match (`/api/catalogue/recommendations?...&all=1` without
   Spotify, `/api/recommendations?all=1` with it), then the phone sorts, filters and pages them
   (`src/lib/songs/browse.ts`), 5 at a time. A row of sort pills (one picked) and a row of chips
   (decades, moods, duets; one pick per row, a count on each, disabled at zero) sit above the list;
   the lyric line says what the sort does. Songs whose range is only an estimate
   (`difficulty: 'maybe'`) show last in their own "Maybe" list, without a difficulty pill. In
   catalogue mode "Connect Spotify" saves the range for the sign-in round trip; back from Spotify,
   it is PUT to `/api/me/range` and library results load.
7. **Song detail**: range bar (song in neon pink over the user's range, note names at the
   ends), difficulty (or a quiet "Maybe"), "Fast lyrics", an "i" button explaining where the
   data came from (for Maybe songs, also that the range is an estimate), Open in Spotify, and
   "How'd it go?" thumbs that POST `/api/feedback`.
8. **Returning user** with a saved range lands on results; "redo" restarts the test. Someone
   without Spotify whose range is kept on the device lands on catalogue results.
9. **Pick songs**: a signed-in user picks up to 3 songs from `/api/songs/known`; the lowest
   low and highest high become the range (`source: 'songs'`). Signed-out users sign in first.

## Code

| File | What |
| --- | --- |
| `src/lib/client/flow.ts` | Pure reducer for the whole flow (steps, hold status, results, picks). |
| `src/lib/client/display.ts` | Plain-word labels, octave wording, info tooltip text, range bar and pitch scale math. |
| `src/lib/client/api.ts` | The only HTTP client (paths and shapes from `contracts.ts`). |
| `src/lib/client/mic.ts` | `Mic`/`MicRecorder` interface; AudioWorklet with ScriptProcessor fallback. |
| `src/lib/client/storage.ts` | Guarded `sessionStorage` for test progress and the pick-songs intent; `localStorage` for a range kept on the device. |
| `src/lib/songs/browse.ts` | Sorts, chips, counts and the "Saved, not played lately" divider, as pure functions over every match. |
| `src/lib/client/funnel.ts`, `events.ts` | What each action records in the beta event log, and the batching tracker that sends it. |
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
