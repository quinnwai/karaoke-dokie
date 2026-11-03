# Mood labels (QWW-11)

Mood chips on the results screen need labels we make ourselves. Claude labels each song **Upbeat**
(energetic, happy, danceable) and/or **Heartfelt** (love, heartbreak, ballads), or neither, from its
artist, title and year (and genre when known). No lyrics or audio are sent. It may say it doesn't
know a song, and an unknown song gets no mood. Labels are made offline and stored; nothing calls the
model at request time. A mood is shown only after it passes the gate below.

| File | What it is |
| --- | --- |
| `gold-set-template.csv` | 60 songs for Quinn-Wai to label by hand: the gold set the gate scores against. |
| `labels-billboard-haiku-v1.json` | Not here yet: run 1 of the Billboard labels (see "Billboard run"). |

## How labels are made

- `npm run moods:label -- --in songs.json --out labels.json [--model ...] [--resume]`, with
  `ANTHROPIC_API_KEY` set. Default model `claude-haiku-5-5`; the ticket says to step up to
  `claude-sonnet-5-5` only if Haiku fails the gate.
- Method `claude-haiku-5-5/moods-v1`: the model, then the prompt version (`PROMPT_VERSION` in
  `src/lib/moods/label.ts`). Bump the version whenever the prompt or the request changes.
- 25 songs per request. The reply must be JSON `{"labels": [{"key", "known", "upbeat", "heartfelt"}]}`
  (enforced as structured output, then checked again). Malformed items, keys not in the batch and
  every copy of a repeated key are dropped and counted. Songs a reply left out stay unlabelled, and
  a rerun with `--resume` asks about them again.
- No `temperature` is sent (Claude 5 models reject it); thinking stays at the model's default.
- `npm run moods:import -- labels.json` writes one row per song the model knew (its moods may be
  empty) to `song_moods`, replacing the song's earlier row. Unknown songs get no row.

## The gate

`npm run moods:report` decides, per mood, on the held-out half of the gold set (`GATE` in
`src/lib/moods/gate.ts`):

- precision of at least 0.8, so the songs under the chip really have the mood;
- recall of at least 0.4, so a labeller that almost never says yes cannot pass on a few easy songs;
- in each of 3 separate labelling runs (all 3 are reported, not the best one);
- and, when a second person labelled songs too, the two agree on the mood at least 80% of the time.
  Below that, the bar is above what people manage, so the mood is dropped rather than tuned.

The gold set is split in two halves by a fixed seed. Tune prompts on one half (the report's "tune
half") and judge on the other. A song with no label counts as "no", as it would in the app. A mood
that fails stays off.

## Labelling the gold set by hand

1. Copy `gold-set-template.csv` and open the copy in a spreadsheet.
2. For each song, put `y` or `n` under `upbeat` and under `heartfelt`: `y` when you would expect
   to find the song under that chip. Upbeat: energetic, happy, danceable. Heartfelt: love,
   heartbreak, ballads. A song can be both, either or neither. Go by what you know of the song, or
   a quick listen, and don't look at Claude's labels first. Leave both cells empty for a song you
   don't know; it is left out. This takes about 30 to 45 minutes.
3. Save as CSV, then turn it into the checked-in gold set, which records who labelled it and when:
   `npm run moods:gold -- my-labels.csv --by "Quinn-Wai" --out data/moods/gold-set.json`.
4. A second person labels the first 30 rows of a fresh copy (the rows are in random order) the same
   way: `npm run moods:gold -- their-labels.csv --by "Their Name" --out data/moods/gold-second.json`.
5. Label the gold songs 3 times (3 small requests per run) and run the gate:

   ```sh
   for n in 1 2 3; do npm run moods:label -- --in data/moods/gold-set.json --out gate-$n.json; done
   npm run moods:report -- --gold data/moods/gold-set.json --second data/moods/gold-second.json \
     --labels gate-1.json --labels gate-2.json --labels gate-3.json
   ```

   Post the report on QWW-11 either way.

The template has 15 songs from each decade of the Billboard list below (1990s to 2020s), sung and
mostly-rap songs in proportion within each decade (8 rap songs in all), and no artist twice. The
list has no genres, so sung or rapped is the only style split it can make. The ticket also asks for
songs that fit beta users; there is no beta data yet, so these come from the whole list.

## Billboard run

The song list is the vocal-range pipeline's `karaoke_ranges.json`: 3,657 song keys for 3,095 songs.
The other 562 keys are other spellings of the same songs (like `*nsync|bye bye bye` next to
`nsync|bye bye bye`) and are labelled too, since the app looks songs up by any of them. Each song
gets the year of its first Billboard Year-End chart from `billboard_songs.csv`, joined by `songKey`
of `artist_credit` and title, or of the first credited artist for duets (3,651 of 3,657 keys; a song
released late in a year often charts the next). Rebuild it, and the template, with:

```sh
npx tsx scripts/moods-billboard.ts <pipeline>/data --songs songs.json --template data/moods/gold-set-template.csv
```

**Not run yet (Nov 3, 2026): no working Anthropic API key was available.** To run it:

```sh
for n in 1 2 3; do npm run moods:label -- --in songs.json --out billboard-run$n.json; done
npm run moods:report -- --labels billboard-run1.json --labels billboard-run2.json --labels billboard-run3.json
```

Then commit run 1 as `labels-billboard-haiku-v1.json` and add here the cost (each label run prints
its token counts and a cost at list prices: $0.10 in and $0.50 out per million tokens for
`claude-haiku-5-5`) and the stability: the share of songs whose labels agree in all 3 runs, which
the report prints overall and per chip.

## Check against MGPHot (QWW-19)

A sanity check, not the gate. MGPHot has music experts' scores from 0 to 1 on 58 attributes for
21,299 Billboard Hot 100 songs, 1958 to 2022: Oramas, Gouyon, Hogan, Landau and Ehmann,
"MGPHot: A Dataset of Musicological Annotations for Popular Music (1958-2022)", *TISMIR* 8(1),
2025, [doi:10.5334/tismir.236](https://doi.org/10.5334/tismir.236), data on Zenodo (record
15372063). It is licensed CC BY-NC-ND 4.0, © SiriusXM 2025, so it is used offline only: nothing from
it is committed or shipped, and `scripts/moods-mgphot.ts` reads it from a folder you pass.

Proxy rules, fixed before comparing them with any labels ("high" is about the top third of songs
since 1990 on that attribute; a lyric theme counts at 0.6 or more):

- Upbeat: Danceability >= 0.8 or Aural Intensity >= 0.7, and Sad Lyrics < 0.6
- Heartfelt: Love/Romance Lyrics >= 0.6 or Sad Lyrics >= 0.6

The proxies are rough. Heartfelt counts any song with strong love lyrics, dance hits included;
Upbeat counts loud songs that are not sad, angry rock included.

Songs are joined by `songKey` of MGPHot's Billboard artist and title, or of its first credited
artist when that misses. Overlap with the Billboard list: 2,502 of 3,657 keys (2,500 songs; 114
joined by the first artist). MGPHot ends in 2022, so few 2020s songs match (245 of 539 keys with a
2020s year). In the overlap, the Upbeat proxy says yes for 45% of songs and the Heartfelt proxy for
57%. Random yes answers score about those precisions, so they are the numbers to beat.

Precision and recall of run 1 against the proxies: not run yet (it needs run 1). Run it with
`npx tsx scripts/moods-mgphot.ts <mgphot folder> labels-billboard-haiku-v1.json`.
