# Backend

Route handlers live in `app/api/**/route.ts` and are thin wrappers around
`src/lib/server/handlers.ts`. Shared types and the route list are fixed in `src/lib/contracts.ts`.

## Routes

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/api/auth/login` | | 302 to Spotify (or straight to the callback with `SPOTIFY_MOCK=1`); sets a 10-minute `kd_oauth_state` cookie |
| GET | `/api/auth/callback` | `code`, `state` | Checks state, stores the user and tokens, sets the `kd_session` cookie, 302 to `/?signedIn=1`. On failure 302 to `/?authError=<reason>` (`state`, `spotify`, `missing-code`, or Spotify's `error`, which is logged unless it is `access_denied`). Makes no Spotify request while Spotify has told the app to wait (see Spotify rate limit): it is `authError=spotify` at once, and a 429 on the profile step starts that wait |
| POST | `/api/auth/logout` | | `{ ok: true }`, clears the session cookie |
| GET | `/api/me` | | `MeResponse` |
| PUT | `/api/me/range` | `VocalRange` | `{ ok: true }`; 400 unless `low`/`high` are integers, 28 <= low < high <= 96, span 5..48, `source` is `test` or `songs` |
| GET | `/api/recommendations` | `offset` (default 0), `limit` (1..50, default 5), or `all=1` | `RecommendationsResponse`; songs with a low-confidence range come last with `difficulty: 'maybe'` (the Maybe group); 409 `{ error: 'no-range' }` before a range is saved. `all=1` ignores `offset` and `limit` and sends every match (at most 1,000, the best-ranked) with its `year` and `yearSource` (the earlier of USDB's and Spotify's album year, else the Billboard Year-End chart year, `chart`), `genre` (USDB's), USDB views and stars for songs whose range has none, and no pitch histograms; it is ranked with karaoke popularity too (see Song popularity), which is not sent. `complete: true` when that is every match. `complete: false` with a `nextOffset` means lookups ran out of budget (a first visit to a very large library): ask `all=1` again to carry on, not a page from `nextOffset`, since pages rank without the USDB and karaoke popularity. `complete: false` with `nextOffset: null` means the list was cut at 1,000 |
| GET | `/api/songs/known` | | `KnownSongsResponse` (up to 50 library songs with a known range, play order); `{ songs: [], libraryUnavailable: true }` when the library cannot be read |
| POST | `/api/feedback` | `FeedbackRequest` (`difficulty` may be `maybe`; optional `view`, the results view the song was found in) | `{ ok: true }`; 400 on bad input, including a `view` without `difficulty`, `familiarity` and `popularity` that are each null or a number from 0 to 1, a `decade` and `mood` that are known or null, and a boolean `duetsOnly`; 409 before a range is saved. Stored with the user's current range, the view (`view_json`) and, when the song is in the cached library, its range at that moment (`range_source` = the log outcome, `range_method`, `range_low`, `range_high`); the tap never loads the library from Spotify |
| GET | `/api/admin/log` | header `x-admin-token`, `limit` (1..1000, default 200) | `{ entries: DataSourceLogEntry[] }`, newest first; 403 on a wrong token or when `ADMIN_TOKEN` is unset |
| GET | `/api/catalogue/recommendations` | `low`, `high` (the range: integers, 28 <= low < high <= 96, span 5..48), then `all=1` or `offset`/`limit`; no session | `RecommendationsResponse` from the public catalogue (QWW-2 Track B): every song with a note-file or recording range, most-viewed USDB row and karaoke popularity attached, cached per process for an hour (the 6,000 most popular, plus every Billboard Year-End song). Tracks have `cat:<songKey>` ids and Spotify search links, `known: false`, so no familiarity reasons. `all=1` sends at most the best 1,000 matches with year (USDB's, else the Year-End chart year) and genre; `complete: false` and `nextOffset: null` when trimmed. 400 on a bad range |
| POST | `/api/catalogue/feedback` | `CatalogueFeedbackRequest`: the feedback fields plus `anonId` (8 to 64 of `[A-Za-z0-9-]`) and `range`; no session | `{ ok: true }`; stored with `user_id = 'anon:' + anonId`, the range, and the song's range snapshot looked up by key. 400 on bad input or a `trackId` that is not `cat:` |
| POST | `/api/events` | `EventsRequest`, as JSON or as the `text/plain` body `navigator.sendBeacon` sends; no session | 204, storing nothing while `EVENTS` is off. 400 on bad input, checked even when off: `anonId` 8 to 64 of `[A-Za-z0-9-]`; 1 to 50 events; `name` matching `^[a-z][a-z0-9_]{1,48}$`; `at` an ISO time with a zone, within 7 days of the server clock (stored as UTC); at most 20 props named `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`, each a string of up to 200 characters, a finite number, a boolean or null. Props named `trackId`, `spotifyId`, `userId`, `displayName` or `email` (any case, underscores ignored) are dropped before storing |
| GET | `/api/admin/events` | header `x-admin-token`, `limit` (1..20000, default 5000) | `AdminEventsResponse` from the newest `limit` events (see Beta event log); 403 like `/api/admin/log` |

Errors are JSON `{ error, message? }`. Every user route returns 401 `{ error: 'signed-out' }`
without a valid session. A Spotify failure is never an error response (QWW-55; it was a 502 and an empty
screen): when the signed-in user's library cannot be read (429, a 5xx, a network error, a refused token),
`/api/recommendations` answers 200 with the catalogue's songs for the user's range, built as
`/api/catalogue/recommendations` builds them, and `libraryUnavailable: true` (paged or `all=1`), and
`/api/songs/known` answers 200 with no songs and the same flag. The reason goes to the server log as
`[spotify] could not load the library: ...`. A read that takes longer than `LIBRARY_DEADLINE_MS` (50 s, inside
the routes' 60 s `maxDuration`) gets the same answer, so a stalled Spotify is never the host's own timeout; the
read carries on and, if it finishes, is cached for the next request.

### Paging

`songService.recommend` looks songs up in play order (top tracks, then saved songs), up to 1,000
uncached lookups per request, ranks the whole library, then pages it, so pages never repeat or skip
a song. The screen asks once with `all=1` and sorts, filters and pages the list itself. If lookups
ran out of budget (a first visit to a very large library), `all=1` returns `complete: false` with a
`nextOffset`, and the screen asks `all=1` again, a few times at most.

## Environment

| Variable | Meaning |
| --- | --- |
| `SESSION_SECRET` | Required, 16+ chars. HMAC-SHA256 key for the session cookie |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` | Required unless `SPOTIFY_MOCK=1`. Redirect URI is the full `/api/auth/callback` URL |
| `SPOTIFY_MOCK` | `1` uses the offline mock client (user "Test Singer", 25 well-known songs) and, with the memory store, seeds the placeholder songs in `data/seed-song-ranges.json`. Also on whenever real Spotify is not allowed (see Stored library per user) |
| `SPOTIFY_LIVE` | `1` allows real Spotify outside a Vercel preview or production (a script's `--live` sets it). Unset elsewhere, so local runs, CI and agents never spend the shared quota |
| `DATABASE_URL` | Postgres (Neon) connection string |
| `KARAOKE_STORE` | `memory` forces the in-memory store |
| `ADMIN_TOKEN` | Token for `/api/admin/log` and `/api/admin/events`; unset disables both |
| `EVENTS` | `on` or `off`: whether `POST /api/events` stores beta events. Unset or blank, it is on only when `NODE_ENV=production`, `SPOTIFY_MOCK` is not `1` and the store is Postgres, so tests, e2e and local dev collect nothing. Any other value counts as off |
| `DUETS_AND_MOODS` | `on` shows duets and moods on screen; unset, blank or any other value (`1`, `true`, a typo) hides them (QWW-43). Off, the four recommendation responses (`/api/recommendations` and `/api/catalogue/recommendations`, paged or `all=1`) carry no `moods` and no duet markers (`range.duet`, `range.parts`, `part`, `partSinger`), so the Duets and mood chips, the "Duet: take ..." lines and the song-page mood pills never appear. It is applied after ranking (`src/lib/server/features.ts`), so the songs and their order are the same either way; a duet is still scored on the part that fits the singer |
| `MOODS_SHIPPED` | Comma-separated moods (`upbeat`, `heartfelt`) allowed on screen as chips, while `DUETS_AND_MOODS=on`. Set a mood here only after it passes the QWW-11 precision gate (`npm run moods:report`). Unset = no mood chips |
| `PICK_SONGS` | `on` shows "or pick songs you sing well" on the title screen and "or use songs from your Spotify" under the range; unset, blank or any other value hides both (QWW-55: one onboarding flow for the first release; the Spotify logo on the list is then the one way to sign in). Read per request by `app/page.tsx` (`pickSongsOn` in `src/lib/server/config.ts`), not baked in at build time, so one build can serve it on or off; no API response changes |

## Store

`getStore()` (`src/lib/server/getStore.ts`) uses the in-memory store when `KARAOKE_STORE=memory`
or `DATABASE_URL` is empty, otherwise Postgres through Neon's HTTP driver. There is one instance per
server process (kept on `globalThis`). The memory store is lost on restart.

## Spotify rate limit (QWW-55)

Spotify's Development Mode quota is one pool for the whole app, and it is not published. On 10 Nov 2026 a few
sign-ins, each reading the user's whole library again, used it up, and Spotify answered 429 (`QUOTA_EXCEEDED`,
`retry-after` 12,098 s) to every call for 3.4 hours: `/api/recommendations` answered 502 and the screen said
"Couldn't load songs".

