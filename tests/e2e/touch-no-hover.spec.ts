// Quinn-Wai's review of #38 on an iPhone (QWW-57, R20): nothing depends on hover on a touch screen. A finger cannot hover, so whatever a mouse learns
// by pointing (the ▶ on a row, the range chart's note labels on the song page, the Spotify button's tooltip) has to be there without it.
//
// The check he asked for is a list: in a touch context, every hover-only reveal, and each one shown without hover. The list, as it stands:
//   - the ▶ on a row       rows.module.css, `@media (hover: hover)`: a mouse sees the rank number until the row is pointed at; touch always has the ▶ (R17)
//   - the range chart's    the song page's note labels were revealed by hovering the chart; they are drawn by default now (R25)
//     note labels
//   - the Spotify tooltip  the header's button: touch shows it with the first tap (R30, tests/e2e/setlist-header.spec.ts)
//   - the account menu     "Logged in as ... Log out": a tap on the logo opens it (SpotifyAccount.tsx); its hover rule is `@media (hover: hover)` only
//   - `title` tooltips     a native tooltip a finger never sees: each such control has its own name and glyph as well, so the title is a bonus
// The first test is the list made mechanical: no rule in any stylesheet that applies on a touch screen reveals anything on :hover, so a new one fails here.
// The rest show each reveal without hover, in a context that cannot hover (Chromium's touch emulation answers `(hover: none)` and `(pointer: coarse)`).

import { expect, test, type Page } from '@playwright/test';
import { ME, open } from '../helpers/tunerE2e';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, contextOptions: { reducedMotion: 'reduce' }, screenshot: 'off' });

/** What a rule has to set to hide or show something, rather than only recolour it. */
const REVEALING = ['opacity', 'visibility', 'display', 'transform', 'height', 'max-height', 'width', 'max-width', 'clip', 'clip-path', 'pointer-events', 'overflow', 'content'];

/** Every rule that applies on this screen, mentions :hover, and sets one of `REVEALING`: as `selector { properties }`. */
const hoverReveals = (page: Page) =>
  page.evaluate((revealing) => {
    const found: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          if (window.matchMedia(rule.media.mediaText).matches) walk(rule.cssRules);
        } else if (rule instanceof CSSSupportsRule) {
          if (CSS.supports(rule.conditionText)) walk(rule.cssRules);
        } else if (rule instanceof CSSStyleRule) {
          if (rule.selectorText.includes(':hover')) {
            const props = revealing.filter((p) => rule.style.getPropertyValue(p) !== '');
            if (props.length) found.push(`${rule.selectorText} { ${props.join(', ')} }`);
          }
          if (rule.cssRules.length) walk(rule.cssRules); // CSS nesting
        } else if ('cssRules' in rule) {
          walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
    return found;
  }, REVEALING);

test('R20. the context cannot hover, and no rule that applies to it shows or hides anything on :hover', async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => [matchMedia('(hover: none)').matches, matchMedia('(pointer: coarse)').matches]), 'a touch context').toEqual([true, true]);
  expect(await page.evaluate(() => document.styleSheets.length), 'the audit reads the page\'s stylesheets').toBeGreaterThan(0);
  expect(await hoverReveals(page)).toEqual([]);
});

test('R20. the same audit finds the rules that would break it (a mouse context has them, behind (hover: hover))', async ({ browser }) => {
  // The control for the test above: with a mouse the audit must see the media-gated reveals, or it would pass on an empty walk.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
  try {
    const page = await context.newPage();
    await open(page);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches), 'a mouse context').toBe(true);
    const found = await hoverReveals(page);
    expect(found.length, `a mouse sees the hover reveals:\n${found.join('\n')}`).toBeGreaterThan(0);
    // (CSS Modules prefix the class names, so the names are matched without the dot.)
    expect(found.join('\n')).toContain('accountMenu');
    expect(found.join('\n')).toContain('connectTip');
  } finally {
    await context.close();
  }
});

test('R20. the account menu opens with a tap and closes with a tap elsewhere', async ({ page }) => {
  await page.route('**/api/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }));
  await open(page, { loggedIn: true });
  const logo = page.locator('#app header').getByRole('button', { name: 'Spotify account', exact: true });
  const logOut = page.getByRole('button', { name: 'Log out' });
  await expect(logOut, 'closed: not drawn').toBeHidden();
  await logo.tap();
  await expect(logOut, 'one tap shows the box').toBeVisible();
  await expect(page.getByText(/Logged in as/)).toBeVisible();
  // Elsewhere: the header's bare middle, where the sign is (it is out of the way of every button, and the top bar takes the tap).
  const sign = (await page.locator('#app header [data-sign]').boundingBox())!;
  await page.touchscreen.tap(sign.x + sign.width / 2, sign.y + sign.height / 2);
  await expect(logOut, 'a tap elsewhere hides it').toBeHidden();
});

test('R20. a title is only ever a bonus: every control that has one names itself without it', async ({ page }) => {
  await open(page);
  const bare = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[title]'))
      .filter((el) => !(el instanceof SVGElement))
      .filter((el) => !el.getAttribute('aria-label') && !(el.textContent ?? '').trim())
      .map((el) => `${el.tagName.toLowerCase()}[title="${el.getAttribute('title')}"]`),
  );
  expect(bare, 'controls that a screen without hover would have no name for').toEqual([]);
});
