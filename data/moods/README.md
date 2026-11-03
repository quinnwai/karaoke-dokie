# Mood labels (QWW-11, QWW-19)

Mood chips on the results screen need labels we make ourselves: **Upbeat** (energetic, happy,
danceable) and/or **Heartfelt** (love, heartbreak, ballads), or neither. Three sources label songs,
all offline; nothing calls a model or an API at request time:

- **AcousticBrainz** (CC0): audio classifiers run over the recordings, read by MusicBrainz ID.
- **An LLM** (OpenAI `gpt-6-luna` for the Billboard run; Gemini and Claude also work) from each
  song's artist, title and year. No lyrics or audio are sent. It may say it doesn't know a song,
  and an unknown song gets no label.
- **MGPHot** (CC BY-NC-ND 4.0): music experts' scores. By default it is only an offline check of
  the other two and nothing from it is stored or shown (see "MGPHot").

A mood is shown only after it passes the gate below and is listed in `MOODS_SHIPPED`.

| File | What it is |
| --- | --- |
| `gold-set-template.csv` | 60 songs for Quinn-Wai to label by hand: the gold set the gate scores against. |
| `labels-openai-v1.json` | Run 1 of `gpt-6-luna` on the Billboard list (see "Billboard run"). |
| `labels-acousticbrainz-v1.json` | Not here yet: waits for the AcousticBrainz API (QWW-17); see "AcousticBrainz". |

## The LLM

- `npm run moods:label -- --in songs.json --out labels.json --provider openai [--model ...] [--resume]`
  with `OPENAI_API_KEY` set; `--provider gemini` reads `GEMINI_API_KEY` and `--provider anthropic`
  (the default) reads `ANTHROPIC_API_KEY`. Default models: `gpt-6-luna`, `gemini-3.8-flash`,
  `claude-haiku-5-5`. Each provider is called with plain `fetch` (`src/lib/moods/openai.ts`,
  `gemini.ts`, `anthropic.ts`); no SDK.
- Method `gpt-6-luna/moods-v1`: the model, then the prompt version (`PROMPT_VERSION` in
  `src/lib/moods/label.ts`). Bump the version whenever the prompt or the request changes. Rows are
  stored under the provider's source: `openai`, `gemini` or `claude`.
- 25 songs per request. The reply must be JSON `{"labels": [{"key", "known", "upbeat", "heartfelt"}]}`
  (enforced as structured output by every provider, then checked again). Malformed items, keys not
  in the batch and every copy of a repeated key are dropped and counted. Songs a reply left out stay
  unlabelled, and a rerun with `--resume` asks about them again.
- No `temperature` or other sampling setting is sent to any provider (Claude 5 models reject it);
  thinking stays at each model's default.

## AcousticBrainz

