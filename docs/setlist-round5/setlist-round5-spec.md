# Setlist tuner: build spec (Round 5, "L2 with mini view")

Read this first, then use `setlist-round5.html` as the visual and behavioral reference.

- **Source:** Design canvas "Song Difficulty Badges", Round 5 boards `L2 expanded (default)` and `L2 mini (one gear)`. Both boards are the same component; only the starting sheet mode differs.
- **Reference file:** `setlist-round5.html`. Plain HTML/CSS/JS, no build. Open it directly. Add `?mini=1` to start in mini mode.
- **If this spec and the reference disagree, the spec wins.** Report the mismatch.

---

## 1. What the screen does

One mobile screen (mock size 390×844; production fills the viewport).

- **Top:** "Tune your setlist" heading, then a ranked, scrollable song list.
- **Bottom sheet:** four slider "gears" (Difficulty, Listening history, Popularity, Tempo) and a multi-select Era picker. Any change re-ranks the list live with animated row movement.
- **Reset:** every gear has a reset button (circular arrow). Reset puts the gear back to its **default value** and turns it **off**, so it stops counting in the ranking. Touching the gear again turns it back on, starting from the default. See §4a.
- **Sheet modes:**
  - **Expanded:** every gear visible.
  - **Mini:** one gear visible plus a 5-tab bar to switch gears. Leaves more room for the list.
- A grab handle on the sheet switches modes by tap or vertical drag.

---

## 2. State

One state object drives everything. Everything on screen is derived from it.

| Key | Type | Initial value | Notes |
|---|---|---|---|
| `difficulty` | int 0–100 | `DEFAULTS.difficulty` | Slider |
| `history` | int 0–100 | `DEFAULTS.history` | Slider |
| `popularity` | int 0–100 | `DEFAULTS.popularity` | Slider |
| `tempo` | int 0–100 | `DEFAULTS.tempo` | Slider |
| `eras` | string[] | `DEFAULTS.eras` | Any subset of `pre, s70, s80, s90, s00, s10, s20` |
| `off` | string[] | `[]` | Gear ids that are reset and not factored in: any of `difficulty, history, popularity, tempo, era` |
| `open` | `'difficulty' \| 'history' \| 'popularity' \| 'tempo' \| 'era'` | `'history'` | Which gear the mini sheet shows. Ignored for visibility when expanded, but still updated. |
| `mini` | bool | `false` (board L2 expanded) / `true` (board L2 mini) | Sheet mode |
| `dragY` | number \| null | `null` | Handle drag offset in px while dragging; negative = up |

Era labels: `pre` "Pre-’70s", `s70` "’70s", `s80` "’80s", `s90` "’90s", `s00` "’00s", `s10` "’10s", `s20` "’20s". The apostrophe is U+2019.

**Defaults** live in one `DEFAULTS` constant. On load every gear starts **on** at its default value.

| Gear | Placeholder default |
|---|---|
| Difficulty | 30 |
| Listening history | 65 |
| Popularity | 80 |
| Tempo | 45 |
| Era | `'90s, '00s, '10s` |

These are the mockup's values and are **placeholders**. Choosing real defaults is a task for the build ticket (§11).

---

## 3. Sheet layout

Constants: `RACK_FULL = 416`, `RACK_MINI = 164`.

```
dragging   = dragY !== null
base       = mini ? 164 : 416
rackHeight = dragging ? clamp(base - dragY, 164, 416) : base
compact    = mini && !(dragging && dragY < -8)
```

`compact` (not `mini`) decides which layout is drawn. That way, dragging up from mini switches to the full layout as soon as the sheet starts growing.

| Element | Not compact (expanded) | Compact (mini) |
|---|---|---|
| Rack height | 416 | 164 |
| Slider strips | all 4 shown | only the one matching `open`; none if `open = 'era'` |
| Strip height / left padding | 76 / 6 | 94 / 7 |
| Strip art size | 120×64 | 150×80 |
| Era panel | shown | only if `open = 'era'` |
| Era button height | 52 | 60 |
| Tab bar | hidden | shown |

Height check: expanded = 4×76 + 3×6 gaps + 8 + era panel 86 = 416. Mini = strip 94 (or era panel 94) + 8 + tabs 62 = 164. Content must fit with no clipping.

Rack height animates `260ms ease`, except while dragging (no transition).

---

## 4. Interactions

