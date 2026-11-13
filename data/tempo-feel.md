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
further down. The file holds 6,236 labels, which cover 6,242 of the catalogue's 7,638 songs (82%): **895 slow, 4,577 mid and 770
upbeat songs** since the pace relabel of 13 Nov, described below (on 12 Nov, before it, there were 6,202 labelled
songs, 97 to 98% of the 300, 1,000, 2,000 and 3,000 most popular, and 878 slow, 3,312 mid and 2,012 upbeat). Of the mids, 436 are
songs the strict recheck took a slow or upbeat label from (method `claude-opus-5-5/feel-recheck-v1`); the band-edge audit below
changed 430 labels, but only 2 of them to mid (the other 428 went from mid to slow or upbeat); and the pace relabel took 1,246 keys to
mid (his 25 by hand, 1,221 by the recheck). Thirty-one labels were set by hand: a-ha, Take On Me, from mid to upbeat (method `manual/hand-fix-qww-54`); Ed Sheeran, I See
Fire, from mid to slow (`manual/hand-fix-qww-54b`); four songs whose label the independent judge put at the opposite end and a second
model did not back (`manual/hand-fix-qww-54d`, listed below); and Quinn-Wai's 25 songs of 13 Nov (`manual/hand-check-qww54-1`).

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

## A mid label can hide a slow song

Mid is not neutral for a song read at double time. A label only moves a reading by whole octaves when that is cheaper than
leaving it, so a slow ballad whose reading sits near the mid band stays there and is pinned just inside the top edge of the
mid band (about 125 bpm), right under every upbeat song. That is what happened to Ed Sheeran's "I See Fire", labelled mid: 124.8
bpm and 72 of 100 on the Tempo gear, near the top at "Fast tracks". With the slow label the same reading is halved into the
slow band. So a wrong mid on a slow or upbeat song shows as a song pinned within a bpm or two of an edge of its band (90 or
125) while its reading says otherwise; that is where to look for wrong labels.

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
era's lists by Quinn-Wai (QWW-54 "Done when") is the independent test. The one error known so far, Take On Me (published at
170 bpm, marked "Fast"), was labelled mid by the model and has been set to upbeat by hand.

## The band-edge audit (QWW-54 follow-up, 12 Nov)

A label that disagrees with the measured tempo leaves the song pinned just inside the edge of its band. A wrong mid on a slow
ballad sits at about 125, right under the upbeat songs: that was Ed Sheeran's "I See Fire". So every labelled song in the best
1,000 of each release harness range (bass to soprano, low male and beginner) and of F2 to D4, from the tuner's default list and
from the old whole list, whose effective tempo was within 2 bpm of a band edge (40, 90, 125 or 215), was rechecked: 1,820 songs.
Three independent runs of `claude-opus-5-5` per song, each given only the artist, title and year and the plain definitions in
the release harness' judge prompt, never the tempo or the label. A label changed when at least two runs agreed on the same
different label; a change from one end to the other without all three runs behind it went to mid.

1,388 labels were confirmed, 430 changed and one song had no majority. The 430 are 197 mid to slow, 231 mid to upbeat and 2
slow to mid; 359 have all three runs behind them. Each is marked `claude-opus-5-5/feel-edge-recheck-v1` in `song_feel.source`.
All 676 upbeat labels at 125 were confirmed. "I See Fire" was also one of the 1,820 (all three runs said slow); it was set by
hand in the same week (`manual/hand-fix-qww-54b`) and is left out of these 430. The audit looked only at songs at an edge of their band, not at every label.

The recheck is the same kind of model as the first pass and as the harness' judge, so it is not independent of either; the hand
check of one era is still the test.

## Clear and weak labels (QWW-54 follow-up, 12 Nov)

An independent judge (OpenAI gpt-6-luna, three runs, the majority verdict) graded every one of the 7,244 songs that fit a test range
of the release eval. Against its verdicts, a label agrees as often as the pass that made it was strict:

| Label from | slow, judge agrees | upbeat, judge agrees |
|---|---|---|
| the strict first pass (`claude-opus-5-5/feel-v1`) | 95% of 600 | 98% of 1,579 |
| the second look (`…/feel-plain-v1`) | 83% of 53 | 90% of 116 |
| the audit, all three runs agreeing (`…/feel-edge-recheck-v1`) | 79% of 171 | 89% of 187 |
| the audit, two of three runs agreeing | 58% of 26 | 61% of 44 |