AcousticBrainz ([acousticbrainz.org](https://acousticbrainz.org), MetaBrainz, CC0) ran audio
classifiers over recordings people submitted, keyed by MusicBrainz recording ID. The vocal-range
pipeline's measured recordings carry that ID (`range.mbid`), so

```sh
npm run moods:acousticbrainz -- <pipeline>/data/karaoke_ranges.json --cache <dir outside the repo> \
  --out data/moods/labels-acousticbrainz-v1.json
```

reads each recording's models (25 recordings per request, at most 2 requests a second, every raw
response cached in the folder, so a rerun asks only about the rest) and labels every song key whose
recording AcousticBrainz has. Method `acousticbrainz-proxy-v1`, source `acousticbrainz`. Being
CC0, the labels may be committed.

Proxy rules, fixed on Nov 3, 2026 before any AcousticBrainz label was compared with MGPHot or any
other source (each model gives the probability of its class, from 0 to 1):

- Upbeat: mood_happy >= 0.7 or mood_party >= 0.7 or danceability >= 0.8, and mood_sad < 0.5
- Heartfelt: mood_sad >= 0.6, or mood_relaxed >= 0.7 and mood_happy < 0.5

**Not run yet (Nov 3, 2026).** The API answered normally at 15:25 and has returned 500 and 504
errors since about 15:50, its home page included, so only one batch (25 recordings) is cached. The
labels file and the AcousticBrainz numbers below wait for the API (QWW-17): rerun the command
above, which carries on from the cache. The final data dump on data.metabrainz.org holds the same
documents, but only as 30 files of about 40 GB in all, each mixing every recording ID, so it was
not used.

## MGPHot

MGPHot has music experts' scores from 0 to 1 on 58 attributes for 21,299 Billboard Hot 100 songs,
1958 to 2022: Oramas, Gouyon, Hogan, Landau and Ehmann, "MGPHot: A Dataset of Musicological
Annotations for Popular Music (1958-2022)", *TISMIR* 8(1), 2025,
[doi:10.5334/tismir.236](https://doi.org/10.5334/tismir.236), data on Zenodo (record 15372063). It
is licensed CC BY-NC-ND 4.0, © SiriusXM 2025. The repo is public, so nothing derived from it is
committed: the scripts read its two files from a folder you pass.

Proxy rules, fixed before comparing them with any labels ("high" is about the top third of songs
since 1990 on that attribute; a lyric theme counts at 0.6 or more):

- Upbeat: Danceability >= 0.8 or Aural Intensity >= 0.7, and Sad Lyrics < 0.6
- Heartfelt: Love/Romance Lyrics >= 0.6 or Sad Lyrics >= 0.6

The proxies are rough. Heartfelt counts any song with strong love lyrics, dance hits included;
Upbeat counts loud songs that are not sad, angry rock included.

**Off in the app by default.** The No Derivatives term may not allow sharing labels adapted from
MGPHot, so `npm run moods:mgphot-import -- <mgphot folder>` only prints how many songs get each
mood (21,299 songs give 23,272 song keys, 2,002 of them by the first credited artist of a duet;
Upbeat 35.2%, Heartfelt 58.0%). Only with `--show-in-app`, Quinn-Wai's call, does it store them
(method `mgphot-proxy-v1`, source `mgphot`), and then the app shows them for every mood in
`MOODS_SHIPPED`. `--dry-run` never writes. To take them out again, delete the rows
(`DELETE FROM song_moods WHERE source = 'mgphot'`) and rerun `moods:import`.

## Storing labels: precedence

The store keeps one row per song. `npm run moods:import -- <labels.json> [more.json ...] [--dry-run]`
takes runs from `moods:label` and source files like `labels-acousticbrainz-v1.json`, and the most
trusted source wins each song (`src/lib/moods/merge.ts`): MGPHot (expert annotation, when stored),
then AcousticBrainz, then the LLM. A file never overwrites a row from a more trusted source, in the
store or in another file of the same import; between equals the later row wins, so a relabel
replaces the old one. A trusted source that gives a song no mood still wins: the song shows no chip.

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
   a quick listen, and don't look at any source's labels first. Leave both cells empty for a song
   you don't know; it is left out. This takes about 30 to 45 minutes.
3. Save as CSV, then turn it into the checked-in gold set, which records who labelled it and when:
   `npm run moods:gold -- my-labels.csv --by "Quinn-Wai" --out data/moods/gold-set.json`.
4. A second person labels the first 30 rows of a fresh copy (the rows are in random order) the same
   way: `npm run moods:gold -- their-labels.csv --by "Their Name" --out data/moods/gold-second.json`.
5. Label the gold songs 3 times (3 small requests per run) and run the gate:

   ```sh
   for n in 1 2 3; do npm run moods:label -- --in data/moods/gold-set.json --out gate-$n.json --provider openai; done
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

Labelled 3 times with `gpt-6-luna` on Nov 3, 2026; `labels-openai-v1.json` is run 1:

```sh
for n in 1 2 3; do npm run moods:label -- --in songs.json --out run$n.json --provider openai; done
npm run moods:report -- --labels run1.json --labels run2.json --labels run3.json
```

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Songs the model knew, of 3,657 | 3,629 | 3,630 | 3,630 |
| Upbeat | 1,961 | 1,937 | 1,937 |
| Heartfelt | 1,939 | 1,958 | 1,931 |
| Requests | 147 | 148 | 147 |
| Tokens in and out (thinking included) | 150,349 and 260,346 | 150,677 and 254,562 | 150,349 and 252,133 |
| Cost at list prices ($0.10 in and $0.50 out per million tokens) | $0.15 | $0.14 | $0.14 |

About 50 minutes per run, one request at a time; the 3 runs ran side by side. Run 2 dropped one
malformed answer, and `--resume` asked about that song again.

Stability: 80.0% of the songs got the same label in all 3 runs (known or not, and the same moods);
the Upbeat chip is the same in all 3 runs for 88.3% of songs, and the Heartfelt chip for 90.0%.

**Choosing the model.** A pilot labelled 150 songs from the tune half of the MGPHot overlap (see
the next section; MGPHot says yes to 41% of them for Upbeat and 57% for Heartfelt) with four
current models, scored against the MGPHot proxies:

| Model | Upbeat precision and recall | Heartfelt precision and recall | List price per million tokens, in and out |
| --- | --- | --- | --- |
| `gpt-6-luna` | 0.59, 0.74 | 0.88, 0.82 | $0.10, $0.50 |
| `gpt-6.1-terra` | 0.62, 0.63 | 0.88, 0.84 | $1.00, $5.00 |
| `gemini-3.8-flash` | 0.57, 0.84 | 0.82, 0.80 | $0.75, $3.75 (doubling on Jan 1, 2027) |
| `gemini-3.5-flash-lite` | 0.54, 0.89 | 0.83, 0.62 | $0.30, $2.50 |

The differences are within the noise of 150 songs, so the cheapest won. The held-out half was not
used. At the same token counts a full run would cost about $0.45 with `gemini-3.8-flash` and $0.90
with `gpt-6.1-terra`; labelling the 60 gold songs costs under a cent per run.

## Check against MGPHot

Until the gold set is labelled, MGPHot's proxy labels are the only reference, and a provisional
one. `npm run moods:mgphot-check` hands them to the gate code as a stand-in gold set, so the same
seeded split and bars decide:

```sh
npm run moods:mgphot-check -- <mgphot folder> --songs songs.json \
  --labels run1.json --labels run2.json --labels run3.json [--ab data/moods/labels-acousticbrainz-v1.json]
```

The proxy labels stay in memory. Songs are joined by `songKey` of MGPHot's Billboard artist and
title, or of its first credited artist when that misses: 2,502 of the 3,657 keys. MGPHot ends in
2022, so few 2020s songs match (245 of 539 keys with a 2020s year).

Results on Nov 3, 2026. MGPHot says yes to 44.8% of the held-out songs for Upbeat and 56.2% for
Heartfelt, so random yes answers would score about those precisions. The LLM knew 2,494 to 2,496 of
the 2,502 songs.

| Held-out half, 1,251 songs | Run 1 | Run 2 | Run 3 | Against the provisional reference |
| --- | --- | --- | --- | --- |
| Upbeat precision | 0.62 | 0.61 | 0.60 | **Fails** (needs 0.8) |
| Upbeat recall | 0.74 | 0.73 | 0.71 | |
| Heartfelt precision | 0.85 | 0.85 | 0.85 | **Passes** |
| Heartfelt recall | 0.80 | 0.80 | 0.79 | |

The tune half agrees (Upbeat precision 0.62 in every run, Heartfelt 0.86 to 0.87). Where both
label a song (2,494 songs), MGPHot and the LLM's run 1 agree on Upbeat for 67.8% of songs (Cohen's
kappa 0.36, fair) and on Heartfelt for 80.4% (kappa 0.61, substantial).

Not measured yet, waiting for the AcousticBrainz API (QWW-17): AcousticBrainz's precision and
recall, those of AcousticBrainz with the LLM filling its gaps, and the agreement of all three
sources. `moods:mgphot-check --ab` prints them.

**Recommended: `MOODS_SHIPPED=heartfelt`**, with the LLM's labels stored
(`npm run moods:import -- data/moods/labels-openai-v1.json`). By default MGPHot is not stored and
AcousticBrainz has no labels yet, so the LLM's labels are what the app shows, and its Heartfelt
labels pass the gate against MGPHot in all 3 runs. Upbeat stays off: 0.6 precision is far under the
bar. Some of that gap may be the proxy's (it counts loud songs that are not sad, angry rock
included, and misses happy songs that are not very danceable), so the gold set may judge it
differently. Before storing AcousticBrainz labels, rerun the check with `--ab`: they take
precedence over the LLM's, so store them only if "AcousticBrainz, then the LLM" passes for every
mood in `MOODS_SHIPPED`.

**The hand-labelled gold set is still the real gate.** MGPHot's proxies are rough and were never
checked against people, so a pass here is provisional. Keep a mood on for good only after
`npm run moods:report` passes it on Quinn-Wai's gold set (see "Labelling the gold set by hand").
