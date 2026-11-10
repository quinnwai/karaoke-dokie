# Tempo feel labels (QWW-54)

`tempo-feel.json` gives a feel label, slow, mid or upbeat, to the catalogue songs that can reach either end of the
Tempo gear. `npm run tempo:feel` imports it into the `song_feel` table; what the labels do to the ranking is in
`docs/backend.md` ("Feel labels and the one tempo"). This file says how they were made and what to trust.

## What they are

A label is a language model's recall of how the original recording feels, from the artist, title and year only. It is not
a measurement: no audio, no measured tempo and no lyrics went in. They were made once, offline, on 10 Nov 2026 by
`claude-opus-5-5`, in three passes. The first pass (method `claude-opus-5-5/feel-v1`) labelled batches of about 350 to 410
songs, each batch a separate fresh run that saw only its own songs and the instructions below; a song the model did not know
got no label, and a song that two batches labelled differently became "mid". The second look and the recheck are described
further down. The file holds 6,196 labels, which cover 6,202 of the catalogue's 7,638 songs (81%) and 97 to 98% of the 300, 1,000, 2,000 and
3,000 most popular: **685 slow, 3,738 mid and 1,779 upbeat songs**. Of the mids, 691 are songs a later pass
took away a slow or upbeat label from (method `claude-opus-5-5/feel-recheck-v1`).

The labels are tuned for precision at the two ends: the instructions say to answer slow or upbeat only when it is
unmistakable, and mid otherwise. So a song missing from an end is expected, and a song at an end has been vouched for.
The cost is that slow labels are scarce in recent years. Of the Billboard Year-End songs, the share the first pass labelled slow is 24%
for the 1990s, 11% for the 2000s, 7% for the 2010s and 7% for the 2020s (upbeat: 21%, 19%, 27% and 16%). An era with
fewer than 18 slow songs in a list's pool cannot fill a slow top 20 with 18 slow songs whatever the ordering, so the
slow end of the 2010s and 2020s in particular may fall short of QWW-54's "18 of 20" bar for lack of songs, not for lack
of ranking.

## Why a label and not a better rule

Deezer's bpm was read for the Billboard songs labelled slow or upbeat (719 of them have one). The measured rule alone (fold
into 70 to 180) puts them like this, by label:

| Label | Songs | Slow band | Mid band | Upbeat band |
|---|---|---|---|---|
| slow | 297 | 16 (5%) | 105 (35%) | 176 (59%) |
| upbeat | 422 | 3 (1%) | 257 (61%) | 162 (38%) |

So most slow songs are read at double time or more, and no rule on the numbers alone can tell them from a fast song. With
the label, 228 of the 297 slow songs are halved into the slow band, 53 go to its top edge and 16 were already in it.

## The instructions (feel-v1)

```
You label songs by how the ORIGINAL recording feels, from what you know of it. The labels decide which songs sit at the two
ends of a "Slow jams ... Upbeat tracks" slider in a karaoke app. A wrong song at an end is a visible bug; a song missing from
an end costs nothing. So precision at the two ends matters far more than recall.

Labels (use exactly these definitions)
- "slow": a ballad or slow jam, slow and gentle.
- "upbeat": fast or energetic, a song people dance or bounce to.
- "mid": in between, a mid-tempo song that is neither.
- "unknown": you do not know this exact song well enough to say.

Rules
1. Judge the feel of the recording, not a BPM number. A song that is counted at 140 but feels like a slow ballad (for example
   a 12/8 ballad) is "slow". A song with a half-time groove that people still dance to is "upbeat".
2. Say "slow" or "upbeat" only when it is unmistakable: ten different listeners asked "is this slow?" (or "is this upbeat?")
   would all say yes, every time. If you hesitate, or the answer depends on the section (a power ballad that builds into a
   loud chorus, a mid-tempo groove, laid-back hip-hop or R&B, a gentle song that is not quite a ballad, a song that is upbeat
   in the verses and slow in the chorus), answer "mid".
3. If you cannot place this exact song, answer "unknown". Do not guess from the title or from the artist's general style. A
   different song with a similar title does not count.
4. Work from memory only. Do not search the web. Do not write code that produces the labels; judge each song yourself, one
   by one.
5. Be consistent: a Bee Gees disco track and a Bee Gees ballad get different labels; two songs of the same feel get the same
   label.
```