- **A block is kept in the database.** A 429 whose body says `QUOTA_EXCEEDED`, or whose Retry-After is over 30 s,
  is stored (`spotify_block`, one row) as "blocked until": that Retry-After, an hour when a quota 429 gives none,
  at most a day. It is one value for the whole app, because the quota is the app's, and it is read from the
  store, so every serverless instance and every script sees it. A shorter 429 is waited out inside the request
  (3 retries of at most 10 s; 6 of at most 30 s for saved songs) and blocks nothing. A later block never shortens
  an earlier one. To lift it by hand: `DELETE FROM spotify_block`.
- **No request while it holds.** `loadLibrary` (`src/lib/server/library.ts`), which the library routes and the scripts
  (`--live`) use, checks it first; `readUserTracks` (`src/lib/server/spotify.ts`) is the older whole-library read
  that does the same check. The sign-in callback checks it before the token exchange. A block that cannot be
  read counts as none (logged), and one more than a day away counts as a day, so a problem with that one row
  never hides a healthy Spotify or locks the app for good. A user with a stored library is still served it
  during a wait; one with nothing stored gets the catalogue's songs.
- **Never an error response.** See the paragraph under the routes: catalogue songs and `libraryUnavailable`.

## Stored library per user (QWW-55 PR 2)

A signed-in user's library is read in full once and kept in Postgres (`user_library` for the sync state, `user_saved`
for the liked songs), then synced by reading only what changed (`src/lib/server/library.ts`). There is no cap on likes.

