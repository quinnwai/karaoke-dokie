# Setlist tuner: Round 7 follow-up ("Mood")

**You already built Round 6A** from `setlist-round6a-README.md` (which built on Round 5). This round is a **user-facing change only**: the gear users saw as "Tempo" is now shown to them as **"Mood"** (Slow jams to Party bops), drawn as a neon speaker. **The backend and the data do not change.** Apply these changes to your Round 6A build. Do not start over.

- **Source:** Design canvas "Song Difficulty Badges" (https://claude.ai/artifact/45eqcaRx9ymFefUujnN5u1), section "Round 7", boards **R7-Mood** ("Mood speaker (expanded)") and **R7-Mood-Mini** ("Mood speaker (mini, Mood tab)"). Use them for the look only (see §9).
- **Reference file:** `setlist-round7-mood.html`. Plain HTML/CSS/JS, open it directly; `?mini=1` starts in mini mode.
- **Which source wins:** this README, then the reference file, then the canvas. Anything not mentioned here stays as in the Round 6A README. Report any mismatch.

---

## 0. Scope

| Layer | Changes? |
|---|---|
| Backend, API, song field `tempo` and its 0–100 values | **No** |
| Ranking (L1 distance, using the same `tempo` value) | **No** |
| Defaults (`DEFAULTS.tempo = 45`) | **No** |
| Front-end internals: state key `tempo`, gear id `tempo`, ids and selectors (`#slider-tempo`, `data-gear="tempo"`, `data-reset="tempo"`), test hooks | **No.** Keep them. Renaming internals is out of scope for this round. |
| Visible text: gear label, end labels, tab label | **Yes** (§2) |
| Screen-reader text: reset button `aria-label` | **Yes** (§2) |
| Gear art (strip) and tab icon | **Yes**: speaker replaces metronome (§4, §5) |
| Reason-line fallback tags under each song | **Yes** (§2) |

Until the backend has real mood scores, the Mood slider ranks songs by the existing tempo scores (§9).

---

## 1. Change checklist

- [ ] Copy changes: label, end labels, tab label, reset `aria-label` (§2)
- [ ] Reason-line fallback tags (§2)
- [ ] Speaker art in the strip (§4)
- [ ] Speaker icon in the tab (§5)
- [ ] Remove the metronome visuals and keyframes (§6)
- [ ] Update the tests listed in §8

---

## 2. Copy changes

| Where | Round 6A | Round 7 |
|---|---|---|
| Gear label | TEMPO | **MOOD** |
| End labels | Slow jams / Upbeat tracks | **Slow jams / Party bops** |
| Tab label | Tempo | **Mood** |
| Reset `aria-label` | Reset tempo to default (stop factoring it in) | **Reset mood to default (stop factoring it in)** |
| Off label | TEMPO · OFF | **MOOD · OFF** |

**Nothing users see or hear should say "Tempo"** after this round.

**Reason line, rule 4 (the fallback).** Rules 1–3 are unchanged. The fallback still reads the song's `tempo` score; only the words and cut-offs change, so the tag matches the zone the user sees (§3):

| Song's `tempo` score | Round 6A | Round 7 |
|---|---|---|
| ≥ 67 (was ≥ 70) | Gets the room moving | **Party bop** |
| < 34 (was ≤ 25) | Slow burner | **Slow jam** |
| otherwise | Solid pick | **Feel-good** |

---

## 3. Zones (front end only)

The UI groups the gear's existing 0–100 value into three zones. Nothing is stored; the zone is computed on the fly.

| Zone | Value |
|---|---|
| Slow jams | 0–33 |
| Feel-good | 34–66 |
| Party bops | 67–100 |

The zones drive the speaker's waves and thump (§4, §5) and the reason tags (§2). The zone name is not shown as a label in this round.

---

## 4. Strip art: neon speaker

Replaces the metronome in the 150×80 viewBox. Violet strokes (`--violet` `#B583FF`, unchanged), same glow filter as the other gears (`feGaussianBlur stdDeviation=2` merged under the source). `v` below is the gear's value (`tempo`). Copy geometry from the reference.

| Part | Geometry |
|---|---|
| Cabinet | rect x 52, y 8, 36×64, rx 5, stroke 2.4 |
| Tweeter | circle (70, 21) r 4.5, stroke 1.8 |
| Woofer cone | circle (70, 48), **r = 10 + v × 0.03** (1 decimal: 10.0 to 13.0), stroke 2.2 |
| Dust cap | circle (70, 48) r 4, stroke 1.8 |
| Sound waves | 3 arcs per side, stroke 2, ±40° around centres (92, 46) right and (48, 46) left, radii 9, 17, 25 |

Arc paths (right / left):
- r 9: `M98.9 40.2 A9 9 0 0 1 98.9 51.8` / `M41.1 40.2 A9 9 0 0 0 41.1 51.8`
- r 17: `M105 35.1 A17 17 0 0 1 105 56.9` / `M35 35.1 A17 17 0 0 0 35 56.9`
- r 25: `M111.2 29.9 A25 25 0 0 1 111.2 62.1` / `M28.8 29.9 A25 25 0 0 0 28.8 62.1`

**Waves follow the zone:**
- The inner pair is always shown.
- The middle pair appears from Feel-good (v ≥ 34).
- The outer pair appears from Party bops (v ≥ 67).
- Opacity fades over 180 ms.

**Thump:** the cone and dust cap group scales around (70, 48).
- Keyframes `thump4`, `thump8`, `thump12` (scale 1 → 1.04 / 1.08 / 1.12 → 1), picked by zone (Slow jams / Feel-good / Party bops).
- Duration `(1.4 − v × 0.011)` s, 2 decimals (1.40 s at 0, 0.90 s at the default 45, 0.30 s at 100), `ease-in-out infinite`.

**Off:** strokes `--unlit`, `animation: none`, drawn at the default value (45, so 2 waves per side). Flicker on turn-on, flat knob and "· OFF" tag are unchanged from 6A.

---

## 5. Tab icon: small speaker

On the 28×22 tab viewBox (shown at 34×27), stroke violet when on, `--unlit` when off, `drop-shadow(0 0 3px violet)` when on.

- **Body:**
  - Cabinet: rect x 10.2, y 2.5, 7.6×17, rx 1.6, stroke 1.4.
  - Tweeter: circle (14, 6) r 1.1, stroke 1.
- **Cone:** circle (14, 13.6), **r = 1.7 + v × 0.006** (2 decimals), stroke 1.2. It uses the **same thump animation** as the strip, origin (14, 13.6).
- **Waves:** 3 arcs per side, stroke 1.2, same zone rule as the strip.
  - `M21.5 10.1 A3 3 0 0 1 21.5 13.9` / `M6.5 10.1 A3 3 0 0 0 6.5 13.9`
  - `M23.4 8.5 A5.5 5.5 0 0 1 23.4 15.5` / `M4.6 8.5 A5.5 5.5 0 0 0 4.6 15.5`
  - `M25.3 6.9 A8 8 0 0 1 25.3 17.1` / `M2.7 6.9 A8 8 0 0 0 2.7 17.1`

---

## 6. Remove

- Metronome art in the strip and tab, and its `bpm` and weight maths.
- Keyframes `swing8`…`swing20` and the `.pend` class. The reduced-motion rule now lists `.thump`: `.thump, .bob, .buzz, .wipe, .flick { animation: none !important; }`.

---

## 7. Fixtures

**Ranking is unchanged from Round 6A**, because the data and defaults are unchanged: I Want It That Way, Wannabe, Rolling in the Deep, Valerie, Since U Been Gone, Mr. Brightside, Shallow, Motion Sickness, Harvest Moon, I Will Always Love You.

**Top 5 rows at default** (only row 5's reason changes):

| Rank | Title | Reason | Badge |
|---|---|---|---|
| 1 | I Want It That Way | In your sweet spot · Crowd favourite | Medium |
| 2 | Wannabe | In your sweet spot | Medium |
| 3 | Rolling in the Deep | Crowd favourite | Hard |
| 4 | Valerie | In your sweet spot | Medium |
| 5 | Since U Been Gone | **Party bop** (was "Gets the room moving") | Hard |

---

## 8. Tests

All 36 below pass against `setlist-round7-mood.html` (Playwright, Chrome). Selectors and state keys still say `tempo`. The test hook adds `viewModel().moodZone` ("Slow jams" / "Feel-good" / "Party bops"); remove the hook in production.

**Round 6A tests 1–32 still apply unchanged**, except:
- Test 12 (replaces Tempo 55 → `swing14`): value 80 → strip cone animation `thump12`, 0.52 s.
- Test 23: rows 1–5 match the §7 table.
- Test 25: reset the gear → speaker strokes `#34313D`, `.thump` has `animation-name: none`.
- Test 28 (replaces the tab metronome check): value 80 → tab cone animation equals the strip's; tab cone `r = 2.18`.
- Test 30: the reduced-motion check uses `.strip[data-gear=tempo] .thump`.

**New:**

33. Value 20 / 50 / 80 → `moodZone` "Slow jams" / "Feel-good" / "Party bops", and 1 / 2 / 3 waves per side visible in **both** the strip and the tab.
34. Strip cone `r` is "10.0" at 0 and "13.0" at 100.
35. Copy: gear label "MOOD", end labels "Slow jams" / "Party bops", tab label "Mood", reset `aria-label` "Reset mood to default (stop factoring it in)", and no visible text or `aria-label` on the page contains "tempo".
36. Difficulty 0, all eras on → reason lines: Since U Been Gone "Party bop" (75), Stand by Me "Slow jam" (30), Respect "Feel-good" (60).

---

## 9. Open questions

- **The data still measures tempo.** Until the backend has mood scores, "Party bops" favours faster songs, which isn't always the same as dance-floor songs. Moving to real mood scores is a separate backend/data task:
  - If it reuses the same 0–100 field, the front end needs no change.
  - If it adds a new field, the front end needs only a field mapping.
  - Source options found so far:
    - An AI rating from title and artist with this rubric: "0 = the room sways or listens quietly (ballads, love songs). 50 = the room sings along but stays put. 100 = the room jumps and dances. Judge by the room's reaction, not the lyrics." Spot-check a sample.
    - Essentia's open-source audio classifiers (party, danceability, sad, arousal/valence; https://essentia.upf.edu/api/docs/tutorial/algorithms). They need audio files, and the models are CC BY-NC-ND 4.0, with a commercial license on request (https://essentia.upf.edu/gaia_svm_models.html).
    - Spotify's audio features (energy, danceability, valence) are closed to apps created after 27 Nov 2024 (https://techcrunch.com/2024/11/27/spotify-cuts-developer-access-to-several-of-its-recommendation-features).
- **Canvas boards are for the look only.** The R7 mock boards use their own illustrative mood scores and a default of 50, so their song order differs. Follow this README and the reference for data, defaults and ranking.
- **Canvas mini board** opens on the Mood tab so reviewers see the speaker. The product still opens the mini sheet on History (Round 5 §2).
- Round 6A open questions (header placeholders, off-state contrast, font self-hosting) and Round 5 §11 (choose real defaults) are still open.
