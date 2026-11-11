# Backend

Route handlers live in `app/api/**/route.ts` and are thin wrappers around
`src/lib/server/handlers.ts`. Shared types and the route list are fixed in `src/lib/contracts.ts`.

## Routes

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/api/auth/login` | | 302 to Spotify (or straight to the callback with `SPOTIFY_MOCK=1`); sets a 10-minute `kd_oauth_state` cookie |
| GET | `/api/auth/callback` | `code`, `state` | Checks state, stores the user and tokens, sets the `kd_session` cookie, 302 to `/?signedIn=1`. On failure 302 to `/?authError=<reason>` (`state`, `spotify`, `missing-code`, or Spotify's `error`). Makes no Spotify request while Spotify has told the app to wait (see Spotify rate limit): it is `authError=spotify` at once, and a 429 on the profile step starts that wait |
| POST | `/api/auth/logout` | | `{ ok: true }`, clears the session cookie |
| GET | `/api/me` | | `MeResponse` |
| PUT | `/api/me/range` | `VocalRange` | `{ ok: true }`; 400 unless `low`/`high` are integers, 28 <= low < high <= 96, span 5..48, `source` is `test` or `songs` |
| GET | `/api/recommendations` | `offset` (default 0), `limit` (1..50, default 5), or `all=1` | `RecommendationsResponse`; songs with a low-confidence range come last with `difficulty: 'maybe'` (the Maybe group); 409 `{ error: 'no-range' }` before a range is saved. `all=1` ignores `offset` and `limit` and sends every match (at most 1,000, the best-ranked) with its `year` and `yearSource` (the earlier of USDB's and Spotify's album year, else the Billboard Year-End chart year, `chart`), `genre` (USDB's), USDB views and stars for songs whose range has none, and no pitch histograms; it is ranked with karaoke popularity too (see Song popularity), which is not sent. `complete: true` when that is every match. `complete: false` with a `nextOffset` means lookups ran out of budget (a first visit to a very large library): ask `all=1` again to carry on, not a page from `nextOffset`, since pages rank without the USDB and karaoke popularity. `complete: false` with `nextOffset: null` means the list was cut at 1,000 |
| GET | `/api/songs/known` | | `KnownSongsResponse` (up to 50 library songs with a known range, play order); `{ songs: [], libraryUnavailable: true }` when the library cannot be read |
| POST | `/api/feedback` | `FeedbackRequest` (`difficulty` may be `maybe`; optional `view`, the results view the song was found in) | `{ ok: true }`; 400 on bad input, including a `view` without `difficulty`, `familiarity` and `popularity` that are each null or a number from 0 to 1, a `decade` and `mood` that are known or null, and a boolean `duetsOnly`; 409 before a range is saved. Stored with the user's current range, the view (`view_json`) and, when the song is in the cached library, its range at that moment (`range_source` = the log outcome, `range_method`, `range_low`, `range_high`); the tap never loads the library from Spotify |
| GET | `/api/admin/log` | header `x-admin-token`, `limit` (1..1000, default 200) | `{ entries: DataSourceLogEntry[] }`, newest first; 403 on a wrong token or when `ADMIN_TOKEN` is unset |
| GET | `/api/catalogue/recommendations` | `low`, `high` (the range: integers, 28 <= low < high <= 96, span 5..48), then `all=1` or `offset`/`limit`; no session | `RecommendationsResponse` from the public catalogue (QWW-2 Track B): every song with a note-file or recording range, most-viewed USDB row and karaoke popularity attached, cached per process for an hour (the 6,000 most popular, plus every Billboard Year-End song). Tracks have `cat:<songKey>` ids and Spotify search links, `known: false`, so no familiarity reasons. `all=1` sends at most the best 1,000 matches with year (USDB's, else the Year-End chart year) and genre; `complete: false` and `nextOffset: null` when trimmed. 400 on a bad range |
| POST | `/api/catalogue/feedback` | `CatalogueFeedbackRequest`: the feedback fields plus `anonId` (8 to 64 of `[A-Za-z0-9-]`) and `range`; no session | `{ ok: true }`; stored with `user_id = 'anon:' + anonId`, the range, and the song's range snapshot looked up by key. 400 on bad input or a `trackId` that is not `cat:` |
| POST | `/api/setlist` | `SetlistRequest` (QWW-47): `range` (`low`, `high`), `gears` (`difficulty`, `history`, `popularity`, `tempo`, whole numbers 0 to 100), `off` (parts that are reset: any of the four gears and `era`), `eras` (any of `pre`, `s70`, `s80`, `s90`, `s00`, `s10`, `s20`), optional `offset` (default 0) and `limit` (1 to 200, default 100); a session is optional | `SetlistResponse`: `songs` (best first; each `{ match, era, gears }`, where `gears` is the song's place on each gear, 0 to 100, or null when unknown), `total` (songs passing the range and Era filters), `nextOffset`, `sources` (data-source lines by track id), `applied` (the parts that counted), `empty` (`no-era-picked`, `no-songs-in-era` or `no-songs-in-range`, when there are no songs), `libraryUnavailable` and `libraryIncomplete` (the library is only partly in the list: ask again). Signed out it ranks the public catalogue; with a valid session it also adds the singer's library songs and the History gear counts. A signed-in singer whose Spotify library cannot be read gets the catalogue's list and `libraryUnavailable: true`, never a 5xx. A missing, stale or forged session counts as signed out, not a 401. 400 on a body that is not JSON or not this shape. See Setlist ranking |
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
(the token endpoint is not counted): callers are `site:/api/recommendations`, `site:/api/songs/known`, `site:/api/setlist`,
`site:/api/auth/callback`, `script:<name>`, else `unknown`. Read it with `SELECT * FROM spotify_calls ORDER BY day DESC, calls DESC`.

**Measurement.** `npm run report:library -- [spotifyUserId] [--range 39:74] [--file library.json]` prints how many
in-range catalogue songs top and recent plays, plus the newest 200 likes, plus all likes, plus playlists find.

Postgres tables are in `db/schema.sql` (an identical copy is inlined in
`src/lib/server/schema.ts`). The Postgres store runs `migrate()` (idempotent `CREATE ... IF NOT
EXISTS`, plus `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for columns added later, such as the
feedback range columns) once before its first query, so there is no separate migration step.

