# Song identity

Spotify lists one recording under many track ids (a single, the album, compilations), so a library
shows the same song more than once, and a remix can pass for its original. This is the design for
telling songs apart, built in stages. **Status:** the grouping rules (`src/lib/songs/identity.ts`) and the
audit that runs them on a real library (`npm run audit:identity`) exist; the app does not use them yet.

## Terms

- **Listing**: one Spotify track id.
- **Recording**: one audio file. Every listing of it shares an ISRC (not always: one recording can be
  registered under two).
- **Song**: what you would sing. The same melody, lyrics and arrangement by the same artists. A remix,
  a live take, a sped-up copy and a cover are other songs; a remaster, a radio edit and a
  re-recording ("Taylor's Version") are the same song.

## How listings group

| Signal | Rule |
| --- | --- |
| ISRC | The same ISRC is the same recording. It can chain. It does not join listings whose different-version tags differ. |
| Words | The different-version tags in the titles must be the same on both sides ("Live" and "Live Version", "Pt. 2" and "Part 2" count as one). Packaging tags are ignored. A tag in brackets that is on no list is usually a subtitle, so length checks it. A label after a " - " that is on no list keeps a listing from joining another by title and length, but an equal ISRC still joins them. |
| Length | Within 4 s: the same recording. Within 10 s: the same song if the titles match exactly (packaging, cut and guest tags aside). Further apart: different, unless a cut tag explains it ("X - Radio Edit" against a plain "X", when the shorter is at least 40% of the longer). Under 60 s is a snippet, not a song. |
| Artists | The same set of credited artists, by Spotify artist id. A guest a title names does not count; two titles that name different guests are different recordings. |

The lengths are the vocal-range pipeline's (`DURATION_TOLERANCE_S`, `RELAXED_TOLERANCE_S`,
`MIN_LENGTH_S`), compared in whole milliseconds. Words, length and artists are checked against a
song's anchor, the listing played most, and never chained, so a wrong match cannot spread. With three
or more cuts of one song, which ones group together depends on which you play most. Titles that name
no song ("Intro", "Interlude", "Track 1") join only by ISRC. Every default is strict: a wrong merge
hides a song silently, a missed one shows a duplicate. Without ISRC (Spotify withdrew it for a while
in 2026) the other signals still work.

Tags are the text in `(...)`, `[...]` (and the full-width forms), and after a " - ":

| Kind | Examples | Effect |
| --- | --- | --- |
| Packaging | remaster, mono or stereo, album or original version or mix, explicit, clean, deluxe or other edition, bonus track, "from the film X" | same song |
| Cut | radio, single, short, video or edited version, edit or mix; "Taylor's Version" | same song, and a different length is explained |
| Guest | "feat. X", "with X" | same song; a guest either title names is set aside when comparing artists, but two titles that name different guests are different recordings |
| Different version | remix (named or not), mashup, VIP, rework, flip, bootleg, a named edit, live, unplugged, session, acoustic, stripped, piano, a cappella, orchestral, demo, extended, club, 12-inch, sped up, slowed, reverb, nightcore, chopped and screwed, bass boosted, 8D, duet, alternate, film or language version (and a bare language), cover, medley, take N, reprise, Pt. N, interlude, skit, intro, outro, off vocal | own song |
| Hidden, as before | instrumental, karaoke, backing track, dub, no vocals | not shown |
| Anything else, in brackets | a subtitle ("However Do You Want Me"), "A COLORS SHOW" | length decides |
| Anything else, after a dash | "Spider-Man: Into the Spider-Verse", "Main Theme" | a label: keeps a listing apart unless the ISRC joins it |

Different-version tags are compared by their full text, so two remixers' mixes are different songs.

## The range lookup key stays

A song's range is still looked up by `songKey` (`src/lib/songs/resolve.ts`). The vocal-range
pipeline writes rows under that key and its tests compare its Python port with the app's code, so
changing it means changing the pipeline too. The pipeline measured an ISRC join at 59 to 75% of its
songs against 96 to 97% by name key (`ingestion-pipeline/docs/07_app_integration.md`), so ISRC groups
Spotify listings with each other and the name key stays the join to ranges.

## Stages

0. **Audit** (built). `npm run audit:identity` reads a person's library, groups it, and lists what merged
   and what looks doubtful: merges made without ISRC, merges more than 10 s apart, ISRC merges where the
   title or artists differ, same title and artists kept apart, lookup keys shared by several songs, ranges
   stored from a duet, live or remix USDB entry for a plain song, snippets, possible untagged remixes, and the
   most common unlisted tags (candidates for the word lists). It also reports, for each Spotify list (top
   tracks per span, recent plays, saved songs, playlists), how many tracks carry ISRC, length and 2+ credited
   artists. The tracks now carry those fields; `songService` removes them from every response.
1. **Behavior** (next). Group the library into songs where it is assembled: merged listening evidence
   (best top-list position, the set of time windows, recent plays, saved or in a playlist), one row per
   song named after the listing played most, a song id that does not depend on which listing is shown,
   different-version songs reading the original's range as an estimate (Maybe, never stored), "Also in your
   library: ..." in the song detail, listings under 60 s left out, and the USDB sync and fill taking the plain
   entry before the most-viewed one (a duet or live file can outrank the original today).
2. **Only if the audit shows a gap**: a USDB lookup that finds a remix's own entry; ISRC as a second lookup
   into pipeline rows.

## Running the audit

```sh
npm install
export DATABASE_URL='postgres://...'    # the Neon string usdb:sync uses; or put it in .env.local
npm run audit:identity                  # Spotify keys come from .env.local
```

It prints the database host, then reads the library the way the app does when it opens (up to 2,000
saved songs, 3,000 songs from up to 100 of your own playlists, the top 50 for each of three spans and the
last 50 plays), one request at a time with a pause between them, a few hundred in all. It stops at the
first HTTP 429. Any other failed read is counted and the output opens with a PARTIAL warning (exit code 2).
Options: `--env <file>`, `--out <folder>` (default `identity-audit`), `--library <folder>/library.json`
(rerun on a saved read, no Spotify calls), `--refresh` (read Spotify again although a saved read exists),
`--no-database` (skip the stored-range and USDB checks), and a Spotify user id when more than one user has
signed in. It writes nothing to the database except the usual token refresh and the schema check the app
runs on connect.

It writes `identity-audit/audit.csv` (one row per listing, with the song, how it joined and any flags) and
`identity-audit/library.json` (the read, for reruns). Both hold the person's songs, ISRCs and track ids,
so they are git-ignored, mode 600 and local analysis files: delete the folder when the audit is done
(Spotify Developer Terms IV.3.1). The text it prints holds song titles but no ISRCs or track ids.

## Data rights

ISRC, length and the credited artists stay in memory with the library (the 10-minute cache) and are
removed before a response. The app stores nothing new, and nothing about a person's library is sent to
another service (`ingestion-pipeline/docs/09_data_rights.md`: Spotify Developer Terms IV.3.1, III.9).
