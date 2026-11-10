# Testing and acceptance

## What runs today

| Layer | Command | Data | Catches |
|---|---|---|---|
| Types | `npm run typecheck` | none | wrong shapes between server, store and screen |
| Unit and integration | `npx -y node@22 node_modules/vitest/vitest.mjs run` (see the count it prints) | fixtures and an in-memory store | ranking, slider order, store contract, routes, scripts' pure logic |
| Browser | `E2E_PORT=<port> npx playwright test` (mocked API and mock Spotify). It starts two servers from one build: the main one with duets and moods on, and a second with them off, as they ship (QWW-43), on `E2E_OFF_PORT` (default `E2E_PORT` + 1). Parallel checkouts set both | fixtures | layout at 375 px, flows, slider reordering on a fixture list, and that switching duets and moods off changes nothing but their words |
| Live-data smoke | `npm run smoke:live` (database) or `npm run smoke:live -- --url <deployment>` | the real preview or production data | a deployment reading a database without the data: no Pick row, sliders that change nothing, unknown songs first, play buttons with no Deezer id; with `--url`, also that 90% of the first 20 songs play a preview through the deployment and Deezer |
| Reports | `npm run tempo:report`, `report:coverage`, `report:facets` | saved data | coverage and accuracy numbers |

Fixture tests cannot see a wrong database. The live-data smoke test exists because a preview once read
production's database, which had none of the after-merge data (QWW-40): every unit and browser test
passed while the screen had no Pick row and two dead sliders.

## Acceptance for a change that touches results

A change is not ready for review until all of these are in the PR, with the output pasted:

1. `npm run typecheck`, unit tests on Node 22 and `npx playwright test` pass.
2. `npm run smoke:live -- --url <the preview deployment>` passes. That checks what the deployment really
   reads; `npm run smoke:live` alone checks only the `DATABASE_URL` in your shell, which proves nothing
   about the deployment. A protected preview needs `VERCEL_BYPASS_TOKEN`. If you cannot reach the
   preview, say so in the PR; do not substitute the database mode.
3. **Looked at the running deployment, logged out and logged in where possible**, at 375 px: every control
   present, each slider moved to both ends changes the list, the first 20 songs are ones a person knows.
   Flag what cannot be tested (for example Spotify while locked out) instead of skipping the rest.
4. **Adversarial review** by a separate agent that did not write the change, told to break it (empty
   data, wrong database, old clients, rate limits), findings fixed or answered in the PR.
5. **Personal review**: the PR names what Quinn-Wai should click through and what to expect.

After a merge that changes which data the screen needs, run the after-merge data steps on the database
the preview reads before asking for review.