| Control | Effect |
|---|---|
| Slider input | Set that gear's value, remove it from `off`, set `open` to that gear |
| Pointer down on an off slider | Remove it from `off` at its current (default) value. Covers a tap that lands exactly on the default, which fires no `input` event. |
| Reset button on a slider | Set the gear to `DEFAULTS[gear]`, add it to `off`, set `open` to that gear, move focus to that slider |
| Reset button on Era | Set `eras` to `DEFAULTS.eras`, add `'era'` to `off`, set `open = 'era'`, move focus to the first era button |
| Era button | Toggle that era in `eras`, remove `'era'` from `off`, set `open = 'era'`. If Era was off, the toggle applies to the default picks (e.g. tapping '80s gives '90s, '00s, '10s, '80s). |
| Tab (mini only) | Set `open` to that tab's gear |
| Handle tap / Enter / Space | Toggle `mini` |
| Handle drag | See below |

**Handle drag**
1. `pointerdown`: record start Y, set `dragY = 0`, capture the pointer.
2. `pointermove`: `dragY = currentY - startY`. If `|dy| > 6`, mark the gesture as a drag.
3. `pointerup` / `pointercancel`:
   - If it was a drag: from mini, `dy < -50` sets `mini = false`; from expanded, `dy > 50` sets `mini = true`; otherwise mode is unchanged. Then `dragY = null`.
   - If not a drag: `dragY = null` only (the click handler does the toggle).
4. The `click` that follows a drag must be swallowed so it does not toggle mode a second time.

Handle: a 140×44 hit area centered on the sheet's top edge, with a visible 48×6 bar. `aria-expanded = !mini`. `aria-label` is "Show all gears" when mini, "Show one gear" when expanded.

---

## 4a. Reset and the off state

**Purpose:** let the user leave a gear out of the ranking entirely. Reset does two things at once:
1. Puts the gear back to its default value (§2).
2. Turns the gear off: it adds nothing to the ranking.

While off, the gear shows its default value in a disabled style. Touching it again turns it on and resumes from the default. For example, ArrowRight on a reset Tempo gives 46.

**Reset button**
- One per gear (4 strips + era panel), right-aligned in the gear's header row, level with the label.
- Icon: 16px counterclockwise circular arrow, 2px stroke, `currentColor` (`--text-2`, hover `--text`). SVG in the reference: `<path d="M4.5 12A7.5 7.5 0 1 0 12 4.5"/><path d="M14.5 1.75L11.75 4.5L14.5 7.25"/>` on a 24×24 viewBox.
- Hit area 44×26. Negative margins (`-8px -8px -4px 0`) keep the header row 14px tall, so rack heights (416 / 164) do not change. The icon's right edge lines up with the track's right edge.
- It sits above the invisible slider input (`z-index: 1`). A tap on the track's right end must still move the slider.
- Hidden while the gear is off (there is nothing to reset).
- `aria-label`: "Reset {gear} (stop factoring it in)". Tooltip: "Reset: don't factor in".

**Off state, slider gear**
- Label gets " · OFF" in `--text-3` (e.g. "TEMPO · OFF").
- Track fill hidden. Thumb becomes hollow (2px `--text-3` ring) and sits at the default value.
- End labels go to `--text-3`.
- Gear art: opacity 0.3, grayscale, animations paused, drawn at the default value.
- That gear's tab (mini) gets the same dimmed art.
- Input holds the default value with `aria-valuetext="Off"`.

**Off state, Era**
- `eras` holds the default picks, but no filter is applied: every era counts.
- The default picks show as outlined (2px `--text-3` inset ring, class `is-parked`), not filled. All buttons have `aria-pressed="false"`.
- Label reads "ERA: PICK ANY · OFF".
- Era tab art is dimmed and grayscale.

**Off vs. empty:** "Era off" (reset) shows every song. "Era on with nothing picked" (the user deselected every era by hand) shows the canvas's empty state, "Pick an era to see songs.", and Era's reset button stays visible.

---

## 5. Ranking

```
active     = slider gears not in off
candidates = 'era' in off ? all songs : songs where song.era ∈ eras
distance   = sum over g in active of |song[g] - value[g]|
order      = candidates sorted by distance ascending (stable sort on ties)
```

Off gears are skipped entirely; they add 0 to every song. With every gear off, all distances are 0, so the list shows the catalogue in its original order.

List rendering:
- Row height 58. List height = `visibleCount × 58`.
- Visible row `r` (0-based) sits at `top = r × 58`, opacity 1, rank label `r + 1`.
- Filtered-out rows fade to opacity 0 and park at `top = max(visibleCount - 1, 0) × 58`, so they fade in place instead of jumping.
- Rows animate `top 280ms ease, opacity 180ms ease`.
- Era on with no era picked: list is empty and shows "Pick an era to see songs." (17/500, `--text-2`, 24px vertical padding). Era off never shows this (§4a).

Default ranking, which can be used as a test fixture: I Want It That Way, Wannabe, Rolling in the Deep, Valerie, Since U Been Gone, Mr. Brightside, Shallow, Motion Sickness, Harvest Moon, I Will Always Love You.

Song data is the `SONGS` array in the reference file (25 mock songs, each with `title, artist, era, difficulty, history, popularity, tempo`). Replace it with real data; keep the same 0–100 scales.

**Row anatomy:** rank (20px, right-aligned) · title (18/22 bold, ellipsis) over "Artist · Era" (14/18, ellipsis) · 44×30 mini difficulty lane.

**Mini lane per song** (fixed, uses that song's difficulty `d`):
- `band = 6 + d × 0.22`; band top = `round(15 - band/2)`, height `round(band)`, 25% opacity.
- 3 dashes (3px tall): left 3/w10, left 16/w12, left 31/w10. Tops at offsets `0.7, -1, 0.2` via `round(15 + o × (band/2 - 1.5) - 1.5)`.
- Colour = `laneColor(d)`.

---

## 6. Gear art (reacts to values)

Each gear has an illustration in its strip and a smaller copy in its tab. Both copies update together. Copy the SVG geometry from the reference file exactly. When a gear is off, its art is drawn at the default value and dimmed (§4a).

- **`laneColor(v)`:** `< 34` → `#4FD17A`, `< 67` → `#F5B82E`, else `#FF6B70`.
- **Difficulty (pitch lane):** `bandH = 14 + difficulty × 0.62`. Band rect `y = round(40 - bandH/2)`, height `round(bandH)`, fill `laneColor`, 20% opacity. Seven dashes at offsets `[0.8, 0.2, -1, -0.3, 1, -0.6, -0.9]`, `y = round(40 + o × (bandH/2 - 3) - 3)`, fill `laneColor`.
- **Listening history (headphones + notes):** 7 notes. Note `i` is visible when `history ≥ (i + 0.5) × 100 / 7`. Opacity fades over 180ms. Notes in the strip copy bob 2px (1.1s, staggered delays).
- **Popularity (mic + bolts):** same as history: 7 bolts, threshold `(i + 0.5) × 100 / 7`. Bolts in the strip copy bob.
- **Tempo (metronome):** pendulum swings around (75, 62) in the SVG viewBox.
  - period = `60 / (50 + tempo × 1.5)` seconds per half-swing (`alternate`)
  - amplitude keyframe = `swing{20 - 2 × round(tempo/100 × 6)}` → ±20° (slow) down to ±8° (fast)
  - weight slides down the rod: `translate(0, round(16 + tempo × 0.27))`
- **Era tab:** 7 dots, `#FFD84D` if that era is picked, else `#4A1B0C`.

`prefers-reduced-motion: reduce` disables the pendulum, bob, row and rack animations.

---

## 7. Design tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#191714` | Screen; unselected era button |
| `--sheet` | `#211E1A` | Bottom sheet |
| `--panel` | `#2B2723` | Strip, era panel, unselected tab |
| `--line` | `#3A3631` | Sheet top border, slider track |
| `--row-line` | `#2C2925` | Row divider |
| `--text` | `#F7F3EA` | Primary text |
| `--text-2` | `#D9D3C4` | Labels, unselected button text |
| `--text-3` | `#B8B2A6` | Secondary text, rank, handle bar |
| `--cream` | `#F4E7C5` | Selected button/tab background, slider fill and thumb |
| `--ink` | `#191714` | Text on cream |
| `--lane-bg` | `#252047` | Difficulty lane background |
| `--red` | `#A8283D` | Art accent |
| `--yellow` | `#FFD84D` | Bolts, picked era dot |

**Type:** Barlow Semi Condensed 500/700 (Google Fonts), fallback `system-ui`.
- H1: 28/34, 700
- Row title: 18/22, 700
- Row sub: 14/18, 500
- Rank: 15, 700
- Eyebrow labels: 12/14, 700, +0.06em tracking, uppercase
- Slider end labels: 13/14, 700
- Tab and era labels: 12, 700

**Geometry:**
- Screen padding 20 top, 12 sides; gap 8.
- Sheet: top radius 16, padding 0 12 16, bleeds to screen edges.
- Strip radius 8, era panel radius 8, tab radius 6, era button radius 4.
- Slider: 4px track, 18×14 thumb with radius 4.

---

## 8. Accessibility (keep these)

- Each slider is a real `<input type="range">` with a `<label>`. In the reference it is invisible and laid over the custom track. Show a visible focus ring on the thumb for keyboard focus (the reference uses `:has(.slider-input:focus-visible)`).
- Reset buttons are real `<button>`s with an `aria-label` naming the gear. The button hides itself after use, so focus moves to that gear's slider (or the first era button) instead of being lost.
- An off slider announces `aria-valuetext="Off"`. The visual " · OFF" tag on slider labels is `aria-hidden` so the label isn't read twice.
- Era buttons and tabs are `<button>` with `aria-pressed`; selected styling is keyed off `aria-pressed`.
- Era grid and tab bar are `role="group"` with labels.
- Gear art is `aria-hidden`.
- Filtered-out rows get `aria-hidden="true"`.
- **Known gap in the reference:** rows stay in catalogue order in the DOM and are positioned absolutely, so a screen reader reads catalogue order, not rank order. Production should render rows in rank order, using a FLIP or layout animation to keep the motion.
- Touch targets are at least 44px (handle 140×44; sliders have an enlarged hit area).

---

## 9. Acceptance tests

The reference exposes `window.setlist` (`getState()`, `setState(patch)`, `ranking()`, `songs`) for testing. Remove it in production.

Useful selectors:
- `#app[data-mode="expanded"|"mini"]`, `#app[data-open]`, `#app.is-compact`
- `#handle`, `#rack`
- `.strip[data-gear]`, `#slider-{gear}`
- `.era-btn[data-era]`, `.tab[data-gear]`
- `.reset-btn[data-reset="difficulty"|"history"|"popularity"|"tempo"|"era"]`
- `.strip.is-off`, `#era-panel.is-off`, `.tab.is-off`, `.era-btn.is-parked`
- `.row[data-rank]`, `.row[aria-hidden="false"]` (visible rows), `#empty`

1. Default load: mode expanded, rack 416px, 4 strips + era panel visible, tabs hidden, ranking matches the §5 fixture.
2. `?mini=1`: mode mini, rack 164px, only the History strip and tabs are visible.
3. Tap handle in expanded → mini; tap again → expanded.
4. In mini, tap the Era tab → only the era panel and tabs are visible; `open = 'era'`.
5. Deselect all eras by hand → Era stays on, list is empty, "Pick an era to see songs." shows, Era's reset button is visible.
6. Only `s80` picked → ranking is Africa, Livin' on a Prayer, Don't Stop Believin', Bizarre Love Triangle.
7. Move any slider → value updates, `open` becomes that gear, list re-ranks.
8. From mini, drag handle up 80px → during the drag, layout is not compact and the rack grows; on release, mode is expanded.
9. From expanded, drag down 30px → stays expanded. Drag down 80px → mini.
10. A drag must not also toggle via the trailing click.
11. Rack content never overflows: `scrollHeight == clientHeight` for `#rack` in expanded, mini and mini-era.
12. Tempo 55 → pendulum animation `swing14`, 0.45s.
13. Default load shows 5 reset buttons.
14. Move Tempo to 90, then reset → `tempo = 45` (default), `off` contains `'tempo'`, strip has `.is-off`, hollow thumb at 45%, label shows "· OFF", reset button hidden, focus on `#slider-tempo`, `aria-valuetext="Off"`. Ranking equals the 3-slider distance (difficulty + history + popularity) over the picked eras.
15. Change the eras, then reset Era → `eras` equals the defaults, `off` contains `'era'`, all 25 songs show, the default picks have `.is-parked`, no button is `aria-pressed="true"`, label shows "· OFF".
16. With Tempo reset: ArrowRight → `tempo = 46` and on. Tapping the hollow thumb → `tempo = 45` and on. Tapping near the right end → on at that value.
17. With Era reset, tapping '80s → `eras = ['s90','s00','s10','s80']`, Era on.
18. Every gear reset → 25 songs in catalogue order (first: Can't Help Falling in Love), and every value equals its default.
19. Clicking the far right end of a slider track sets that slider (100), not reset.
20. In mini, resetting the open gear dims its tab (`.tab.is-off`).
21. Test 11 still holds with gears off: rack heights stay 416 / 164.

---

## 10. Out of scope / open questions

- The reset buttons and off state were added after Round 5. The Design canvas boards don't show them yet; this spec and the reference HTML are the source for them.
- There is no "reset all" control and no undo. A value set before a reset is not remembered; turning the gear back on starts from the default.
- Song scores are hand-assigned mock values. The real data source and scoring are not designed yet.
- No persistence: state resets on reload.
- Tapping a song row does nothing in this round.
- Fonts load from Google Fonts. Self-host for production if needed.

---

## 11. Build ticket: choose real defaults

The defaults in §2 are copied from the mockup and are not product decisions. The build ticket should:

1. **Pick a reasonable default for each gear** (Difficulty, Listening history, Popularity, Tempo, Era). Write down why each value was chosen. Options to weigh:
   - a fixed neutral value (e.g. 50)
   - a value derived from the user, e.g. History from their listening data, Era from their most-played decades
   - a different default for new users vs. returning users
2. **Decide whether each gear starts on or off.** The reference starts every gear on. If a default is only a starting point and not a real preference, starting off may rank better.
3. **Keep the defaults in one config** (like `DEFAULTS` in the reference), so reset and first load always agree.
4. **Update test fixtures** that depend on the defaults: the §5 default ranking and tests 1, 14–18.