| Part | When it is read |
|---|---|
| Liked songs | Every visit: the first page, then pages until the first song already stored. Spotify's count of liked songs must equal the stored count plus the new songs; if it does not (something was un-liked), the likes are read again in full and the missing songs are dropped. A first read that is cut off (an error, a 429, the 50 s deadline) keeps what it got and resumes from there on the next visit |
| Top tracks (3 spans), recent plays | At most once a day each |
| Playlists | The list of own playlists is checked on a visit (1 request); a playlist's songs are read only when its `snapshot_id` changed |

A visit to a complete library makes at most `INCREMENTAL_BUDGET` (5) requests: the likes check comes first, then
what is due in the order top tracks, recent plays, playlist list, changed playlists; the rest waits for the next
visit. With nothing changed a visit is 2 requests. The first read and a resumed one are not limited. When a sync
fails, the stored library is served as it is. Spotify's count of liked songs must equal the stored count plus the new likes; when it does not, a
song was un-liked, and a check pass reads the likes again, 3 pages per visit (`VERIFY_PAGES_PER_VISIT`), marking each song
seen (`user_saved.gen`). When the pass has seen every item Spotify counts, the songs it did not see are removed, so an
un-like disappears a few visits later (a library of 11,000 likes: about 75 visits), never in one expensive visit. If the
pass does not account for every item (the library changed while it ran), nothing is removed and it runs once more.
The budget counts real HTTP requests (the client counts each one, retries and playlist pages included, and refuses to send
more); a changed playlist that needs more pages than are left is read at a later visit. Other limits: new likes beyond the
first page are read before anything else whatever the budget; a first read resumed after the library changed can
miss a few songs until a later count mismatch; two simultaneous visits of one user (two instances) are not
coordinated and can both read.