So a slow or upbeat label made by the second look or the audit (250 slow and 355 upbeat in this file) is a **weak** one. The song
keeps the label and its band, but `effectiveTempo` puts it in the strip at the band's inner edge, in the order of its own tempo,
behind the clear songs whose readings fit their band (`isWeakLabelSource`, `src/lib/tempo/feel.ts`). That is not every clear song: a
clear song whose reading cannot be fitted to its band (a slow label on a song read at 100, say) is forced to the same edge and shares
the strip with the weak ones. A weak label with no reading at all goes last in the strip, behind the weak songs whose readings back it.
A weak song still fills an end when an era has too few clear songs. Labels from the strict first pass and from a person (`manual/…`)
are clear. `tests/tempo/feelFile.test.ts` lists every method this file uses as strict or weak, so a typo or a new pass cannot count
as strict by default. On the release eval's 144 lists of criterion 2 (Tempo alone), graded on the saved answers of the independent judge, this and the label fixes below took the lists reaching 18 of 20 from 96 to 120 (judge set A); two fresh sets of judge runs gave 90 to 115 and 91 to 119 for the first version of this change.

The same grading showed eight labels at the opposite end from the judge's verdict. The judge also grades the release eval, so moving a
song only because it disagrees would teach the labels its mistakes; a second model (Gemini, three runs per song) decided which to change.
Four are changed by hand (`manual/hand-fix-qww-54d`), and a hand-set label counts as clear:

| Song | Was | Judge | Gemini | Now |
|---|---|---|---|---|
| Hilary Duff, What Dreams Are Made Of (2003) | slow | upbeat | upbeat | upbeat |
| Luke Combs, Going, Going, Gone (2023) | slow | upbeat | mid | mid |
| Sia, Bird Set Free (2015) | slow | upbeat | mid | mid |
| Dr. Horrible's Sing-Along Blog, Slipping (2008) | upbeat | slow | mid | mid |

Four stay slow, because Gemini says slow too and they are ballads: Whitney Houston, Where Do Broken Hearts Go (the 1988 ballad; the
uptempo song of that name is One Direction's, from 2014), Hi-Five, I Can't Wait Another Minute, En Vogue, Don't Let Go (Love) and
The Cover Girls, Wishing on a Star. The judge calls all four upbeat, so each one that reaches a slow top 20 costs the judge's count
there; the hand check of one era is the test of who is right.

## The pace relabel (QWW-54, 13 Nov)

Quinn-Wai checked the tuner's lists by ear, 10 to 20 songs at each end of each era. The '60s and '90s lists were good; the other eras
had songs at an end they do not belong to. At the slow end: gentle songs at a walking pace (Chasing Cars, shown at 104
bpm, Fields of Gold, Words, My Hometown). At the fast end: songs that are upbeat in energy and not fast in pace, such as reggaeton (La
Bebé), hip-hop and country grooves, and rock at a mid-tempo groove (Pour Some Sugar on Me, Cochise, Zombified). Two things made them:
the definitions were about energy ("upbeat: fast or energetic, a song people dance or bounce to"), and a doubled reading (a song felt at
86 and counted at 172) put half-time songs at the top of the gear. His standard, which the labels now follow: **"fast" means a fast
pace, not just energy; "slow" means a slow ballad; anything at a walking pace or a mid-tempo groove is mid.** His ear is the metric for
every decision below; no judge's answer decided a label. (The right end of the Tempo gear now says "Fast tracks"; the stored label is
still `upbeat`.) The change list, by era and end, with his 25 marked, is on QWW-54.

1. **His 25 songs are mid**, set by hand (`manual/hand-check-qww54-1`, which counts as clear) under every key of each song that the
   file or the release harness' pools know. Words, Fields of Gold, Chasing Cars and My Hometown were slow. La Bebé, Hot Girl Bummer,
   Fancy Like, Kick the Dust Up, Getaway Car, Send My Love (To Your New Lover), Awake and Alive, Marry You, All of the Lights, Capricorn,
   Rude Boy, The Diary of Jane, Home (Three Days Grace), Alive (P.O.D.), Cochise, Wavin' Flag, Pour Some Sugar on Me, Major Tom, Lola
   and Zombified were upbeat, and so was Danger Zone, the one he asked to have checked against the artist and genre: it is published at
   about 126 bpm, a driving mid-tempo beat and not a clearly fast one, so it is mid too.
