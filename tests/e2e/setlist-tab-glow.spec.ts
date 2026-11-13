// QWW-57, adversarial review of PR #38, finding 3 (R7: unlit rays glow). The glow around the History and Popularity tab icons reaches only
// what is lit. It used to be `drop-shadow(0 0 3px <gear colour>)` on the whole tab svg, so the unlit #34313D rays glowed in the gear's
// colour as well. Now one SVG filter sits on a group of the body and the lit rays (src/components/setlist/GearArt.tsx, RayTab). In a real
// browser, with the tab bar in mini:
//   1. no filter is on an unlit ray, on anything above it, or on the svg; every lit ray, and the body, is inside one filtered group
//      whose filter exists
//   2. a gear that is off has no filter anywhere in its tab
//   3. each of the five tabs still glows 3 px in its gear's colour
//   4. the glow of the lit parts is the CSS drop-shadow it replaces, pixel for pixel: a stand-in is built in the page (the lit parts under
//      a CSS drop-shadow on an svg root, the unlit rays on top, unfiltered) and compared at 3x with a copy of the real icon
// The tuner is reached the way tests/e2e/setlist-sheet.spec.ts reaches it (tests/helpers/tunerE2e.ts).

import { expect, test, type Locator, type Page } from '@playwright/test';
import { handle, open, resetButton, rgb, slider, strip, tab, tabArt } from '../helpers/tunerE2e';

// A 390x844 phone at 3x, as the sheet spec has it. Motion is off, so a colour is read where it ends.
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, contextOptions: { reducedMotion: 'reduce' } });

const HEX = { cyan: '#4FDDE8', amber: '#FFC24A', pink: '#FF4FA0', violet: '#B583FF', easy: '#4DE89A' } as const;

// ---- a way in, and small readers ----

/** `open`, and for a signed-in singer until History's slider is enabled (before that it is drawn disabled, and a patch would be for nothing). */
async function openTuner(page: Page, opts: { loggedIn?: boolean } = {}) {
  await open(page, opts);
  if (opts.loggedIn) await expect(slider(page, 'history')).toBeEnabled();
}

const setState = (page: Page, patch: object) =>
  page.evaluate((p) => (window as unknown as { setlist: { setState(p: object): void } }).setlist.setState(p), patch);

async function toMini(page: Page) {
  await handle(page).click();
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'mini');
}

/** An element that carries a filter, by its `filter` attribute or in its computed style. */
interface Carrier {
  tag: string;
  attribute: string | null;
  computed: string;
}

interface TabReport {
  /** Each ray, in document order: its lit mark, what carries a filter from it up to and including the svg, and whether the group
   *  above it names a `<filter>` that is in this svg and is the only element in the page with that id. */
  rays: Array<{ lit: string | null; carriers: Carrier[]; named: boolean }>;
  /** Each part that is not a ray (the headphones or the mic): is it inside a filtered group? */
  parts: boolean[];
  /** Everything in the tab that carries a filter, the svg included. */
  carriers: Carrier[];
  /** How many `<filter>` elements the tab draws. */
  filterElements: number;
}