## Setlist ranking (QWW-47)

The Setlist tuner (round 5 design, QWW-46) sends its state to `POST /api/setlist` and gets the ranked list back; the
screen has no ranking math. The engine is `src/lib/songs/setlist.ts` (pure, deterministic, the same list in any input
order); the types are in `src/lib/contracts.ts` and the defaults in `src/lib/songs/setlistConfig.ts`, which the screen may
import. The model is the design's distance ranking (round 5 spec section 5), decided on 10 Nov (option A).

1. **Hard range filter, first.** Only songs that fit the singer's range, as written or an octave away (`matchSong`). The
   engine takes those songs; a gear never adds or removes one. The old whole-list route cut the list to the best 1,000
   by Top picks before anything else, which left no Hard song for a wide range (0 of 497 on the synthetic F2 to C5
   catalogue); the tuner ranks every song that fits and cuts afterwards.
2. **A place on every gear.** Each song gets a place from 0 to 100 on each gear:
   - *Difficulty* (Light work to Locked in): a song sits in the third of the track its label owns (Easy 0 to 33, Medium
     33 to 67, Hard 67 to 100), whatever the share of songs in each, so a row's lane colour and its label agree; inside
     its third the songs spread evenly by strain (below). On a wide range most songs are Easy, so most sit in the first third.
   - *Listening history* (Rediscover to On repeat): how much the signed-in singer plays the song (familiarity), then
     Spotify's order. A song that is not in their library has none.
   - *Popularity* (Deep cuts to Pop hits): `popularityScore`, the score the old Pop hits slider used.
   - *Tempo* (Slow jams to Upbeat tracks): the song's tempo, read through `effectiveTempo` in `setlist.ts`, the one
     place QWW-54's effective tempo switches in (the old `browse.ts` sliders read `m.tempo` directly, and go with them).

   Popularity, Tempo and History are by rank among the songs that fit the singer, so every tenth of the track holds about
   a tenth of the songs (QWW-33), songs with the same score sharing their average place.
