## What and why

## Test receipt

Quinn-Wai tests from this same list. Fill it in from the preview of the last commit, not from a local build.

- Commit SHA (the preview's, check it matches the PR head):
- Preview URL:
- `preview-e2e` result (link to the run; red or missing means not ready):
- Screenshots (link to the run's `preview-e2e-screenshots-*` artifact):
- Agents: `npm run e2e:preview -- <preview url>` passed locally on that URL (iPhone-webkit and desktop-chromium)

What `preview-e2e` covers: title screen, a saved range, the list, each slider and an era chip changing the top 5, the play button, a song page; signed out, touch WebKit and desktop Chromium.
What it does not: signed in, a real microphone, a real phone's audio, hover-free layout beyond these flows.