const report = (svg: Locator): Promise<TabReport> =>
  svg.evaluate((el) => {
    const root = el as SVGSVGElement;
    const carrier = (e: Element): Carrier => ({ tag: e.localName, attribute: e.getAttribute('filter'), computed: getComputedStyle(e).filter });
    const carries = (c: Carrier) => c.attribute !== null || c.computed !== 'none';
    const upToRoot = (e: Element) => {
      const chain: Element[] = [];
      for (let at: Element | null = e; at; at = at.parentElement) {
        chain.push(at);
        if (at === root) break;
      }
      return chain;
    };
    const filteredGroup = (e: Element) => upToRoot(e).find((at) => at.localName === 'g' && at.hasAttribute('filter'));
    return {
      rays: [...root.querySelectorAll('[data-ray]')].map((ray) => {
        const id = /^url\(#(.+)\)$/.exec(filteredGroup(ray)?.getAttribute('filter') ?? '')?.[1];
        const withId = id === undefined ? [] : [...document.querySelectorAll('[id]')].filter((e) => e.id === id);
        const [target] = withId;
        return {
          lit: ray.getAttribute('data-lit'),
          carriers: upToRoot(ray).map(carrier).filter(carries),
          named: withId.length === 1 && target?.localName === 'filter' && root.contains(target),
        };
      }),
      parts: [...root.querySelectorAll('path, circle, rect')].filter((e) => !e.hasAttribute('data-ray')).map((e) => filteredGroup(e) !== undefined),
      carriers: [root, ...root.querySelectorAll('*')].map(carrier).filter(carries),
      filterElements: root.querySelectorAll('filter').length,
    };
  });

/** Waits until the tab's rays show `lit`, then reports (a patch of the tuner draws a moment later). */
async function reportWhen(svg: Locator, lit: boolean[]): Promise<TabReport> {
  await expect.poll(async () => (await report(svg)).rays.map((ray) => ray.lit)).toEqual(lit.map(String));
  return report(svg);
}

/** The finding's check: no filter on an unlit ray or above it; each lit ray in one filtered group, which names a filter that exists. */
function expectGlowOnlyWhereLit(r: TabReport, lit: boolean[]) {
  expect(r.rays).toHaveLength(7);
  r.rays.forEach((ray, i) => {
    if (lit[i]) {
      expect(ray.carriers.map((c) => c.tag), `lit ray ${i}`).toEqual(['g']);
      expect(ray.named, `lit ray ${i}`).toBe(true);
    } else {
      expect(ray.carriers, `unlit ray ${i}`).toEqual([]);
    }
  });
  // The body is lit while the gear is on, so it is in the group too, and the group is the only thing in the tab that carries a filter.
  expect(r.parts).toEqual([true, true, true]);
  expect(r.carriers.map((c) => c.tag)).toEqual(['g']);
  expect(r.filterElements).toBe(1);
}

// ============================================================================================================
// 1. The glow does not reach an unlit ray
// ============================================================================================================

test('R7. Popularity on at 30, signed out: no filter reaches its 5 unlit tab rays, and its 2 lit rays and the mic are in the one filtered group', async ({ page }) => {
  await open(page);
  await setState(page, { popularity: 30 });
  await toMini(page);
  const lit = [true, true, false, false, false, false, false];
  expectGlowOnlyWhereLit(await reportWhen(tabArt(page, 'popularity'), lit), lit);
});

test('R7. History on at 65, signed in: no filter reaches its 2 unlit tab rays, and its 5 lit rays and the headphones are in the one filtered group', async ({ page }) => {
  await openTuner(page, { loggedIn: true });
  await setState(page, { history: 65, off: ['tempo', 'era'] });
  await toMini(page);
  const lit = [true, true, true, true, true, false, false];
  expectGlowOnlyWhereLit(await reportWhen(tabArt(page, 'history'), lit), lit);
});

test('R7. a ray moves in and out of the filtered group as the value crosses its threshold, and the rays stay in order', async ({ page }) => {
  await open(page);
  await toMini(page);
  const svg = tabArt(page, 'popularity');
  // Popularity starts at 100: all seven lit. Each step below lights or darkens rays; the check holds at every one of them.
  for (const [value, litCount] of [[100, 7], [60, 4], [30, 2], [0, 0], [14, 1], [100, 7]] as const) {
    await setState(page, { popularity: value });
    const lit = Array.from({ length: 7 }, (_, i) => i < litCount);
    const r = await reportWhen(svg, lit);
    expectGlowOnlyWhereLit(r, lit);
  }
});

// ============================================================================================================
// 2. A gear that is off has no filter at all
// ============================================================================================================

test('R7. a gear that is off has no filter anywhere in its tab: History signed out, Popularity once reset, Tempo and Era', async ({ page }) => {
  await open(page);
  // As first load leaves them, signed out: Difficulty and Popularity on; History (disabled), Tempo and Era off.
  await resetButton(page, 'popularity').click();
  await expect(strip(page, 'popularity')).toHaveAttribute('data-off', 'true');
  await toMini(page);
  for (const gear of ['history', 'popularity', 'tempo', 'era'] as const) {
    await expect(tab(page, gear), gear).toHaveAttribute('data-off', 'true');
    const r = await report(tabArt(page, gear));
    expect(r.carriers, gear).toEqual([]);
    expect(r.filterElements, gear).toBe(0);
    // Every ray of the two that have them is unlit, and none of them carries a filter on itself or above it.
    for (const ray of r.rays) expect(ray, gear).toEqual({ lit: 'false', carriers: [], named: false });
  }
  // Difficulty is on, and its glow is a CSS filter on the svg: the checks above are not true of every tab.
  expect((await report(tabArt(page, 'difficulty'))).carriers.map((c) => c.tag)).toEqual(['svg']);
});

// ============================================================================================================
// 3. Each lit tab still glows 3 px in its gear's colour
// ============================================================================================================

/**
 * A tab's glow as the browser draws it: the colour and the blur in screen px. Difficulty, Tempo and Era have a CSS drop-shadow on the
 * svg; History and Popularity have an SVG filter on the lit group, whose blur counts in grid units, so it is scaled by the px a unit takes.
 */
const glowOf = (svg: Locator) =>
  svg.evaluate((el) => {
    const root = el as SVGSVGElement;
    const css = /^drop-shadow\((rgb\([^)]*\)) 0px 0px (\d+(?:\.\d+)?)px\)$/.exec(getComputedStyle(root).filter);
    if (css) return { colour: css[1], blur: Number(css[2]) };
    const id = /^url\(#(.+)\)$/.exec(root.querySelector('g[filter]')?.getAttribute('filter') ?? '')?.[1];
    const filter = [...root.querySelectorAll('filter')].find((f) => f.id === id);
    const flood = filter?.querySelector('feFlood');
    const blur = filter?.querySelector('feGaussianBlur');
    if (!flood || !blur) return null;
    const pxPerUnit = root.getBoundingClientRect().width / root.viewBox.baseVal.width;
    return { colour: getComputedStyle(flood).floodColor, blur: Number(blur.getAttribute('stdDeviation')) * pxPerUnit };
  });

test('R7. with every gear on, each of the five tabs glows 3 px in its gear colour: Difficulty by its tier, History cyan, Popularity amber, Tempo violet, Era pink', async ({ page }) => {
  await openTuner(page, { loggedIn: true });
  await setState(page, { difficulty: 20, history: 65, popularity: 30, tempo: 50, eras: ['s90'], off: [] });
  await toMini(page);
  const want = {
    difficulty: rgb(HEX.easy),
    history: rgb(HEX.cyan),
    popularity: rgb(HEX.amber),
    tempo: rgb(HEX.violet),
    era: rgb(HEX.pink),
  } as const;
  for (const gear of ['difficulty', 'history', 'popularity', 'tempo', 'era'] as const) {
    await expect.poll(async () => (await glowOf(tabArt(page, gear)))?.colour, { message: gear }).toBe(want[gear]);
    // 3 px of blur, to the thousandth: the SVG filter's is the CSS one's converted by the icon's scale.
    expect((await glowOf(tabArt(page, gear)))?.blur, gear).toBeCloseTo(3, 3);
  }
});

// ============================================================================================================
// 4. The glow of the lit parts looks as it did
// ============================================================================================================

/** The largest difference in any colour channel between two PNGs of one size, the pixels that differ by more than 8 of 255, and the mean. */
const compare = (page: Page, a: Buffer, b: Buffer) =>
  page.evaluate(
    async ([x, y]) => {
      const pixels = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const ctx = new OffscreenCanvas(image.width, image.height).getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, image.width, image.height);
      };
      const [p, q] = await Promise.all([pixels(x ?? ''), pixels(y ?? '')]);
      if (p.width !== q.width || p.height !== q.height) throw new Error('the two screenshots are not the same size');
      let max = 0;
      let over8 = 0;
      let sum = 0;
      for (let i = 0; i < p.data.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs((p.data[i + c] ?? 0) - (q.data[i + c] ?? 0)));
        max = Math.max(max, d);
        if (d > 8) over8++;
        sum += d;
      }
      return { size: `${p.width}x${p.height}`, max, over8, mean: sum / (p.width * p.height) };
    },
    [a.toString('base64'), b.toString('base64')],
  );

