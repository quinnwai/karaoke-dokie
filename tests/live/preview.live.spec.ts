// @live: what Quinn-Wai does on a preview, run against the preview itself (QWW-93). No mocks, the deployment's own data, signed out,
// in an iPhone-shaped touch WebKit and in desktop Chromium. Read-only (tests/live/helpers.ts). Not covered: signed in (needs a real
// Spotify login, and a first sync writes the library to the database), a real microphone, a real phone's audio.
// Run: npm run e2e:preview -- <preview url>   (VERCEL_AUTOMATION_BYPASS_SECRET for a protected one)

import { expect, test } from '@playwright/test';
import { openSeeded, press, settledTop, shot, topTitles, wire } from './helpers';

/** Share of the first 20 rows whose ▶ is enabled (has a Deezer id); below this the deployment's song_deezer data is missing (QWW-48). */
const MIN_PLAYABLE = 0.9;

test.describe('@live signed out', () => {
  test('title screen, then Start leads to the microphone step', async ({ page, baseURL }, info) => {
    await wire(page, baseURL!);
    await page.goto('/');
    const start = page.getByRole('button', { name: 'Start' });
    await expect(start, 'the title screen').toBeVisible({ timeout: 45_000 });
    await shot(page, info, '01-title');
    await press(start, info.project.use.hasTouch === true);
    await expect(page.getByText('Find a quiet spot')).toBeVisible();
    await shot(page, info, '02-quiet-spot');
  });

  test('a saved range goes straight to a full, sensible list', async ({ page, baseURL }, info) => {
    await openSeeded(page, baseURL!);
    expect(await page.locator('[data-row]').count(), 'rows on screen').toBeGreaterThanOrEqual(10);
    const titles = await topTitles(page, 20);
    expect(new Set(titles).size, 'the top 20 are different songs').toBe(titles.length);
    for (const t of titles) expect(t, 'a song with a title').not.toMatch(/^\s*$|undefined|null|NaN/);
    await shot(page, info, '03-list');
  });

  test('each slider changes the top 5', async ({ page, baseURL }, info) => {
    await openSeeded(page, baseURL!);
    for (const gear of ['difficulty', 'popularity', 'tempo']) {
      const slider = page.locator(`#slider-${gear}`);
      await expect(slider, `the ${gear} slider is on the screen`).toBeAttached();
      await slider.focus();
      await page.keyboard.press('Home');
      const low = await settledTop(page);
      await page.keyboard.press('End');
      const high = await settledTop(page);
      expect(low.length, `${gear}: a list at the low end`).toBe(5);
      expect(high.length, `${gear}: a list at the high end`).toBe(5);
      expect(high.join('|'), `${gear} slider: the top 5 at 0 and at 100 are the same, the slider does nothing`).not.toBe(low.join('|'));
      await shot(page, info, `04-slider-${gear}`);
    }
  });

  test('an era chip changes the top 5', async ({ page, baseURL }, info) => {
    await openSeeded(page, baseURL!);
    const before = await settledTop(page);
    const chips = page.locator('button[data-era]');
    expect(await chips.count(), 'era chips').toBeGreaterThan(0);
    const touch = info.project.use.hasTouch === true;
    let changed = false;
    // An era may hold none of this range's top songs; the first that moves the list is enough, and none moving is the failure.
    for (let i = 0; i < Math.min(await chips.count(), 6) && !changed; i++) {
      const chip = chips.nth(i);
      await chip.scrollIntoViewIfNeeded();
      await press(chip, touch);
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      changed = (await settledTop(page)).join('|') !== before.join('|');
      if (!changed) await press(chip, touch); // off again
    }
    expect(changed, 'no era chip changed the top 5').toBe(true);
    await shot(page, info, '05-era');
  });

  test('the play button plays, and most of the list is playable', async ({ page, baseURL }, info) => {
    await openSeeded(page, baseURL!);
    const buttons = page.locator('[data-row] [data-play-slot] button');
    const first20 = Math.min(20, await buttons.count());
    let playable = 0;
    for (let i = 0; i < first20; i++) if (await buttons.nth(i).isEnabled()) playable++;
    expect(playable / first20, `${playable} of the first ${first20} rows have a working play button (want ${MIN_PLAYABLE * 100}%)`).toBeGreaterThanOrEqual(MIN_PLAYABLE);
    const play = page.locator('[data-row] [data-play-slot] button:enabled').first();
    await expect(play).toHaveAttribute('aria-label', /^Play /);
    await press(play, info.project.use.hasTouch === true);
    await expect(play, 'tapping ▶ starts the preview (the label turns to Pause)').toHaveAttribute('aria-label', /^Pause /, { timeout: 30_000 });
    await shot(page, info, '06-playing');
  });

  test('a song page renders, and back returns to the list', async ({ page, baseURL }, info) => {
    await openSeeded(page, baseURL!);
    const touch = info.project.use.hasTouch === true;
    const row = page.locator('[data-row]').first();
    const title = ((await row.locator('[data-row-title]').textContent()) ?? '').trim();
    await press(row.locator(':scope > button'), touch);
    await expect(page.getByRole('heading', { level: 2, name: title }), 'the song page names the song').toBeVisible();
    await expect(page.getByRole('img', { name: /Song goes from .* You sing from /i }), 'the range chart').toBeVisible();
    await shot(page, info, '07-song');
    await press(page.getByRole('button', { name: 'Back to songs' }), touch);
    await expect(page.locator('[data-row]').first()).toBeVisible();
  });
});