3. **The sum.** Era first, a multi-select: Era off shows every era; Era on shows the songs of any of the picked eras (an OR,
   so each pick adds songs and takes none away, and the songs keep the order they have in the whole list; a song with no
   year is left out), and nothing picked is an empty list (`no-era-picked`). Every one of the 127 combinations of eras is
   tested (`tests/songs/setlist.test.ts`, `tests/server/setlist.test.ts`). Then
   `distance = sum over the active gears of weight × |song's place - gear value|`. An active gear is one not in `off`,
   and History only when the singer is signed in and their library was read. An off gear adds nothing. Popularity's
   weight is 2, the others 1 (`GEAR_WEIGHTS`). With the defaults that is a blend that leans on popularity, not a sort by
   popularity with difficulty breaking ties: of two songs, the one 10 places less popular needs to be 20 places easier to
   come first, so the single most popular song is first only if it is also easy. `GEAR_WEIGHTS` is the one knob if the top
   of the default list needs to lean harder.
4. **Order.** The Maybe songs (estimated ranges) come after all the others, as everywhere else. Inside the Maybe songs and
   inside all the others, every song that fits as written comes before any song that needs an octave jump, up or down
   (QWW-58, Quinn-Wai's decision A, 11 Nov; see below). The jump songs still follow, so a range whose popular songs all
   need a jump gets a full list, never an empty one. Within each of those groups, a song we do not know on an active gear
   (no tempo, a one-note range, not in the library) comes after every song we do. When songs miss different gears the more
   specific control wins: History, then Tempo, then Popularity, then Difficulty (so a song with no tempo is after every
   song that has one, whatever else either is missing). Then the closest sum first. Exact ties go to the more popular
   song, the easier, then artist and title (so a song keeps its place whether it is the catalogue's track or the
   singer's own), then track id.

**Songs sung as written first (QWW-58).** The range filter takes a song as written, an octave down or an octave up, so for
a range of two octaves it keeps 86 to 90% of the catalogue and hardly tells voice types apart. The gear places do not
tell the jump from the real thing either, and they favour it: a song that is too high for you sits in the lower half of
your range an octave down, where the "easy leans low" curve is kindest, so it reads Easy ("In your sweet spot"), and the
catalogue's biggest hits (mostly tenor and female pop, written around B3 to G4) win in whichever octave fits them. Before
this rule the octave only broke exact ties, which a sum of places almost never produces, and the octave penalty of the old
Top picks score never reached the engine. Measured on production's catalogue, logged out with the defaults, no bass (E2 to
E4) or F2 to F4 list had a song sung as written in its top 20, although every voice type has at least 100 popular songs it
can sing as written. The penalty inside the distance (option B) was not chosen: it would trade the octave against
popularity and difficulty at a rate nobody can justify, where the group is a rule a singer can follow. A song that needs a
jump keeps its places on the gears, and its difficulty is still measured as sung, after the jump; only its position
relative to the songs sung as written is new. "As written" is only as reliable as the stored octave (`octave.ts`,
QWW-31), so some songs that a low voice would have to jump (mostly women's and falsetto songs) can still count as sung
as written.

**The curve (rule 2, easy leans low).** The strain of a song is the sung-time-weighted average of a note's cost, `t` being
where the note sits in the singer's range (0 lowest, 1 highest, an octave shift applied): `((t - 0.35) / 0.65)²` from the
ease point 0.35 up, and `0.6 × ((0.35 - t) / 0.35)²` below it. The ease point is the lower-middle of the range, the chest
voice; the top climbs to 1 and the bottom only to 0.6, so a note near the top costs more than one the same distance from
the bottom, at every distance (`tests/songs/setlist.test.ts` checks it). It orders songs within a label; the labels
(Easy, Medium, Hard) and the song page are unchanged.

| Note at | 0.00 | 0.10 | 0.20 | 0.35 | 0.50 | 0.65 | 0.80 | 0.90 | 1.00 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cost | 0.60 | 0.31 | 0.11 | 0.00 | 0.05 | 0.21 | 0.48 | 0.72 | 1.00 |

**Defaults** (spec section 11): Difficulty 0 on, Popularity 100 on, History 100 off, Tempo 50 off, Era off with no picks. Why
each, and what a reset does, is in `setlistConfig.ts`.

**A one-note range** ("Jump", C4 to C4: it fits everyone, so it won on "easy") has no difficulty: a song whose range spans
fewer than 5 semitones (`MIN_PLAUSIBLE_SPAN`) has `gears.difficulty: null`, so while Difficulty is on it comes after every
song with one. With Difficulty off it ranks on popularity like any song. Its label on the song page is unchanged (Easy).

**Max difficulty, logged out** (Quinn-Wai's check of 10 Nov). Difficulty at 100 with the other gears as they load lists the
most popular Hard songs first: the Hard third of the track is nearest to 100, and Popularity (on, double) chooses among
them. On the synthetic catalogues in the tests (hundreds of Hard songs of every popularity) the first 10 are all Hard in
every range. It is exact, the first songs being all Hard and the hardest first, when Popularity is off. It is not a law with
Popularity on: a range with only a handful of Hard songs, all obscure, puts popular Medium and Easy ones among them.
Quinn-Wai chose this (option A) on 11 Nov, and that the default list leans on popularity as it does (`GEAR_WEIGHTS`). Songs
sung as written come first here too (QWW-58): the Hard songs sung as written lead, then the Easy and Medium ones sung as
written, and only then the Hard songs that need a jump. On production's catalogue every voice type has hundreds of Hard
songs it can sing as written (655 to 1,815 over the eight ranges of QWW-58), so the first 10 are still all Hard.

**Not used by the ranking:** the fast-lyrics flag and the octave penalty of the Top picks score (the octave decides a
group, rule 4, and is not a penalty; a song that needs a jump has its notes scored as sung). A singer whose range is so narrow that no song
fits (5 to about 9 semitones) gets `no-songs-in-range`; Quinn-Wai (11 Nov) did not want a widening fallback, so the tests
and the release checks use ranges of an octave or more.

**Cost and Spotify.** A range's songs are matched and given their places once and kept (the last 6 ranges, dropped when
the catalogue's hour is up), so moving a slider re-sorts a few thousand songs. A signed-in singer's library matches are kept
per singer and range, 6 lists in all across singers, each for as long as the track cache hands out the same copy of that
library, and not while the list is incomplete or failed (`libraryIncomplete` then tells the screen to ask again: lookups ran
out of budget, or one failed). The tuner asks on every slider move, so a library that could not be read is not asked for
again for 30 seconds (the catalogue's list and `libraryUnavailable` meanwhile); without that each move would retry
Spotify's calls, against a quota that is shared and small. The first request of a signed-in singer with no stored library
reads all of it from Spotify, like `/api/recommendations`.

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
  saved data only. `-- --lists [--era 90s]` adds, per era and for F2 to C5 and E2 to E5, the 20 slowest and
  20 fastest of the 300 most popular songs by the tempo the ranking uses, as plain text for a person to read.

### Feel labels and the one tempo (QWW-54)

A measured tempo puts a ballad at the upbeat end whenever a source reads it at double time (Hey Jude 148
for 74; a beat tracker's 178 for Red Red Wine), and no rule on the numbers can tell that from Take On Me.
So a song can carry a **feel label**: slow, mid or upbeat, made offline from what is known of the
recording (`data/tempo-feel.md` says how), kept in `song_feel` (one additive table, `IF NOT EXISTS`) and
never worked out while a page loads. The label decides which end of the Tempo gear the song sits at; the
measurement only orders songs inside that end.

`effectiveTempo` (`src/lib/tempo/feel.ts`) is the one tempo per song that the ranking reads, with its
source (`deezer`, `tracker`, `ultrastar`, `reviewed`, or `feel` when only the label is known):

- Without a label, a published tempo (`data/tempo-gold.json`) stands as written. A measured one (`combineTempo`) is squeezed in a
  straight line onto the mid band, 90 to 125, which keeps its order and ties but means no song nobody vouched
  for reaches either end of the gear (of 297 songs labelled slow that Deezer has a bpm for, 59% were read at
  125 bpm or more). So a database with no labels ranks the measured songs in the order it did before, with
  two exceptions: a song whose only reading is a beat-tracker value of 160 or more has no tempo (that reading
  is left out unless Deezer or UltraStar agrees, since it doubles slow songs), and the songs with a published
  tempo stand as written, so they can sit at an end.
- With a label, each reading (the checked tempo alone, else Deezer, the tracker, UltraStar / 4) is tried as
  it is, halved, doubled and by two octaves, and the cheapest value for the label's band wins: slow 40 to 90,
  mid 90 to 125, upbeat 125 to 215 bpm. A value still outside its band goes into a thin strip just inside
  the nearest edge, in the order it was measured, so a ballad read at 105 sits at the top of the slow band
  and a disco song read at 101 at the bottom of the upbeat one, behind the songs whose numbers back the label
  up (and when an end has too few labelled songs, the songs that fill it are the nearest to it by their
  numbers). Every slow song is below every mid song, which is below every upbeat song; a labelled song with no
  reading sits at the edge of its band facing the middle.
- `loadCatalogue` works it out once per cache fill and puts it on `Match.tempo`, which is all the rankers
  read: the Tempo slider's `sliderValue` today, and the Setlist ranking engine's `effectiveTempo(m) = m.tempo`
  when QWW-47 lands, with no switch needed. `Match.tempo` is a position on the gear, not a bpm. A database with
  no `song_feel` table, or a read that fails, gives no labels, and every song is ranked on its measured tempo.

`npm run tempo:feel` imports `data/tempo-feel.json` into `song_feel`. It is a dry run that says what it would
write and what that does to the Tempo gear; `-- --apply` writes to `karaoke_pr4_preview` and refuses any other
database unless `--production --confirm-database <name>` are both given. It writes only rows that are missing or
different, so it can be stopped and run again. `-- --unlabeled out.json [--top 3000 | --served]` lists the
catalogue songs still without a label, for the labellers: the most popular N, or with `--served` every song shown in
the release harness' five test ranges or in F2 to C5 and E2 to E5 (the best 1,000 of each), which are the only songs
that can reach the top 20 at an end of the Tempo gear there. **Production data step:** `npm run tempo:feel`
(dry run, read the output), then `npm run tempo:feel -- --apply --production --confirm-database neondb`.

## One song, one row (QWW-49)

The logged-out list shows each catalogue song once, with a clean title. The catalogue is `song_ranges`, keyed by a
loose song key, with the title and artist of whatever source wrote each row. Two things were wrong on screen: titles
with the release's tags on them ("(Album Version)", "[DUET]", "(Live at Donington)", "- Remastered 2011",
"(feat. X)"), and the same song twice, because two sources spelled it two ways (a curly and a straight apostrophe, an
ASCII and a Unicode hyphen, "A*Teens" and "A★Teens"): hundreds of songs in the real catalogue, many of them identical on screen).

**Where it is done.** Offline, in `npm run titles:build`, never per request. It writes `song_canonical`, one row for
every measured song; the catalogue (`loadCatalogue(store, size, { canonical: true })`, which the app's wiring and the
live-data smoke test use) reads it once per load and applies it (`applyCanonical`, `src/lib/songs/canonical.ts`).

| Column | |
|---|---|
| `song_key` | The row it is about: any measured song, the shown one included |
| `canonical_key` | The row shown for this song: its own key for the row shown, another's for a folded variant |
| `title`, `artist` | What to show, the same on every row of one song (clean title; artist line with any "feat." from the title) |
| `reason` | `same` (as stored), `cleaned` (a tag or featured artist came off), `folded` |
| `method` | The rules version (`titles-v1`); a newer value rewrites every row |
| `source_title`, `source_artist` | What the row had when the record was worked out; the record is used only while the row still has them |

**Titles** (`src/lib/songs/title.ts`). A closed list of tags, each rule reading the whole text of a bracket or a dash
tail: "(… Version)", "[DUET]", "- Remastered 2011" / "(2011 Remaster)", "(Live …)" / "(MTV Unplugged)" / "(En Vivo)",
"(feat. X)", "(Radio Edit)", "(Single Mix)", "(… Remix)", "(TV)", "(Lyric Video)", "(Acoustic)", "(From "Film")",
"(Once OST)", "(ESC 2015 Romania)" and a few more. What is not on the list stays, so a missed tag shows a bracket and a
wrong one never turns a song into another: "(I Can't Get No) Satisfaction", "Sweet Dreams (Are Made of This)" and
"Running Up That Hill (A Deal With God)" are untouched (the tests pin real titles like these, and near misses that only start or end like a tag). Kept on purpose:
language versions ("(German Version)", "(Spanish Radio Edit)": the lyrics differ), instrumental, karaoke and dub tags
(`hasLittleSinging` hides those songs on the tag), and a bracket naming a part, a reprise or an interlude. A bare
"feat." with no bracket is left alone ("A Feat of Strength").

**Folding** (`canonical.ts`). Two rows are one song only when all of these hold; anything else stays two rows:
- the lead artist (the first credit) matches, ignoring case, accents, quotes, dashes and "&" against "and", and so do
  the cleaned titles. A featured artist or a further credit is set aside: "Calvin Harris" and "Calvin Harris & Dua
  Lipa" are one song (the release eval harness counts duplicates by lead artist too); "A" and "B" are not, and
  neither are "A & B" and "B & A";
- their ranges agree at both ends within 4 semitones (`MAX_RANGE_GAP`). A popular row measured an octave off would
  otherwise hide the row that fits the singer; those pairs stay two rows and the dry run lists them;
- neither is an instrumental, karaoke or dub row.

The row shown is the main version, the one with no tag on its title (the most popular such row), unless an alternate
(a row with a tag on its title) is clearly more popular: 0.15 higher on the popularity score (`ALTERNATE_MARGIN`; the
score is `catalogueRank`, which counts Deezer rank, USDB and karaoke views and a Year-End chart entry). Its title is
clean either way. A row that is not shown but is on a Year-End chart is still loaded by the catalogue, and stands in
for the song if the row shown ranked too low to load.

**Until the table is on a database, and when it goes wrong.** The app shows the titles as stored: no row, an empty or
missing table, or a read that fails (retried once, logged, and kept for a minute rather than the hour) all fall back
to that. A record is ignored when its row's title or artist has changed since the build, so a sync that renames a
song never gets a stale clean title (or an un-hidden instrumental). A folded row is dropped only when the row it folds
into is in the list and the mapping is consistent; otherwise the song stays. `report:library` and `tempo:report` ask for
no mapping, so they still see the catalogue as stored.

**Running it.**
```sh
npm run titles:build -- --lists titles-before-after.md   # a dry run: reads, writes nothing (not even the table), prints what to check
npm run titles:build -- --apply --confirm-database karaoke_pr4_preview
npm run titles:build -- --apply --confirm-database neondb --production   # production: Stage 3's data step, dry run first
```
Needs `DATABASE_URL`. Resumable: a run writes only the rows that are missing or differ, so after a stop, run it
again. `--apply` refuses unless `--confirm-database` names the database it is connected to, and a database named
`neondb` (production) also needs `--production`; a Neon branch of production keeps that name, so check the host the
script prints. The dry run prints: songs before and after folding, tags removed by kind, the brackets still in shown titles
(to see tags the rules do not know), the most popular folded songs, the alternates shown, and the names kept apart for
their ranges. `--lists` writes the logged-out list for the release eval harness's five test ranges
before and after, with counts of tagged titles and duplicates in the top 50, 200 and 1000.

**Feedback and events.** Both keep the key of the row the visitor saw (`cat:<key>`), which after the build is the
shown row. Anything recorded against a folded row, before or after, joins to its song through the table:
```sql
SELECT f.*, COALESCE(c.canonical_key, substr(f.track_id, 5)) AS song
FROM feedback f LEFT JOIN song_canonical c ON f.track_id = 'cat:' || c.song_key;
```
**Not covered.** The signed-in list shows Spotify's titles as Spotify writes them. A name spelled two ways
("Diddy – Dirty Money", "DiddyDirtyMoney") stays two rows. Apostrophes are set aside entirely, so "I'll" and "Ill" by one
artist would fold.
Rerun the build after `usdb:sync`, `ranges:import`, `popularity:*` or the octave fix changes titles, ranges or popularity.

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
