// Quinn-Wai's review of the whole build (QWW-57, R36, 12 Nov: "when all are disabled, go back to default ordering with history, popularity and difficulty"):
//   R36  History's ✕ turns History off (decision A, R21 stands). With all of Difficulty, Popularity, Tempo, History and Era off, the list is not left to
//        the ties: it ranks as the defaults do (signed in: listening history first, then popularity, then the easiest; logged out: popularity, then the
//        easiest, leaning low). The gears stay shown as off.
// tests/songs/setlist.test.ts has the ranking itself; here is the whole screen on the server's own ranking behind the mocked API (tests/helpers/setlistServer.ts).
// What the engine answered is read from the responses, not only from the screen, so a list that has not been redrawn yet cannot pass for the answer.
// The tuner is reached as the other tuner specs reach it (tests/helpers/tunerE2e.ts).

import { expect, test, type Page } from '@playwright/test';
import type { SetlistRequest, SetlistResponse } from '../../src/lib/contracts';
import type { GearId } from '../../src/lib/setlist/types';
import { DEFAULT_RANKING, open, resetButton, rows, strip, titles, tuner } from '../helpers/tunerE2e';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

const hook = (page: Page, patch: object) => page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);
const GEARS: GearId[] = ['difficulty', 'popularity', 'tempo', 'history'];

interface Answer {
  /** The parts the request turned off. */
  off: string[];
  /** The titles the engine answered, in its order. */
  titles: string[];
  /** The parts that counted. */
  applied: string[];
}

/** Every answer the engine gives the page, in order, as it arrives. */
function recordAnswers(page: Page): Answer[] {
  const answers: Answer[] = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/api/setlist') return;
    const req = r.request().postDataJSON() as SetlistRequest;
    const body = (await r.json()) as SetlistResponse;
    answers.push({ off: [...req.off], titles: body.songs.map((s) => s.match.track.title), applied: [...body.applied] });
  });
  return answers;
}

const sameParts = (a: string[], b: string[]) => a.length === b.length && b.every((part) => a.includes(part));

/** The newest answer to a request with exactly these parts off (waits for it). */
async function answerOff(answers: Answer[], off: string[]): Promise<Answer> {
  await expect.poll(() => answers.some((a) => sameParts(a.off, off)), { message: `an answer to a request with ${off.join(', ')} off` }).toBe(true);
  return answers.filter((a) => sameParts(a.off, off)).at(-1)!;
}

const ALL = ['difficulty', 'popularity', 'tempo', 'history', 'era'];

test('R36. logged out, with every gear off the list is the default list, in the default order, and the gears are shown off', async ({ page }) => {
  const answers = recordAnswers(page);
  await open(page);
  const defaults = await titles(page);
  expect(defaults.length).toBeGreaterThanOrEqual(25);
  expect(defaults.slice(0, DEFAULT_RANKING.length), 'the default list, as the other specs know it').toEqual(DEFAULT_RANKING);
  // Difficulty and Popularity are the two that start on: their ✕ turns them off; Tempo and Era were off, and History cannot be used signed out.
  await resetButton(page, 'difficulty').click();
  await resetButton(page, 'popularity').click();
  for (const gear of GEARS) await expect(strip(page, gear), gear).toHaveAttribute('data-off', 'true');
  await expect(page.locator('#era-panel')).toHaveAttribute('data-off', 'true');
  expect((await tuner(page)).off.slice().sort()).toEqual(['difficulty', 'era', 'history', 'popularity', 'tempo']);
  // What the engine answered to "nothing is on" is the default answer, in the default order, and says that nothing counted.
  const allOff = await answerOff(answers, ALL);
  expect(allOff.titles).toEqual(defaults);
  expect(allOff.applied).toEqual([]);
  // And that is what the screen shows.
  await expect.poll(() => titles(page)).toEqual(defaults);
  await expect(rows(page).first()).toBeVisible();
});

test('R36. signed in, with every gear off the list is the signed-in default list: History first, then popularity, then the easiest', async ({ page }) => {
  const answers = recordAnswers(page);
  await open(page, { loggedIn: true });
  const defaults = await titles(page);
  expect(defaults.length).toBeGreaterThanOrEqual(25);
  // History starts on when signed in (R31); its ✕ is "Turn off", like every gear's (R21), so every gear can be turned off.
  for (const gear of ['difficulty', 'popularity', 'history'] as const) await resetButton(page, gear).click();
  for (const gear of GEARS) await expect(strip(page, gear), gear).toHaveAttribute('data-off', 'true');
  expect((await tuner(page)).off.slice().sort()).toEqual(['difficulty', 'era', 'history', 'popularity', 'tempo']);
  const allOff = await answerOff(answers, ALL);
  expect(allOff.titles).toEqual(defaults);
  expect(allOff.applied).toEqual([]);
  await expect.poll(() => titles(page)).toEqual(defaults);
});

test('R36. the default order is only for when nothing is on: one gear on still ranks by that gear, and turning it off again goes back', async ({ page }) => {
  const answers = recordAnswers(page);
  await open(page);
  const defaults = await titles(page);
  // Tempo alone, at the fast end: the list follows it and is not the default order.
  const withTempo = ['difficulty', 'popularity', 'history', 'era'];
  await hook(page, { tempo: 100, off: withTempo });
  const tempoOnly = await answerOff(answers, withTempo);
  expect(tempoOnly.applied).toEqual(['tempo']);
  expect(tempoOnly.titles).not.toEqual(defaults);
  // Off again: nothing counts, and it is the default order.
  await hook(page, { off: ALL });
  const allOff = await answerOff(answers, ALL);
  expect(allOff.titles).toEqual(defaults);
  await expect.poll(() => titles(page)).toEqual(defaults);
});