**Spotify's terms**: songs un-liked on Spotify are dropped on each sync; `POST /api/auth/disconnect` (signed in)
deletes the user's stored library, clears the session and keeps the vocal range (the app has no button for it yet);
a library not visited for 30 days is deleted (`purgeIdleLibraries`, run at most hourly by the first library load of
a process); the stored library is only ever returned to its own user (every read is by the session's user id). Sign-in
tokens stay in `users` until the user removes the app in Spotify's account settings. The app has no privacy note
page, so the retention line (stored library deleted on disconnect and after 30 days without a visit) still needs
one when it gets one.

**Where real Spotify is used.** Only a deployed preview or production (`VERCEL_ENV`), or `SPOTIFY_LIVE=1`;
everywhere else (local dev, CI, agent runs) `readConfig` turns `SPOTIFY_MOCK` on, so no request is made. Scripts that
read a library (`usdb:sync`, `report:coverage`, `report:facets`, `popularity:calibrate`) use the offline mock, or a
snapshot given with `--snapshot <file>` (or `SPOTIFY_SNAPSHOT`), unless they are run with `--live`; `--live
--save-snapshot <file>` also writes the library out for later runs.

**Request counts.** Every Web API request is counted in `spotify_calls` (day UTC, caller, calls) before it is sent
(the token endpoint is not counted): callers are `site:/api/recommendations`, `site:/api/songs/known`,
`site:/api/auth/callback`, `script:<name>`, else `unknown`. Read it with `SELECT * FROM spotify_calls ORDER BY day DESC, calls DESC`.

**Measurement.** `npm run report:library -- [spotifyUserId] [--range 39:74] [--file library.json]` prints how many
in-range catalogue songs top and recent plays, plus the newest 200 likes, plus all likes, plus playlists find.

Postgres tables are in `db/schema.sql` (an identical copy is inlined in
`src/lib/server/schema.ts`). The Postgres store runs `migrate()` (idempotent `CREATE ... IF NOT
EXISTS`, plus `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for columns added later, such as the
feedback range columns) once before its first query, so there is no separate migration step.

## Song popularity

Spotify sends no track popularity to Development Mode apps, so `popularityScore`
(`src/lib/songs/score.ts`) also uses our own karaoke data in `song_popularity`: the YouTube views
of each song's KaraFun karaoke videos and its best Billboard Year-End Hot 100 rank and year. The
library's `all=1` reads it in one batched `getSongPopularity` per request, the catalogue once per
cache load, and each scores a copy of the range with it; it is never stored with a range or sent.
After merging, load it with `npm run popularity:import -- --karafun karafun_songs.csv --billboard
billboard_songs.csv` (needs `DATABASE_URL`; `--dry-run` only prints the summary). Both files come
from the vocal-range pipeline and never go into this repository.

Every source is put on one scale before it is averaged (`src/lib/popularity/calibrate.ts`): USDB
views score their percentile among catalogue songs with views, and karaoke views (and Spotify
popularity, when it is sent) are linked to that on the songs that have both (equipercentile
linking), so a song typical of one source scores what it would on USDB views. A Year-End entry is
a floor at the lower quartile of its tier's charting songs. USDB stars are not used: nearly every
song has 5. `npm run popularity:calibrate [-- --dry-run]` reads the numbers from `DATABASE_URL` and
writes `src/lib/songs/popularityScale.ts`.

## Song tempo

The Tempo slider (QWW-40) sorts by beats per minute, 70 to 180, placed by rank like popularity. No
tempo is read from Spotify (its audio features are closed to new apps). `song_tempo` keeps each
source as measured, and `combineTempo` (`src/lib/tempo/tempo.ts`) picks the song's one tempo when
it is read, so changing the rule needs no refetch: Deezer's `bpm` (median over the studio versions
looked at, each folded into range), else a beat tracker (librosa) on the 30 s Deezer preview, else
UltraStar's `#BPM` divided by 4; when Deezer and the tracker disagree, whichever UltraStar's tempo
agrees with. A Deezer tempo of 130 or more is halved when the tracker or the grid sits at about half of it
(Deezer's bpm for a slow song is often double: Hotel California 147, felt 74). Tempos checked by ear in
`data/tempo-gold.json` (the felt tempo: the pulse where the snare lands on beats 2 and 4) stand ahead of
every measured source (`tempoOf(record, key)`, `src/lib/tempo/reviewed.ts`). Preview audio is deleted as soon as it is measured.

- `npm run tempo:fill -- --max-minutes 30`, repeated until it reports nothing left: Deezer bpm and the
  tracker, for songs `popularity:deezer` matched, most popular first. Needs `DATABASE_URL`, and
  librosa for `TEMPO_PYTHON` (default `python3`). Paced at 5 requests a second counting preview
  downloads, stops after 20 failures in a row; finished songs are skipped. Never runs at page load.
- `npm run tempo:ultrastar -- <name>=<folder> ...`: the note files' `#BPM`, numbers only.
- `npm run tempo:report`: gold-set accuracy (`data/tempo-gold.json`), coverage and a spot check, from
  saved data only.

## Beta event log

Our own `events` table, not a third-party tool, to see where testers drop out of onboarding and
which results views land. Each event is keyed by `anonId`, a random id the device makes and keeps
in localStorage (`loadAnonId` in `src/lib/client/events.ts`); signed-in testers send it too, and
the server never reads the session for events. Events carry no Spotify-derived data: no Spotify
track ids, no song from someone's library (not even its title or key), no display names
(Spotify Developer Policy, section III, item 13). Catalogue song keys are fine. The forbidden
prop names are a backstop on both ends, not the rule itself.

The client tracker (`createTracker`) batches events and sends them with `sendEvents`
(`navigator.sendBeacon`, else `fetch` with `keepalive`); `flushWhenHidden` flushes when the page
is hidden or unloaded. It never throws, and drops props the server would reject.

`GET /api/admin/events` is computed by `summarizeEvents` (`src/lib/server/eventStats.ts`) from
these names and props:

- **Funnel**, distinct devices per step: `landing_viewed`, `start_pressed`, `note_detected` with
  `step: 'low'` and with `step: 'high'`, `range_shown`, `results_viewed`, `song_opened`,
  `spotify_link_pressed`, `spotify_connect_pressed`. Each step counts on its own, so a returning
  tester who lands on results still counts there.
- **By control**, keyed by each control in use when the event happened: `difficulty`,
  `familiarity` or `popularity` when that slider prop is a number, `decade` or `mood` when one is
  picked, `duets` when `duetsOnly` is true, else `none`. An event with several controls in use
  counts toward each. Per control: `song_opened` (count, and the median of its `position` prop),
  `spotify_link_pressed` (count), `feedback_tapped` (its `thumbs` prop, `up` or `down`).
- **Sessions**: each device's events in time order, the 50 most recently active devices first.

## Swap points

`src/lib/server/wiring.ts` decides which implementations run:

- Song logic currently comes from `src/lib/server/songLogicFallback.ts` (placeholder `songKey`,
  `matchSong`, `rankMatches`, `paginate`). Replace with `src/lib/songs` once merged.
- Ranges come from the store cache, then `data/seed-song-ranges.json` (10 **placeholder** songs
  with approximate ranges: five stand in for measured recordings, five for low-confidence
  estimates), then `noteFileSource` (returns nothing until the USDB fetcher exists). Anything else
  is logged as skipped and cached as skipped.

## Tests

```sh
npx vitest run tests/server   # store contract (memory + pg-mem), session, Spotify, song service, routes
npx tsc --noEmit -p .
```

Route tests import the `GET`/`POST`/`PUT` functions from `app/api` and call them with `Request`
objects, using the memory store and the mock Spotify client.
