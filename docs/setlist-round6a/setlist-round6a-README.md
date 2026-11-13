# Setlist tuner: Round 6A follow-up ("Neon signs")

**You already built Round 5** from `setlist-round5-spec.md` and `setlist-round5.html`. This is the next round. Do not start over. Apply the changes below to your Round 5 build.

Round 6A reskins the screen into the karaoke-dokie "night out" theme (dark room, neon tubes, grey bezel) and adds a little content to each song row. **State, ranking, reset/off logic and sheet behavior do not change.**

- **Source:** Design canvas "Song Difficulty Badges" (https://claude.ai/artifact/45eqcaRx9ymFefUujnN5u1), section "Round 6", board **R6A-Neon** ("Setlist tuner, neon signs, expanded").
- **Reference file:** `setlist-round6a.html`. Plain HTML/CSS/JS, no build. Open it directly; add `?mini=1` to start in mini mode.
- **Which source wins:** this README, then `setlist-round6a.html`, then the canvas. For anything this README does not mention, the Round 5 spec still applies. Report any mismatch you find.
- **Ignore** the canvas boards R6A-Neon-Mini (it lags the expanded board, see §13), R6B-Machine and R6B-Machine-Mini (direction B was not chosen).

---

## 0. Change checklist

Work through these in order. Each links to its section.

- [ ] Theme tokens, Inter font, bezel frame and footer (§3)
- [ ] Header row: vocal range, redo button, カラオケ sign (§3.4)
- [ ] Song rows: 66 px tall, reason line, difficulty badge, lyric wipe on #1, mini lane removed (§4)
- [ ] Sheet, strip and slider styling; fader knob; "HISTORY" label; compact art 140×75 (§5)
- [ ] Neon gear art: new colours and geometry for all four gears (§6)
- [ ] Off state drawn as unlit tubes instead of grey/transparent; flicker when turned back on (§7)
- [ ] Era panel: song count in the header, new button states (§8)
- [ ] Tab bar: every tab icon reacts to its gear; Era tab is a jukebox (§9)
- [ ] Motion and reduced motion (§10)
- [ ] Accessibility deltas (§11)
- [ ] Tests: Round 5 tests with the listed adjustments, plus new tests 22–32 (§12)

---

## 1. What does not change

Keep your Round 5 implementation of these as is:

| Area | Round 5 spec |
|---|---|
| State object, keys, `DEFAULTS` (placeholders: 30 / 65 / 80 / 45 / '90s '00s '10s) | §2 |
| Sheet constants (rack 416 / 164), `compact` rule, strip heights 76 / 94, era button heights 52 / 60, tab height 62 | §3 |
| All interactions: slider input, pointer-down on an off slider, reset buttons, era toggles, tabs, handle tap/drag (6 px / 50 px / -8 px) | §4 |
| Reset = back to default **and** off; off vs. empty era; no "reset all"; no undo | §4a (logic only; visuals change, see §7 here) |
| Ranking (L1 distance over gears that are on; era filter skipped when Era is off) | §5 |
| Song data shape and the 25 mock songs | §5 |
| Default ranking fixture | §5 |
| Reset icon path, 44×26 hit area, negative margins, focus handling, `aria-label`s | §4a, §8 |
| Notes/bolts visibility thresholds `(i + 0.5) × 100 / 7` | §6 |
| Metronome amplitude and period formulas | §6 |
| Build ticket for real defaults | §11 |

---

## 2. How to read the reference file

The reference is wired so the logic is easy to lift into any framework.

- `viewModel(state)` is a **pure function** that returns every derived value the screen shows: colours, sizes, visibility, row content, handlers. Port this function's logic into your components. It mirrors the canvas board's `renderVals()`.
- `data-b="target:path|suffix; ..."` binds an element to a view-model path. `target` is an attribute name, `style.<css-prop>`, `class.<name>` (class on when the value is `true`), `text` or `value`. `|suffix` appends a unit such as `px` or `%`.
- `data-on="event:path"` attaches a DOM event to a view-model handler.
- `$i` in the row template is the song's catalogue index.
- The small binder at the bottom (`applyBindings`, `wireEvents`) is glue for the reference only. **Do not ship it**; use your framework's rendering.
- Test hook: `window.setlist = { getState, setState, ranking, viewModel, songs }`. `viewModel()` is new this round. Remove the hook in production.

Round 5 test selectors still work: `#app.is-compact`, `.strip.is-off`, `#era-panel.is-off`, `.tab.is-off`, `.era-btn.is-parked`, `#app[data-mode]`, `#app[data-open]`.

---

## 3. Theme

### 3.1 Tokens (replace the Round 5 table)

| Token | Value | Use |
|---|---|---|
| `--page` | `#070609` | Outside the device |
| `--bezel` | `#17161B` | Bezel frame |
| `--bezel-ring` | `#222128` | 1 px ring around the bezel |
| `--screen` | `#0E0C12` | Screen background |
| `--panel` | `rgba(255,255,255,0.025)` | Strip, era panel, tab background |
| `--rail` | `#26242D` | Slider rail, idle borders |
| `--row-line` | `#1F1D25` | Row divider |
| `--text` | `#F3EFF7` | Primary text |
| `--text-strong` | `#F6F2FA` | H1 |
| `--text-2` | `#B9B4C4` | Header controls |
| `--text-3` | `#9E99AA` | Row sub line, slider end labels, era count |
| `--text-4` | `#7C7887` | Rank number |
| `--muted` | `#6E6A78` | Off label and " · OFF" tag |
| `--reset` | `#8E8A99` | Reset icon (hover `--text`) |
| `--unlit` | `#34313D` | An unlit neon tube (off gear art) |
| `--pink` | `#FF4FA0` | Era, lit selections, mic |
| `--pink-text` | `#FF6FB1` | Badge text, lyric wipe |
| `--pink-line` | `#F0509A` | Badge border, reason line |
| `--cyan` | `#4FDDE8` | History |
| `--amber` | `#FFC24A` | Popularity bolts, Era jukebox lights, difficulty mid tier |
| `--violet` | `#B583FF` | Tempo |
| `--easy` | `#4DE89A` | Difficulty < 34 |
| `--hard` | `#FF5A8A` | Difficulty ≥ 67 |

**Gear colours:** Difficulty = tier colour (`--easy` / `--amber` / `--hard`, same 34 / 67 cut-offs as Round 5's `laneColor`), History = cyan, Popularity = amber (bolts) with a pink mic, Tempo = violet, Era = pink.

### 3.2 Type (replaces Barlow Semi Condensed)

Inter 400/500/600/700, fallback `system-ui`. The カラオケ sign uses Noto Sans JP 700 (subset to those four characters).

| Element | Size / line height | Weight | Notes |
|---|---|---|---|
| H1 "Tune your setlist" | 24 / 30 | 700 | `-0.02em` |
| Row title | 16 / 20 | 600 | ellipsis |
| Row sub "Artist · Era" | 13 / 17 | 400 | `--text-3` |
| Row reason line | 12 / 16 | 400 | `--pink-line` |
| Badge | 12 / 16 | 600 | |
| Rank | 13 | 600 | `--text-4`, 18 px wide, right-aligned |
| Gear label (eyebrow) | 11 / 14 | 700 | `+0.12em`, uppercase text |
| Slider end labels | 12 / 14 | 500 | |
| Tab label | 11 / 13 | 600 | |
| Era button label | 10.5 / 12 | 600 | |
| Header range, redo | 13 | 500 / 400 | `--text-2` |
| Footer brand | 10 | 500 | `+0.32em`, `#55525E` |

### 3.3 Frame (new)

The bezel is part of the UI (from the old karaoke-dokie app), not a phone mockup.

```
device (390×844 mock; fills the viewport at ≤430 px wide)
  padding 14 10 12; background: radial glow #1C0C18 → #0B090E → #070609
  └ bezel: --bezel, radius 30, padding 9 9 0, ring 1 px --bezel-ring + soft pink drop glow
      ├ screen: --screen, radius 22, padding 16 12 0, gap 8, overflow hidden
      │   background: 1 px scanlines every 3 px (white 2.2%) + magenta radial glow near the top
      │   inner shadow: inset 0 0 40px rgba(0,0,0,.7)
      └ footer: 34 px tall, "KARAOKE-DOKIE" left, 7 px power dot #FF4D9A with glow right
```

### 3.4 Header row (new)

28 px tall row above the H1:

- **Vocal range** "F2 – G#4": each note has a 1 px dotted underline `#6B6776`.
- **redo** button: 28 px tall, 1 px `#3A3742` outline, radius 8, transparent.
- **カラオケ sign**, right-aligned: `#FF5FA8` with a two-layer pink text glow and a slow buzz (opacity dips to 0.55 for a moment every 3.2 s). `lang="ja"`, `aria-hidden="true"`.

Range and redo are **static placeholders** in this round (see §13).

---

## 4. Song rows

| | Round 5 | Round 6A |
|---|---|---|
| Row height (`ROW`) | 58 | **66** |
| Right side | 44×30 mini difficulty lane | **difficulty badge** (lane removed) |
| Lines of text | title, sub | title, sub, **reason line** |

Row positioning, fade-in-place for filtered rows, and the `top 280ms / opacity 180ms` animation are unchanged; only the 58 becomes 66 (row `r` at `r × 66`, list height `visibleCount × 66`).

**Anatomy:** rank · text column (title / "Artist · Era" / reason, 1 px gap) · badge. Gap 10. 1 px `--row-line` bottom border.

**Badge:** "Easy" if difficulty < 34, "Medium" if < 67, else "Hard". Same pink style for all three: 1.5 px `--pink-line` border, radius 8, padding 3 9, `--pink-text`, outer glow `0 0 8px rgba(240,80,154,.3)` and inner glow `inset 0 0 6px rgba(240,80,154,.15)`.

**Reason line** (`whyOf(song)`): collect parts in this order, keep the first two, join with " · ".

1. "In your sweet spot" if Difficulty is **on** and `|song.difficulty − difficulty| ≤ 15`
2. "Crowd favourite" if `popularity ≥ 85`, else "Deep cut" if `popularity ≤ 35`
3. "On repeat" if `history ≥ 85`, else "Rediscover" if `history ≤ 20`
4. If nothing matched: "Gets the room moving" if `tempo ≥ 70`, "Slow burner" if `tempo ≤ 25`, else "Solid pick"

Rules 2–4 use the song's own scores, not the slider values. These are first-pass rules (§13).

**Lyric wipe (rank 1 only):** a pink copy of the title (`--pink-text`, glow `0 0 8px rgba(255,79,160,.7)`) laid over the title and revealed left to right with `clip-path`, 3.4 s ease-in-out, infinite (reveal over the first 70%, then hold). It is `aria-hidden`. Only the row at rank 1 shows it; it moves with the #1 spot.

**Fixture at default state** (top 4):

| Rank | Title | Reason | Badge |
|---|---|---|---|
| 1 | I Want It That Way | In your sweet spot · Crowd favourite | Medium |
| 2 | Wannabe | In your sweet spot | Medium |
| 3 | Rolling in the Deep | Crowd favourite | Hard |
| 4 | Valerie | In your sweet spot | Medium |

Empty state text is unchanged ("Pick an era to see songs."), now 15 / 500, `--text-3`, padding 20 0.

---

## 5. Sheet, strips and sliders

**Sheet:** background gradient `#1B1A21 → #131218`, 1 px top border `rgba(255,79,160,.28)`, top radius 16, shadow `0 -10px 30px rgba(0,0,0,.55), 0 -1px 14px rgba(255,79,160,.10)`. Padding 0 12 12. It still bleeds to the screen edges.

**Handle:** hit area unchanged (140×44); visible bar is now 44×5, radius 3, `#4A4654`. Handle row 22 px.

**Strip:** `--panel` background, 1 px border, radius 10, padding 0 10 0 6, gap 10. Border is the gear colour at 27% alpha (`color + '44'`) when on, `--rail` when off. Art sits in a box with `rgba(0,0,0,.35)` and radius 6.

**Art size:** expanded 120×64 (unchanged); compact **140×75** (was 150×80).

**Labels:** DIFFICULTY, **HISTORY** (was "LISTENING HISTORY"; keep "listening history" in the reset `aria-label`), POPULARITY, TEMPO. Label colour is the gear colour when on.

**Slider:**
- Rail: 4 px `--rail`, radius 2.
- Fill: gear colour with `0 0 8px` glow in the same colour.
- **Knob (new): fader cap** 14×20, radius 3, 1 px `#CFCAD8` border, grey vertical gradient `#BDB8C7 → #77727F` with a 2 px dark centre line, drop shadow `0 2px 4px rgba(0,0,0,.6)`. Centred on the value (`left: value%`, `margin-left: -7px`).
- Focus ring on the knob when the hidden input has `:focus-visible` (unchanged approach).
- End label pairs unchanged ("Light work / Locked in", "Rediscover / On repeat", "Deep cuts / Pop hits", "Slow jams / Upbeat tracks"), `--text-3`.

---

## 6. Neon gear art

All art is outline-style "neon tubes". Each SVG uses the same glow filter: `feGaussianBlur stdDeviation=2` merged under the source graphic. **Copy geometry from the reference file exactly**; key values are listed so you can check your port.

ViewBox for strip art: `0 0 150 80`.

### Difficulty: pitch lane
- Faint grid: 5 horizontal lines at y 12, 26, 40, 54, 68, `#1F1D26`.
- `bandH = 14 + difficulty × 0.62` (unchanged). Band rect spans full width, `y = round(40 − bandH/2)`, height `round(bandH)`, fill tier colour at **12%** opacity.
- 7 dashes are now **round-capped lines**, stroke width 5, tier colour. x ranges: 9–22, 30–36, 46–62, 71–77, 87–97, 107–115, 125–141. Centre `y = round(40 + o × (bandH/2 − 3))` with `o = [0.8, 0.2, −1, −0.3, 1, −0.6, −0.9]`.

### History: headphones + 7 notes
All headphone strokes are **cyan only** (monochrome).
- Headband: `M47.3 46 V40 A28.4 28.4 0 0 1 102.7 40 V46`, stroke 3. It lands on top of each muff and never crosses into it.
- Left muff: `rotate(-7 49 60)`, rect x 41, y 46, 16×28, rx 8, stroke 2.4. Button line inside it: `M46 61 Q45.4 64 46 67`, stroke 1.4 (a short curve that follows the muff edge).
- Right muff: `rotate(7 101 60)`, rect x 93, same size. No cushions, no button.
- Notes: Round 5 shapes (single, beamed pair for note 2), **filled**. Positions:

| Note | Transform | Colour |
|---|---|---|
| 0 | `translate(24 38) rotate(-10)` | cyan |
| 1 | `translate(126 36) rotate(10)` | pink |
| 2 | `translate(12 66) rotate(-14) scale(1.1)` (beamed) | pink |
| 3 | `translate(132 64) rotate(12) scale(1.05)` | cyan |
| 4 | `translate(52 14) rotate(-8) scale(.85)` | cyan |
| 5 | `translate(100 12) rotate(8) scale(.85)` | pink |
| 6 | `translate(8 22) rotate(-18) scale(.9)` | cyan |

  The colour order follows Round 5 (its red notes are pink here, its dark notes cyan). Visibility threshold unchanged; 5 notes show at the default 65.

### Popularity: mic + 7 bolts
- Mic, pink, stroke 2.4, group `translate(75 44) rotate(-16)`: head `circle r=12`; band `M-12 0 H12` (1.6); grille `ellipse rx=5 ry=12` (1.4); collar `M-8 14 H8 L6 20 H-6 Z`; handle `M-4.5 22 L-3 42 H3 L4.5 22`. Keep it this simple.
- Bolts: Round 5 positions and rotations, **filled amber**. Visibility threshold unchanged; 6 bolts show at the default 80.

### Tempo: metronome
Violet outline, stroke 2.4 body.
- Body `M65 10 H85 L104 76 H46 Z`; top cap `M70 10 L75 5 L80 10`; base line `M53 56 H97`; winding key `M101.5 64 H107` plus `circle (110.5, 64) r=3.5`.
- Pendulum pivot moves to **(75, 56)** (was 75, 62). Rod `M75 56 V16`. Weight: rect x 69, 12×7, rx 2, `y = round(18 + tempo × 0.27)`.
- Swing: unchanged formulas. `bpm = round(50 + 1.5 × tempo)`, duration `60 / bpm` s, keyframe `swing{20 − 2 × round(tempo/100 × 6)}`, `alternate`.

---

## 7. Off state visuals (replaces the visual rules in Round 5 §4a)

The logic in Round 5 §4a is unchanged. Only the look changes: an off gear looks like a **switched-off neon sign**, not a faded one. No opacity or grayscale filter.

| Part | On | Off |
|---|---|---|
| Gear art strokes/fills | gear colour | `--unlit` `#34313D` (drawn at the default value) |
| Difficulty band | 12% tier colour | hidden |
| Metronome | swinging | still (`animation: none`) |
| Strip border | gear colour at 27% | `--rail` |
| Label | gear colour | `--muted` + " · OFF" tag |
| End labels | `--text-3` | `#5E5A68` |
| Fill | shown with glow | hidden |
| Knob | grey fader cap | flat `#1E1D24`, border `#4A4654`, at the default value |
| Reset button | shown | hidden |
| Tab icon (mini) | gear colour + `drop-shadow(0 0 3px colour)` | `--unlit`, no glow |

**Turn-on flicker (new):** whenever a gear's art goes from off to on (and on first load), play `neonOn` once on the art: 0.7 s linear, opacity 0.25 → 1 → 0.35 → 1 → 0.6 → 1, then hold at 1.

---

## 8. Era panel

**Header:** "ERA" then a count in `--text-3`, weight 500:
- Era on: "· N songs", where N is the number of ranked songs (e.g. "ERA · 10 songs" at default).
- Era off: "· OFF · all eras".

This replaces "ERA: PICK ANY" and "ERA: PICK ANY · OFF".

**Buttons** (7 columns, gap 4, radius 6, 1 px border, background `rgba(255,255,255,.02)`):

| State | When | Border | Text/icon | Extra |
|---|---|---|---|---|
| Lit | Era on and picked | `--pink` solid | `#FF8CC3` | glow `0 0 12px rgba(255,79,160,.35)` + inset `0 0 10px rgba(255,79,160,.12)`; icon `drop-shadow(0 0 3px pink)` |
| Parked (`.is-parked`) | Era off and a default pick | `#6A4459` **dashed** | `#A57891` | none |
| Idle | not picked | `#2A2833` solid | `#8A8596` | none |

`aria-pressed` is true only for Lit. Era icons are redrawn as neon outlines (22×22 on a 30×30 viewBox, `currentColor`); copy them from the reference.

Panel border: pink at 27% when on, `--rail` when off. Panel padding 7, gap 4 (heights still add up to 86 / 94).

---

## 9. Tab bar (mini sheet)

Tabs: 5 columns, gap 4, each 62 px, radius 8, 1 px border, `--panel` background. Icon 34×27 (viewBox `0 0 28 22`) above an English label. **No Japanese labels on tabs.**

**Selected tab:** border in the gear colour, glow `0 0 12px colour/33%` + inset `0 0 8px colour/13%`, label `--text`. Unselected: `--rail` border, label `--text-3`.

**Tab icons are now simplified icons**, not scaled-down copies of the strip art as in Round 5. Each one still reacts to its gear:

| Tab | Icon | What changes |
|---|---|---|
| Difficulty | 3 short dashes `M4 15 H9 M12 8 H17 M20 12 H25` | colour follows the tier |
| History | small headphones (band `M10.2 12.2 V10 A3.8 3.8 0 0 1 17.8 10 V12.2`, two tilted muffs) + **7 short rays** | ray `i` mirrors note `i`: same colour, same visibility threshold, placed where that note sits around the big headphones |
| Popularity | small pink mic (rotated −16°) + **7 short rays** | ray `i` mirrors bolt `i`: amber, same visibility threshold, same order |
| Tempo | small metronome (body `M11 3 H17 L22 20 H6 Z`, divider `M8.2 15.5 H19.8`) | pendulum swings with the **same animation** as the strip (pivot 14, 15.5); weight `y = 6 + tempo × 0.07` (1 decimal) |
| Era | simplified Round 5 **jukebox**: arch body, arched window with 3 bars, 2 round buttons | see rule below |

**Jukebox rule:**
- Era on, 1 era picked: left button amber, right button `#3A2A33`.
- Era on, 2 or more picked: both buttons amber.
- Era on, 0 picked: both `#3A2A33`.
- Era off: body `--unlit`, both buttons `#3A2A33`.
- Body is pink when Era is on.

Copy exact icon paths from the reference.

---

## 10. Motion

| Animation | Where | Spec |
|---|---|---|
| `swing8`…`swing20` | metronome (strip and tab) | unchanged from Round 5 |
| `bob` | notes and bolts in the strip art | 2 px up, 1.1 s, alternate, staggered delays (unchanged) |
| `neonOn` | gear art on turn-on | §7 |
| `buzz` | カラオケ sign | 3.2 s linear infinite |
| `wipe` | rank 1 title | §4 |
| notes/bolts appear | opacity | 180 ms |
| rows | top / opacity | 280 ms / 180 ms (unchanged) |
| rack height | height | 260 ms ease, none while dragging (unchanged) |

`prefers-reduced-motion: reduce` turns off: pendulum, bob, buzz, wipe, neonOn, and the row, rack and fade transitions. With reduced motion the #1 title shows fully pink (no sweep).

---

## 11. Accessibility deltas

Everything in Round 5 §8 still applies. New this round:

- カラオケ sign: decorative, `aria-hidden="true"`, `lang="ja"`.
- Lyric wipe copy of the title: `aria-hidden="true"` so the title is read once.
- Reason line and badge are plain text inside the row and are read with it.
- History reset `aria-label` still says "listening history" even though the visible label is "HISTORY".
- **Contrast check** on `--screen` (`#0E0C12`):
  - Pass (≥ 4.5:1): row sub 7.0, reason line 5.9, badge 7.6, rank 4.5, reset icon 5.8, idle era 5.4, parked era 5.3.
  - **Below 4.5:1:** off gear label `#6E6A78` (3.7) and off end labels `#5E5A68` (2.9). An off gear is still an operable control. Raise these (e.g. off label to `--text-3`) or get a design sign-off; see §13.
  - Footer brand `#55525E` (2.6) is decorative brand text.
- Round 5 known gap still open: rows sit in catalogue order in the DOM.

---

## 12. Acceptance tests

All of these pass against `setlist-round6a.html` (checked with Playwright in Chrome). The reference keeps Round 5's selectors (§2).

**Round 5 tests 1–21 still apply**, with these adjustments:
- Anywhere a row height or position is computed, use 66 instead of 58.
- Test 14: "hollow thumb at 45%" becomes "flat dark knob at `left: 45%`".
- Test 15: the label shows "· OFF · all eras" (contains "OFF").
- Test 16: tapping the knob at the default turns the gear on at 45 (±1 for pointer rounding).
- Test 20: the tab's icon strokes become `#34313D` as well as getting `.tab.is-off`.

**New tests:**

22. Row geometry: ranks 1, 2, 3 at `top` 0, 66, 132; each row is 66 px tall; list height = visible rows × 66.
23. Default rows match the §4 fixture (title, reason, badge), and only rank 1 shows the wipe.
24. Era count: "· 10 songs" at default; "· OFF · all eras" after resetting Era.
25. Reset Tempo: label colour `#6E6A78`, metronome strokes `#34313D`, pendulum `animation-name: none`.
26. At default, 5 notes and 6 bolts are visible.
27. Jukebox: default (3 eras) → body pink, both buttons amber. Only `s80` → left amber, right `#3A2A33`. Every gear reset → body `#34313D`, both `#3A2A33`.
28. Tempo 55: tab pendulum animation equals the strip's (`swing14`, 0.45 s) and the tab weight `y = 9.9`.
29. Turning a reset gear back on (e.g. ArrowRight) sets its art animation to `neonOn 0.7s`.
30. With `prefers-reduced-motion: reduce`, pendulum, bob, sign buzz, wipe and art flicker all have `animation-name: none`.
31. Mini sheet (`?mini=1`): strip art is 140×75.
32. No tab label contains Japanese characters; the カラオケ sign is `aria-hidden`.

---

## 13. Open questions and out of scope

- **Header range and redo:** placeholders carried over from the old karaoke-dokie app. Wiring them (the user's measured vocal range; redo = retake the range test?) needs a product decision. Until then, render them static or hide them behind a flag.
- **Reason rules and badge cut-offs** (§4) are first-pass heuristics for the mock data. Revisit them with real scoring.
- **Canvas mini board lags:** the canvas board R6A-Neon-Mini still shows an older headphone (thin cushions, oval button). Follow the expanded board and this reference. The mini layout itself is correct in the reference.
- **Direction 6B** (karaoke machine) was explored on the canvas and not chosen.
- **Fonts** load from Google Fonts in the reference. Self-host Inter and the Noto Sans JP subset for production.
- **Off-state contrast** (§11) needs a fix or a sign-off.
- **Round 5 §10 and §11 still apply:** no persistence, row taps do nothing, mock song scores, and the build ticket to choose real defaults. The fixtures in §4 and §12 depend on the placeholder defaults and must be updated with them.