/**
 * Draws, in a lab on top of the page, a copy of the tab icon as it is and a stand-in for what it should look like: the lit parts (the body
 * and the lit rays) under the CSS `drop-shadow(0 0 3px <gear colour>)` that the whole svg used to carry, and the unlit rays above it,
 * unfiltered. Both sit on the tab's own colours at whole pixels. Returns how far apart their screenshots are.
 */
async function glowDifference(page: Page, gear: 'history' | 'popularity', glow: string) {
  await page.evaluate(
    ({ gear, glow }) => {
      const real = document.querySelector(`[data-tab][data-gear="${gear}"] svg`);
      if (!(real instanceof SVGSVGElement)) throw new Error('no tab icon');
      const clone = () => real.cloneNode(true) as SVGSVGElement;
      /** A copy with no filter of its own: no defs, no filter attribute, no filter in its style. */
      const bare = () => {
        const svg = clone();
        svg.querySelectorAll('defs').forEach((defs) => defs.remove());
        svg.querySelectorAll('[filter]').forEach((el) => el.removeAttribute('filter'));
        svg.style.filter = 'none';
        return svg;
      };
      const lab = document.createElement('div');
      lab.id = 'glow-lab';
      lab.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;display:flex;gap:6px;padding:6px;background:#0F0E14';
      const cell = (name: string, layers: SVGSVGElement[]) => {
        const box = document.createElement('div');
        box.className = name;
        box.style.cssText = 'position:relative;width:60px;height:50px;border-radius:8px;background:#17161C';
        for (const layer of layers) {
          Object.assign(layer.style, { position: 'absolute', left: '13px', top: '11px' });
          box.append(layer);
        }
        lab.append(box);
      };

      // The icon as it is, with its filter given an id of its own, since the real one is still in the page.
      const same = clone();
      const filter = same.querySelector('filter');
      const group = same.querySelector('g[filter]');
      if (filter && group) {
        filter.id = 'glow-lab-filter';
        group.setAttribute('filter', 'url(#glow-lab-filter)');
      }
      cell('real', [same]);

      const lit = bare();
      lit.querySelectorAll('[data-ray][data-lit="false"]').forEach((ray) => ray.remove());
      lit.style.filter = `drop-shadow(0 0 3px ${glow})`;
      const unlit = bare();
      unlit.querySelectorAll('[data-ray][data-lit="true"], g[stroke], g[transform]').forEach((el) => el.remove());
      cell('stand-in', [lit, unlit]);
      document.body.append(lab);
    },
    { gear, glow },
  );
  const lab = page.locator('#glow-lab');
  const real = await lab.locator('.real').screenshot();
  const standIn = await lab.locator('.stand-in').screenshot();
  await lab.evaluate((el) => el.remove());
  return compare(page, real, standIn);
}