The definitions of the three labels are the ones the release harness' judge (QWW-52, `src/lib/eval/release.ts`
`JUDGE_SYSTEM`) uses, so a label and a judge answer mean the same thing.

## The second look and the recheck

**First pass.** Precision-first, and measured against blind judge runs it was: of the songs it labelled slow or upbeat that three
runs of the harness' judge saw on the legacy lists, 91% and 92% were called the same by all three. But it called many songs mid
that a listener would call slow or upbeat: of the songs all three judge runs called slow, it had labelled 59% slow and 41% mid
(upbeat: 76% and 24%). That thinned the slow end.

**Second look (`claude-opus-5-5/feel-plain-v1`).** Every song the first pass called mid among the songs the app shows in the
release harness' five test ranges and in F2 to C5 and E2 to E5 (1,718 of them) was answered by two independent runs with the
plain definitions only, the ones in the harness' judge prompt, with none of the first pass' extra strictness. A song moved from
mid to slow or upbeat only when both runs said so: of the 1,718 the runs agreed on 1,533 (89%) and 712 moved (248 to slow, 464 to
upbeat).

**Recheck (`claude-opus-5-5/feel-recheck-v1`).** Judged by blind runs, the moved songs were the weak spot: on the lists, 74% of
the promoted slow songs and 46% of the promoted upbeat ones drew an all-three agreement, against 89% and 93% for the first
pass' own. So every slow or upbeat label in the file, first pass and second look alike (3,152 labels), got one more independent
run with the first pass' strict instructions, and **a label stays only if that run gives the same one; otherwise the song is
mid.** Nothing moves the other way. 92% of the first pass' slow labels (629 of 682) and 94% of its upbeat labels (1,653 of
1,758) were confirmed, but only 22% of the promoted slow labels (55 of 248) and 27% of the promoted upbeat ones (124 of 464),
which is why the second look added so little in the end.

The recheck was chosen from the labelling runs' own agreement, not from any judge's answer on a list. The judges' answers
motivated looking (they showed which labels were weak) but no label was changed because a judge called its song something else.
All three passes are one model answering the same question in different words, so they share blind spots; the hand check of one
era's lists by Quinn-Wai (QWW-54 "Done when") is the independent test, and a known error stays in: Take On Me, published at 170
bpm, is labelled mid.

## Where the songs came from

- the Billboard Year-End Hot 100 for 1990 to 2025 (`data/billboard-year-end.csv` in the release harness), 3,268 distinct songs;
- a list of about 400 well-known karaoke songs each for the 1950s and 1960s, the 1970s and the 1980s, which the model
  listed from memory;
- the songs of the catalogue (the real `karaoke_pr4_preview` catalogue) that had no label from the two sources above and are
  shown in the release harness' five test ranges or in F2 to C5 and E2 to E5, plus the most popular unlabelled songs in the
  catalogue's own order, found with `npm run tempo:feel -- --unlabeled songs.json [--served]`.

The file keeps each label under every key the catalogue may know the song by (the full credit and the lead artist).

## What is not graded here

These labels are not graded by their maker. The release harness' judge never sees them, and Quinn-Wai checks one era's
lists by ear (QWW-54 "Done when"). A label is also not proof: where a person disagrees, change the song's entry in
`tempo-feel.json` (or remove it) and run `npm run tempo:feel -- --apply` again; it writes only the rows that changed.

## File format

```
{ "method": "claude-opus-5-5/feel-v1", "labeledAt": "2026-11-10",
  "labels": [ { "keys": ["artist|title", "full credit|title"], "feel": "slow" }, ... ] }
```

`parseFeelFile` (`src/lib/tempo/feelFile.ts`) checks it before anything is written: a key labelled two ways, a missing
field or an unknown feel stops the step.
