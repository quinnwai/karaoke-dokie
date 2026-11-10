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
| GET | `/api/recommendations` | `offset` (default 0), `limit` (1..50, default 5) | `RecommendationsResponse`; songs with a low-confidence range come last with `difficulty: 'maybe'` (the Maybe group); 409 `{ error: 'no-range' }` before a range is saved |
| GET | `/api/songs/known` | | `KnownSongsResponse` (up to 50 library songs with a known range, play order) |
| POST | `/api/feedback` | `FeedbackRequest` (`difficulty` may be `maybe`) | `{ ok: true }`; 400 on bad input; 409 before a range is saved. Stored with the user's current range and, when the song is in the cached library, its range at that moment (`range_source` = the log outcome, `range_method`, `range_low`, `range_high`); the tap never loads the library from Spotify |
| GET | `/api/admin/log` | header `x-admin-token`, `limit` (1..1000, default 200) | `{ entries: DataSourceLogEntry[] }`, newest first; 403 on a wrong token or when `ADMIN_TOKEN` is unset |

Errors are JSON `{ error, message? }`. Every user route returns 401 `{ error: 'signed-out' }`
without a valid session (also when Spotify access was revoked). Spotify outages give 502.

### Paging

Songs are looked up lazily in play order (top tracks, then saved songs), at most 40 uncached
lookups per request, so the first page is fast. Matches are paged in play order and ranked within
each page, so pages never overlap. `nextOffset` can be returned with a short (even empty) page when
the lookup budget ran out: keep asking until it is `null`.

## Environment

| Variable | Meaning |
| --- | --- |
| `SESSION_SECRET` | Required, 16+ chars. HMAC-SHA256 key for the session cookie |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` | Required unless `SPOTIFY_MOCK=1`. Redirect URI is the full `/api/auth/callback` URL |
| `SPOTIFY_MOCK` | `1` uses the offline mock client (user "Test Singer", 25 well-known songs) |
| `DATABASE_URL` | Postgres (Neon) connection string |
| `KARAOKE_STORE` | `memory` forces the in-memory store |
| `ADMIN_TOKEN` | Token for `/api/admin/log`; unset disables it |

## Store

`getStore()` (`src/lib/server/getStore.ts`) uses the in-memory store when `KARAOKE_STORE=memory`
or `DATABASE_URL` is empty, otherwise Postgres through Neon's HTTP driver. There is one instance per
server process (kept on `globalThis`). The memory store is lost on restart.

Postgres tables are in `db/schema.sql` (an identical copy is inlined in
`src/lib/server/schema.ts`). The Postgres store runs `migrate()` (idempotent `CREATE ... IF NOT
EXISTS`, plus `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for columns added later, such as the
feedback range columns) once before its first query, so there is no separate migration step.

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