// What counts as the same look, on a 180x150 px cell (27 000 px). Measured in Chromium, the same on every run: where the unlit rays are
// the only difference the SVG filter and the CSS drop-shadow agree to within 1 of 255 (Popularity at 0 and 30 to the pixel, History at 65
// in 2 pixels); with every ray lit, a thin row of edge pixels on the horizontal rays differs (30 pixels, by up to 51, a mean of 0.09). A
// glow around an unlit ray, which is what this replaces, is out in 1000 pixels or more and by a mean of 0.8 or more; one of the wrong size
// or colour in thousands of pixels. The numbers of each run are attached to the test.
const SAME = { over8: 100, mean: 0.2 };

async function expectSameLook(d: Awaited<ReturnType<typeof compare>>, when: string) {
  await test.info().attach(`glow difference, ${when}`, { body: JSON.stringify(d), contentType: 'application/json' });
  expect(d.over8, `${when}: pixels that differ by more than 8 (of ${d.size}; the largest difference is ${d.max})`).toBeLessThanOrEqual(SAME.over8);
  expect(d.mean, `${when}: the mean difference`).toBeLessThanOrEqual(SAME.mean);
}

test('R7. the glow of the lit parts is the 3 px drop-shadow it replaces, in the gear colour: Popularity at 0, 30 and 100', async ({ page }) => {
  await open(page);
  await toMini(page);
  for (const [value, litCount] of [[0, 0], [30, 2], [100, 7]] as const) {
    await setState(page, { popularity: value });
    await reportWhen(tabArt(page, 'popularity'), Array.from({ length: 7 }, (_, i) => i < litCount));
    await expectSameLook(await glowDifference(page, 'popularity', HEX.amber), `Popularity at ${value}`);
  }
});

test('R7. the glow of the lit parts is the 3 px drop-shadow it replaces, in the gear colour: History at 0, 65 and 100, signed in', async ({ page }) => {
  await openTuner(page, { loggedIn: true });
  await toMini(page);
  for (const [value, litCount] of [[65, 5], [0, 0], [100, 7]] as const) {
    await setState(page, { history: value, off: ['tempo', 'era'] });
    await reportWhen(tabArt(page, 'history'), Array.from({ length: 7 }, (_, i) => i < litCount));
    await expectSameLook(await glowDifference(page, 'history', HEX.cyan), `History at ${value}`);
  }
});
