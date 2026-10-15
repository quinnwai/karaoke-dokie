# karaoke-dokie

Find karaoke songs that fit your voice, from your own Spotify saved songs.

You hold a button and sing your lowest note, then your highest. The app signs you in to Spotify,
looks up the vocal range of each saved song, and lists the songs that fit your range, labeled
Easy, Medium or Hard. Phone first, as a website.

## Features

Each feature lists where it lives and how it is tested. Run every test with `npm test` (unit and
integration, Vitest) and `npm run test:e2e` (end to end, Playwright).

| Feature | What it does | Code | Tests |
| --- | --- | --- | --- |
| Note detection | Finds the pitch of each 46 ms audio frame (YIN), then the note held longest in a press-and-hold recording, ignoring breaths, slides and vibrato. | `src/lib/audio/` | `tests/audio/`: synthetic tones E2 to C6, voice-like tones with vibrato and noise, and 20 labeled sung notes from NSynth |
| Range test screen | Landing, "find a quiet spot", hold-to-record lowest and highest note with a live pitch dot, the detected note name, a wordless bouncing arrow (bottom right) to continue. | `src/components/`, `src/lib/client/` | `tests/screen/` (flow reducer, components), `tests/e2e/screen.spec.ts` (fake mic plays A2 and C5) |
| Pick songs you sing well | Instead of the test, choose up to 3 known songs; their lowest and highest notes become your range. | `src/components/PickSongs.tsx` | `tests/screen/`, `tests/e2e/screen.spec.ts` |
| Spotify sign-in | Authorization code flow; reads up to 2,000 saved songs, top tracks over three time spans and the last 50 plays. | `src/lib/server/spotify.ts`, `app/api/auth/` | `tests/server/spotify.test.ts`, `tests/server/routes.test.ts` |
| Song ranges from note files | Parses UltraStar note files: lowest and highest note (ignoring extremes that take up under 5% of sung time), tessitura, fast-lyrics flag. Fixes files written in the wrong octave. | `src/lib/songs/ultrastar.ts`, `range.ts` | `tests/songs/` |
| Matching and labels | Only songs inside your range are shown. Labels come from how much of the singing sits near your edges (the outer eighth of your range at each end): Hard if 10% or more, Medium if 2% or more or if a quarter sits outside the middle half, Easy otherwise. The reason line follows the label. Songs that fit an octave up or down are listed after, with "Sing it higher/lower than the artist". | `src/lib/songs/match.ts`, `rank.ts` | `tests/songs/match.test.ts`, `rank.test.ts` |
| Ranking | Songs you know (Spotify top tracks over 4 weeks, 6 months and all time, recent plays, or your own playlists) come first; saved-only songs follow. Within each group every song gets one score: 85% comfort × familiarity (comfort is the share of the song's sung time in the middle of your range), plus 15% popularity (Spotify popularity, USDB views and stars). Octave shifts and artist estimates lose 0.10, fast lyrics 0.05. The whole library is ranked, then paged; each song shows its top one or two reasons. | `src/lib/songs/score.ts`, `rank.ts`, `src/lib/server/spotify.ts` | `tests/songs/score.test.ts`, `tests/server/spotify.test.ts`, `tests/server/songService.test.ts` |
| Artist fallback | No note file: use the typical range of the artist's other songs that have one, marked low confidence. Nothing at all: the song is hidden and logged. | `src/lib/songs/artistFallback.ts`, `resolve.ts` | `tests/songs/`, `tests/server/wiring.test.ts` |
| USDB download | Logs in to USDB, finds the song, downloads its note file, stores only the computed numbers. Requests are 2.5 s apart, and each download waits out the site's own countdown (about 25 s per song). Also stores USDB views and stars; `-- --rescan` re-downloads older songs to add the pitch histogram. Run with `npm run usdb:sync`. | `src/lib/usdb/`, `scripts/usdb-sync.ts` | `tests/usdb/` (fake pages) |
| USDB song index | Keeps our own copy of USDB's song list (id, artist, title, views, stars, last change; no note files). The first run reads all of it, 100 rows per page (about 14 minutes); later runs read only what changed. When it's filled, the sync looks songs up there instead of searching, so a song USDB doesn't have costs no request. Same approach as USDB Syncer. Run with `npm run usdb:index`. | `src/lib/usdb/songIndex.ts`, `scripts/usdb-index.ts` | `tests/usdb/songIndex.test.ts`, `tests/usdb/sync.test.ts` |
| USDB catalogue fill | Computes ranges for every indexed USDB song that has none yet, most-viewed first, one song per key. Waits out the countdown unless `--skip-countdown` (like USDB Syncer; OK'd by the USDB folks). Stop and rerun any time. Run with `npm run usdb:fill`. | `src/lib/usdb/fillCatalogue.ts`, `scripts/usdb-fill.ts` | `tests/usdb/fillCatalogue.test.ts` |
| Coverage report | A CSV of one person's whole library: range source (note file, artist estimate, none), song range, whether it fits their voice, rank in the app, and for songs without a note file whether USDB lacks it or has it under a slightly different name. Read-only. Run with `npm run report:coverage -- --out report.csv`. | `src/lib/report/coverage.ts`, `scripts/coverage-report.ts` | `tests/report/coverage.test.ts` |
| Credits | `/credits` lists every source, linked from the bottom of the results. A song's info button links to its USDB page when we know it. | `src/lib/credits.ts`, `app/credits/` | `tests/screen/icons.test.tsx` |
| Bulk note ranges | Reads folders of UltraStar note files from public collections, computes each song's range, drops implausible ones, and writes only the numbers to a JSON file (`npm run ranges:build -- --out ranges.json name=folder ...`). `npm run ranges:import -- ranges.json` loads it into the database without overwriting songs that already have a note-file range. | `src/lib/notes/bulkImport.ts`, `scripts/note-ranges-*.ts` | `tests/notes/bulkImport.test.ts` |
| Results and song detail | 5 songs at a time with "Generate more"; each row shows the label, small icons for "sing it an octave higher/lower" and fast lyrics (hover for a tooltip), and one or two reasons for the rank ("In your sweet spot", "You play this a lot"). Detail shows the song's range over yours, the label, the same icons and reasons, an info button saying where the data came from, and "Open in Spotify". | `src/components/Results.tsx`, `SongDetail.tsx` | `tests/screen/`, `tests/e2e/` |
| Feedback | One-tap "How'd it go?" thumbs up or down, stored with your range, the label and the octave note. | `app/api/feedback/`, `src/lib/server/` | `tests/server/routes.test.ts`, `tests/e2e/` |
| Database | Saved ranges, song ranges, the data-source log and feedback. Postgres (Neon) in production, memory store locally. Every write is read back in one shared test suite run against both. | `src/lib/server/*Store.ts`, `db/schema.sql` | `tests/server/storeContract.test.ts` (pg-mem) |
| Admin log | Hidden page listing every song's data source or skip reason. Needs the `x-admin-token` header. | `app/api/admin/log/` | `tests/server/routes.test.ts`, `tests/e2e/fullstack.spec.ts` |

More detail: [docs/backend.md](docs/backend.md) and [docs/screen.md](docs/screen.md).

## Run it

```sh
npm install
cp .env.example .env.local   # fill in, or use the offline demo below
npm run dev
```

Offline demo, no accounts needed: `KARAOKE_STORE=memory SPOTIFY_MOCK=1 SESSION_SECRET=<32+ chars> npm run dev`.
Mock mode signs you in as "Test Singer" with 25 well-known songs. Ten of them have placeholder
ranges from general knowledge (`data/seed-song-ranges.json`), so they are labeled as estimates;
real ranges come from USDB.

End-to-end tests build and start the app in mock mode. In the cloud sandbox, point Playwright at
the preinstalled Chromium: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e`.
Screenshots of every step land in `test-results/screens/`.

## Sources and inspiration

| What we took | Source |
| --- | --- |
| Range test onboarding (hold a note, see it on a keyboard, track lowest and highest) | [Singing Carrots range test](https://singingcarrots.com/range-test) |
| What makes a karaoke song easy | [KaraokeCrowd](https://karaokecrowd.com/en/blog/easy-karaoke-songs-for-beginners) |
| Note file format | [UltraStar format spec](https://usdx.eu/format/) |
| Note file database | [USDB](https://usdb.animux.de/) |
| Bulk note files (ranges computed from them; files not redistributed, originally from USDB) | [singmania](https://github.com/andrrms/singmania), [allkaraoke](https://github.com/Asvarox/allkaraoke) |
| USDB request sequence (login, list search, gettxt page) and song-list index design | [USDB Syncer](https://github.com/bohning/usdb_syncer) by Markus Böhning (GPLv3; ideas only, no code copied) |
| Pitch detection | YIN: de Cheveigné and Kawahara, 2002, [doi:10.1121/1.1458024](https://doi.org/10.1121/1.1458024) |
| Labeled sung-note test audio | [NSynth dataset](https://magenta.tensorflow.org/datasets/nsynth), Google Magenta, CC BY 4.0 ([list](tests/fixtures/vocals/SOURCES.md)) |
| Fast-lyrics threshold (speech is about 5 to 8 syllables per second) | Pellegrino, Coupé and Marsico, 2011, "A cross-language perspective on speech information rate", *Language* 87(3) |
| Spotify API limits for new apps | [Spotify developer blog, Nov 2024](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api) |
| Live pitch line during the test | SingStar (game) |
| Landing page layout (one centered object) | Chromakopia website |
| Look | Japanese karaoke venues at night (neon カラオケ signs, private rooms) |
| Icons | [Material Symbols](https://fonts.google.com/icons), Apache 2.0 |
