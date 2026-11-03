# Backend

Route handlers live in `app/api/**/route.ts` and are thin wrappers around
`src/lib/server/handlers.ts`. Shared types and the route list are fixed in `src/lib/contracts.ts`.

## Routes

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/api/auth/login` | | 302 to Spotify (or straight to the callback with `SPOTIFY_MOCK=1`); sets a 10-minute `kd_oauth_state` cookie |
| GET | `/api/auth/callback` | `code`, `state` | Checks state, stores the user and tokens, sets the `kd_session` cookie, 302 to `/?signedIn=1`. On failure 302 to `/?authError=<reason>` (`state`, `spotify`, `missing-code`, or Spotify's `error`) |
| POST | `/api/auth/logout` | | `{ ok: true }`, clears the session cookie |
| GET | `/api/me` | | `MeResponse` |
| PUT | `/api/me/range` | `VocalRange` | `{ ok: true }`; 400 unless `low`/`high` are integers, 28 <= low < high <= 96, span 5..48, `source` is `test` or `songs` |
| GET | `/api/recommendations` | `offset` (default 0), `limit` (1..50, default 5), or `all=1` | `RecommendationsResponse`; songs with a low-confidence range come last with `difficulty: 'maybe'` (the Maybe group); 409 `{ error: 'no-range' }` before a range is saved. `all=1` ignores `offset` and `limit` and sends every match (at most 1,000, the best-ranked) with its `year` and `yearSource` (the earlier of USDB's and Spotify's album year, else the Billboard Year-End chart year, `chart`), `genre` (USDB's), USDB views and stars for songs whose range has none, and no pitch histograms; it is ranked with karaoke popularity too (see Song popularity), which is not sent. `complete: true` when that is every match. `complete: false` with a `nextOffset` means lookups ran out of budget (a first visit to a very large library): ask `all=1` again to carry on, not a page from `nextOffset`, since pages rank without the USDB and karaoke popularity. `complete: false` with `nextOffset: null` means the list was cut at 1,000 |
| GET | `/api/songs/known` | | `KnownSongsResponse` (up to 50 library songs with a known range, play order) |
| POST | `/api/feedback` | `FeedbackRequest` (`difficulty` may be `maybe`; optional `view`, the results view the song was found in) | `{ ok: true }`; 400 on bad input, including a `view` without `difficulty`, `familiarity` and `popularity` that are each null or a number from 0 to 1, a `decade` and `mood` that are known or null, and a boolean `duetsOnly`; 409 before a range is saved. Stored with the user's current range, the view (`view_json`) and, when the song is in the cached library, its range at that moment (`range_source` = the log outcome, `range_method`, `range_low`, `range_high`); the tap never loads the library from Spotify |
| GET | `/api/admin/log` | header `x-admin-token`, `limit` (1..1000, default 200) | `{ entries: DataSourceLogEntry[] }`, newest first; 403 on a wrong token or when `ADMIN_TOKEN` is unset |
| GET | `/api/catalogue/recommendations` | `low`, `high` (the range: integers, 28 <= low < high <= 96, span 5..48), then `all=1` or `offset`/`limit`; no session | `RecommendationsResponse` from the public catalogue (QWW-2 Track B): every song with a note-file or recording range, most-viewed USDB row and karaoke popularity attached, cached per process for an hour (6,000 songs). Tracks have `cat:<songKey>` ids and Spotify search links, `known: false`, so no familiarity reasons. `all=1` sends at most the best 1,000 matches with year (USDB's, else the Year-End chart year) and genre; `complete: false` and `nextOffset: null` when trimmed. 400 on a bad range |
| POST | `/api/catalogue/feedback` | `CatalogueFeedbackRequest`: the feedback fields plus `anonId` (8 to 64 of `[A-Za-z0-9-]`) and `range`; no session | `{ ok: true }`; stored with `user_id = 'anon:' + anonId`, the range, and the song's range snapshot looked up by key. 400 on bad input or a `trackId` that is not `cat:` |
| POST | `/api/events` | `EventsRequest`, as JSON or as the `text/plain` body `navigator.sendBeacon` sends; no session | 204, storing nothing while `EVENTS` is off. 400 on bad input, checked even when off: `anonId` 8 to 64 of `[A-Za-z0-9-]`; 1 to 50 events; `name` matching `^[a-z][a-z0-9_]{1,48}$`; `at` an ISO time with a zone, within 7 days of the server clock (stored as UTC); at most 20 props named `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`, each a string of up to 200 characters, a finite number, a boolean or null. Props named `trackId`, `spotifyId`, `userId`, `displayName` or `email` (any case, underscores ignored) are dropped before storing |
| GET | `/api/admin/events` | header `x-admin-token`, `limit` (1..20000, default 5000) | `AdminEventsResponse` from the newest `limit` events (see Beta event log); 403 like `/api/admin/log` |

Errors are JSON `{ error, message? }`. Every user route returns 401 `{ error: 'signed-out' }`
without a valid session (also when Spotify access was revoked). Spotify outages give 502.

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
| `SPOTIFY_MOCK` | `1` uses the offline mock client (user "Test Singer", 25 well-known songs) and, with the memory store, seeds the placeholder songs in `data/seed-song-ranges.json` |
| `DATABASE_URL` | Postgres (Neon) connection string |
| `KARAOKE_STORE` | `memory` forces the in-memory store |
| `ADMIN_TOKEN` | Token for `/api/admin/log` and `/api/admin/events`; unset disables both |
| `EVENTS` | `on` or `off`: whether `POST /api/events` stores beta events. Unset or blank, it is on only when `NODE_ENV=production`, `SPOTIFY_MOCK` is not `1` and the store is Postgres, so tests, e2e and local dev collect nothing. Any other value counts as off |
| `MOODS_SHIPPED` | Comma-separated moods (`upbeat`, `heartfelt`) allowed on screen as chips. Set a mood here only after it passes the QWW-11 precision gate (`npm run moods:report`). Unset = no mood chips |

## Store

`getStore()` (`src/lib/server/getStore.ts`) uses the in-memory store when `KARAOKE_STORE=memory`
or `DATABASE_URL` is empty, otherwise Postgres through Neon's HTTP driver. There is one instance per
server process (kept on `globalThis`). The memory store is lost on restart.

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