2. **Every other upbeat label of a song in the release harness' nine test ranges was rechecked**: 1,920 songs (labels set by hand were
   left alone). Three blind runs of `claude-opus-5-5` per song (method `claude-opus-5-5/feel-pace-recheck-v1`), each a fresh run that
   saw the artist, title and year, the instructions below and 30 worked examples: his 24 songs other than Danger Zone as mid, and six
   anchors (Take On Me, Barbara Ann, Born To Be Wild, Basket Case and Mambo No. 5 fast; I See Fire slow). **A label changed only when
   two of the three runs said mid** (a song's other spellings count together: two thirds of all their votes), and the song's other
   upbeat keys changed with it. 1,180 upbeat labels (61% of 1,920) became mid; all three runs agreed on 1,053 of them, two of three on
   127. The recheck moved nothing the other way (no song had a majority for fast on a slow label or for slow on an upbeat one), and 8
   songs came back unknown or split and kept their labels.
   **Run but not applied: the slow end.** The 855 slow labels went through the same three runs, and 83 keys (81 songs) drew two thirds
   mid votes. They stay slow, because his standard says "slow" means a slow ballad and the recheck's pace bar moved ballads that standard
   keeps slow (Yesterday, In My Life, Dust in the Wind, Dido's Thank You at a felt 80). His four slow complaints were gentle songs with
   a walking beat and are set to mid by hand above, as examples of mid and not as a bar for every ballad under about 105 bpm. The 83 are
   listed in the change list on QWW-54.
3. **QWW-56's two items went in first**, so the recheck saw them: the label the band-edge audit set on one spelling of a song was
   copied to its other spellings (24 keys: 21 with a mid label and 3 with none), and 43 songs the catalogue's fold left with no
   label (3 of them among the 24) took the label of their other spelling. Three of the 43 are different recordings that share a
   title and were left out (Disney's Goofy und Max and Chip & Chap intros, the Gummi Bears and DuckTales theme songs, Robin
   Schulz's and Robin S.'s Show Me Love). So 61 keys: 21 changed and 40 new rows. Ten keys go from mid to slow this way, each a spelling
   that takes the label of its main row, and all are ballads: November Rain, Don't Let the Sun Go Down on Me (two credits), Say You,
   Say Me, Die with a Smile, Cat's in the Cradle, Don't Let Go, I'm with You, Where'd You Go and Young Forever. (The other copies and the
   new rows went through the recheck like any other label, so a spelling copied as upbeat that the recheck sent to mid is back where it was.)
4. **One label per song across its spellings** (a follow-up, 13 Nov). After the step 11 songs still had one label under one spelling and
   another under a twin: the recheck had moved three NSYNC songs under `★n sync` while `nsync` and `*nsync` stayed upbeat, and eight
   older songs had split on an apostrophe, a hyphen or a credit. Where the recheck judged a spelling its verdict decides (NSYNC's Bye Bye
   Bye, It's Gonna Be Me and I Want You Back go to mid, Zedd's Clarity, judged fast under "Zedd & Foxes", to upbeat); otherwise the label of
   the more popular key, taken to be the catalogue's own row, the one the app and the release pools show. James Arthur's Say You Won't Let
   Go stays slow (the recheck's mid verdict on the slow end is not applied); The Who's Won't Get Fooled Again, KT Tunstall's Black Horse and
   the Cherry Tree, Ne-Yo's Let Me Love You, Kendrick Lamar's DNA., En Vogue's My Lovin' and Imagine Dragons' It's Time are mid. 12 keys
   change, each taking its twin's label and method; `tests/tempo/feelFile.test.ts` checks that the 11 songs keep one label. Two pairs stay
   apart on purpose, Kid Cudi's Day 'n' Nite and Lana Del Rey's Summertime Sadness against their "vs." credits: those are remixes, other
   recordings.

**How the instructions were chosen.** The first draft, the plain standard with his 25 as examples, kept only 156 of the 1,920 upbeat
labels as fast, and on the '60s and '90s lists he had called good it moved most of the songs too. The instructions below add what
settles a song: judge the pace a listener taps, not the counted tempo or the genre, and estimate it in beats per minute. Tried on 12
of his songs held out of the examples they gave mid for 10 (Getaway Car, La Bebé, Pour Some Sugar on Me, Cochise, All of the Lights,
Fancy Like, Marry You, Chasing Cars, Rude Boy, Words), unknown for Home and fast for Lola (felt at 136; it is in his 25, so it is mid
by hand); on 14 songs from the '60s and '90s lists, 12 stayed fast (Beatles, Dion, Chattahoochee, Brown Eyed Girl and the like) and
two moved (\*NSYNC, I Want You Back at 100; Inner Circle, Sweat at 96); six controls (three slow, three fast) were right. Across the
pool the songs that stayed fast were felt at a median of 138 bpm (5th percentile 128) and those that moved to mid at 116 (95th
percentile 126): in effect, the fast end is songs felt at about 128 bpm or more.

**What it did to the ends.** Of the 63 lists (nine ranges by seven eras) 60 still have 20 or more upbeat songs to fill a fast top 20 from
labelled songs alone (63 before), the smallest has 17 and the median list 92 (209 before); the slow end is as it was (61 of 63 have 20 or
more, the smallest 12, the median 67 against 69 before). Reggaeton and other Latin urban songs, which the runs tagged: 33, all labelled
upbeat, 30 are mid now; the three that stay fast are Bad Bunny's Después de la Playa (felt at 158) and Danza Kuduro (130, two keys), neither
a dembow groove. Hip-hop and rap: 169 tagged, 151 upbeat, 121 of them mid now; the 30 that stay are felt at 126 to 165 bpm, and the
ones near the line (Pitbull, Flo Rida, Nicki Minaj at 126 to 133) are where his ear may differ.

**What to trust.** The recheck is the same kind of model as the first pass, working from memory with no audio and no measured tempo, and
its felt tempos are recollections, not measurements; nothing here grades it except his ear. The 127 upbeat labels that only two
of three runs sent to mid are the least certain moves. Two of his complaints are not about labels: the wrong
recording behind Chasing Cars and Wavin' Flag is the Deezer match (QWW-67).

## The instructions (feel-pace-recheck-v1)

The file each run read, word for word. Its labels are slow, mid and fast; a "fast" answer is stored as `upbeat`.

```
# Labelling songs by felt pace (QWW-54, the pace relabel, second pass)

You label songs by their PACE, the way Quinn-Wai, the product owner, hears it. The labels decide which songs sit at the two ends
of a "Slow jams ... Fast tracks" slider in a karaoke app. A wrong song at an end is a visible bug, but so is an end with no songs
in it: call a song fast when its pulse really is quick, and do not call it mid just because you are unsure.

How to judge: the pace of the ORIGINAL recording as a listener feels it and taps along, from what you remember of it. Not its
energy, loudness, mood or genre.

## Labels (use exactly these words)

- "fast": a fast pace. The felt pulse is quick, roughly 130 beats per minute or more as a listener taps it: fast rock and roll,
  punk, pop-punk, fast rock, fast pop and dance, fast country. Count the beat the listener feels: a song counted at 140 whose
  backbeat falls at half that speed (a half-time feel) feels half as fast.
- "mid": a walking pace or a mid-tempo groove, roughly 85 to 125 felt beats per minute: mid-tempo pop, R&B, soul, country and
  rock; hip-hop and reggaeton grooves (usually 85 to 105 felt); rock and pop with a half-time or laid-back feel; gentle songs at a
  walking pace; and energetic, intense or happy songs whose pulse is only a mid-tempo groove.
- "slow": a slow ballad or slow jam, slow and gentle, roughly under 85 felt beats per minute. People sway or slow dance to it.
- "unknown": you cannot place this exact song. Do not guess from the title or from the artist's general style. A different song
  with a similar title does not count.

## Rules

1. Pace, not energy. A loud, intense, angry, triumphant or party song that moves at a mid-tempo groove is mid. A gentle song at a
   walking pace is mid, not slow. A song whose pulse really is quick is fast even when it is old, plain or not loud.
2. Judge the felt pace, not the counted tempo, and not the genre alone: a ballad counted at 140 but felt at half speed is slow or
   mid; a hip-hop or reggaeton song is mid unless the song itself is clearly fast; a country or rock song at a groove is mid.
3. Give your best estimate of the felt tempo in beats per minute for every song you place (a whole number), and let the label
   follow the definitions above. When you cannot place the song, answer "unknown" and "bpm": null.
4. Work from memory only. Do not search the web. Do not write code that produces the labels; judge each song yourself, one by one.
   Read only the two files you are told to (these instructions and your song list) and write only your own output file.

## Worked examples

Quinn-Wai listened to lists of songs at the two ends of the slider and said these were wrong where they stood. Each is MID:

- F. R. David - Words (1982): mid, a gentle pop song at a walking pace
- Sting - Fields Of Gold (1993): mid, a gentle song at a walking pace
- Snow Patrol - Chasing Cars (2006): mid, a gentle song at a walking pace, about 104 beats per minute
- Bruce Springsteen - My Hometown (1984): mid, a gentle song at a walking pace
- Yng Lvcas - La Bebé (2023): mid, a reggaeton groove
- Blackbear - Hot Girl Bummer (2020): mid, a hip-hop pop groove
- Walker Hayes - Fancy Like (2021): mid, a country hip-hop groove
- Luke Bryan - Kick the Dust Up (2015): mid, a country groove
- Taylor Swift - Getaway Car (2017): mid, an energetic pop song at a mid-tempo groove
- Adele - Send My Love (To Your New Lover) (2015): mid, a bouncy pop song at a mid-tempo groove
- Skillet - Awake And Alive (2014): mid, intense rock at a mid-tempo groove
- Bruno Mars - Marry You (2010): mid, a bright pop song at a mid-tempo groove
- Kanye West feat. Various Artists - All Of The Lights (2010): mid, a hip-hop groove
- Thirty Seconds to Mars - Capricorn (A Brand New Name) (2002): mid, rock at a mid-tempo groove
- Rihanna - Rude Boy (2009): mid, a dancehall pop groove
- Breaking Benjamin - The Diary of Jane (2006): mid, rock at a mid-tempo groove
- Three Days Grace - Home (2003): mid, rock at a mid-tempo groove
- P.O.D. - Alive (2001): mid, rock at a mid-tempo groove
- Audioslave - Cochise (2002): mid, hard rock at a mid-tempo groove
- K’naan - Wavin’ Flag (2009): mid, an anthem at a mid-tempo groove
- Def Leppard - Pour Some Sugar On Me (1987): mid, hard rock at a mid-tempo groove
- Peter Schilling - Major Tom (völlig losgelöst) (1982): mid, synth-pop at a mid-tempo groove
- The Kinks - Lola (1970): mid, rock and roll at a mid-tempo groove
- Falling In Reverse - Zombified (2022): mid, rock at a mid-tempo groove

For the two ends, songs that are right there:
- a-ha - Take On Me (1985): fast, about 170
- The Beach Boys - Barbara Ann (1961): fast, about 160
- Steppenwolf - Born To Be Wild (1968): fast, about 145
- Green Day - Basket Case (1994): fast, about 175
- Lou Bega - Mambo No. 5 (A Little Bit Of ...) (1999): fast, about 174
- Ed Sheeran - I See Fire (2013): slow, about 75

## What to write

A song list has one song per line: `id. Artist - Title (year)`. Write ONE JSON file, an array with one object per line of the list,
in order, nothing else in the file:

    [{"id": 0, "label": "mid", "bpm": 104, "g": ""}, {"id": 1, "label": "fast", "bpm": 150, "g": ""}, ...]

- "label" is exactly one of "slow", "mid", "fast", "unknown". "bpm" is your felt tempo, a whole number, or null for unknown.
- "g" marks the genre where it is one of these two, else "": "rg" for reggaeton and other Latin urban songs, "hh" for hip-hop and rap.
- Every id of the list appears once. No comments, no prose in the file. When the file is written, reply with one line: the number of songs labelled.
```

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
`tempo-feel.json` and run `npm run tempo:feel -- --apply` again; it writes only the rows that changed. Change an entry,
do not delete it: the import never deletes a row, so a deleted entry leaves the song's old label in `song_feel`. Use `mid`
for a song that is neither slow nor upbeat, and give a hand-set entry its own `method` (as the Take On Me entry has), so
`song_feel.source` shows who set it.

## File format

```
{ "method": "claude-opus-5-5/feel-v1", "labeledAt": "2026-11-10",
  "labels": [ { "keys": ["artist|title", "full credit|title"], "feel": "slow" }, ... ] }
```

`parseFeelFile` (`src/lib/tempo/feelFile.ts`) checks it before anything is written: a key labelled two ways, a missing
field or an unknown feel stops the step.
