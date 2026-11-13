# Cloud brief: QWW-72, Tempo gear becomes Mood (Round 7 reskin)

You are working in `quinnwai/karaoke-dokie` (Next.js, TypeScript). Start from branch `design/setlist-round7-mood`. It is `main` plus this folder. Create your own working branch from it and open one PR against `main`. Do not merge it.

## Goal

The Setlist tuner's **Tempo** gear is shown to users as **Mood** (Slow jams to Party bops), with a neon speaker in place of the metronome. This change is front end only. The ranking, the data, the defaults and the gear's 0 to 100 `tempo` value stay as they are.

## Sources, in order of authority

1. **This brief**, including the decisions below.
2. `docs/setlist-round7/setlist-round7-README.md`, the spec. Its §2 to §6 are the work.
3. `docs/setlist-round7/setlist-round7-mood.html`, the reference markup and geometry. Open it in a browser; `?mini=1` starts in mini mode.

The README was written against the Round 6A design (`docs/setlist-round6a/`). Production has moved on since then (QWW-57 review rounds; see `docs/screen.md`). Where the README's "Round 6A" column doesn't match `main`, trust `main` as the starting point and this brief as the target.

## Decisions (Quinn-Wai, 13 Nov)

| Where | `main` today | Target |
|---|---|---|
| Strip label (`eyebrow`) | TEMPO | MOOD |
| Tab label | Tempo | Mood |
| End labels | Slow jams / Fast tracks | Slow jams / **Party bops** |
| Off button `resetLabel` (screen reader) | Turn off tempo | **Turn off mood** (keep the "Turn off X" pattern, not the README's "Reset mood to default...") |
| Off tag | TEMPO · OFF | MOOD · OFF |
| Fallback reason tag, `src/lib/setlist/rows.ts` rule 4 | `>= 70` For the party people / `<= 25` Slow burn / Solid pick | `>= 67` **Party bop** / `< 34` **Slow jam** / **Feel-good** (README §2) |
| Strip and tab art | Metronome | Speaker (README §4, §5) |

A song with no tempo value still gets the middle tag, "Feel-good".

## Where things are

- Copy: `src/lib/setlist/gears.ts` (`GEAR_META.tempo`), `src/lib/songs/browse.ts` (the `tempo` end labels), and the comment in `src/lib/contracts.ts`.
- Reason line: `src/lib/setlist/rows.ts` around line 80.
- Art: `src/components/setlist/GearArt.tsx`, `GearArt.module.css`, `src/lib/setlist/art.ts`, `src/components/setlist/setlist-global.css` (keyframes, reduced motion).
- Label width: `src/components/setlist/sheet.module.css` around line 350, and its check in `tests/setlist/tuner.test.ts`. "Party bops" is a new width, so measure it the way that comment describes.
- Tests: `tests/setlist/*` (`art.test.ts`, `gearArt.test.tsx`, `rows.test.ts`) and `tests/e2e/setlist-*.spec.ts`.

## Rules

- **Keep `tempo` everywhere internal:** state key, gear id, `#slider-tempo`, `data-gear="tempo"`, `data-reset="tempo"`, `window.setlist` test hook fields, API fields. Only text users see or hear changes.
- **Don't touch the QWW-11 mood chips** (`MOODS_SHIPPED`, `DUETS_AND_MOODS`, `src/lib/server/features.ts`). They are a different feature that happens to share the word.
- Remove the metronome's art, its bpm and weight maths, the `swing*` keyframes and `.pend`. The reduced-motion rule lists `.thump` (README §6). Delete what this change leaves unused; leave unrelated code alone.
- Adapt the README §8 test list to this repo's tests. Its numbers refer to the design team's harness, not to files here. Update tests that checked the old copy or the metronome; don't delete them to get green.
- Add `tempo-dashboard.html` to `.gitignore` (the output of `npm run tempo:dashboard`; the script stays).
- No database, secrets or network services are needed. Unit and e2e tests run on the in-memory store with a mocked Spotify (`playwright.config.ts`).

## Verify before opening the PR

```
npm ci
npm run typecheck
npm test
npx playwright install --with-deps chromium
npm run test:e2e
```

Then check by hand:

- `grep -rni "tempo"` over the rendered copy (`src/lib/setlist/gears.ts`, `src/lib/songs/browse.ts`, `src/lib/setlist/rows.ts`, components) finds no user-visible string or `aria-label`.
- At values 20, 50 and 80, the strip and the tab both show 1, 2 and 3 waves per side, and the thump is `thump4`, `thump8` and `thump12`. At 80 the duration is 0.52 s and the tab cone is `r = 2.18`.
- Off: strokes `#34313D`, no animation, drawn at 45 (2 waves per side).

If a test failed on `main` before your change, say so in the PR. Don't fix it in this PR.

## Deliver

One PR against `main`, titled `QWW-72: Tempo gear becomes Mood (Round 7 reskin)`. The description should give:

- the checklist above, ticked;
- the typecheck, unit and e2e results;
- screenshots of the strip and the tab at 20, 50 and 80, plus the off state, at a phone width (390 px);
- any place where you departed from the README or this brief, and why.

Do not merge.
