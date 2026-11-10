# Round 5 design: where production differs on purpose

`setlist-round5-spec.md` and `setlist-round5.html` are the design as it was handed over (QWW-46). They are kept as they
were. The screen is `src/components/setlist/`; this lists where it differs from them, and why.

| Spec or reference says | Production does | Why |
|---|---|---|
| §2: every gear starts on at its mock default (Difficulty 30, History 65, Popularity 80, Tempo 45; Era 90s, 00s, 10s) | Difficulty 0, Popularity 100 on; History 100, Tempo 50, Era off; Era has no default picks (`src/lib/setlist/defaults.ts`) | §11 asked for real defaults; QWW-47 decided them (model A, Quinn-Wai, 10 Nov). With no default picks the "parked" outline of §4a exists in the code but never shows, and a tap on an era while Era is off picks just that era |
| §5: the ranking is computed on the screen from the song's 0-100 scores | The screen sends its state to a ranking engine and draws the list that comes back (`SetlistEngine`, `src/lib/setlist/engine.ts`) | "The UI must not contain ranking math". The engine behind it is interim until QWW-47's server engine (`POST /api/setlist`) replaces it |
| §5: filtered-out rows stay in the DOM and fade in place | Rows are in rank order in the DOM; a row that leaves is removed, one that enters fades in, the rest slide (FLIP) | §8's known gap: a screen reader must read rank order. Leaving rows do not fade out yet |
| §10: tapping a row does nothing | Tapping a row opens the song page; the ▶ at the end of the row does not | The song page is part of the flow (QWW-42, Quinn-Wai's PR #4 review) |
| §1: a mock size of 390×844 | The screen fills the viewport (up to 480 px wide) with no frame and no footer label | The same review |
| §9: `window.setlist` is the test hook | It exists only in a build made with `NEXT_PUBLIC_SETLIST_TEST_HOOK=1` (the e2e build) | "Remove it from production" |
| Reference: the invisible `<input type="range">` spans the strip body | It also starts 9 px before the track and ends 9 px after, with an 18 px thumb | So the native thumb's centre travels exactly the drawn track: a tap lands on the value the thumb shows |
| §7: Barlow Semi Condensed from Google Fonts | Self-hosted from `@fontsource/barlow-semi-condensed` | §10 said to self-host for production |
| §6 writes the metronome weight as `translate(0, N)` | `translate(0 N)`, as the reference does | The same thing in SVG |

Acceptance tests: `tests/e2e/setlist.spec.ts` runs spec §9, tests 1 to 21, at 390×844. Where a test names a mock default,
it is rewritten for the real one; the header of that file says how.
