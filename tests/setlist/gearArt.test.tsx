// @vitest-environment jsdom
// The gear art against the reference (spec §6). docs/setlist-round5/setlist-round5.html is parsed without running its
// script, so it is the markup as authored. Each component is rendered to static markup and parsed the same way, and the
// two trees are walked together: at every position the tag and every attribute must be identical, except
//   - `class`, which CSS Modules renames, so the class names are compared instead;
//   - the parts that follow the art value. The reference's script draws those, so the reference has them blank here.
//     The walk leaves them out (and requires the component to set them), and they are asserted on their own below, with
//     the values the reference's own render() draws (its script was run once in jsdom to get them).
// Both trees are parsed with jsdom's DOMParser, the engine this test already runs on; `new JSDOM` would need @types/jsdom.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EraIcon, EraTabArt, GearArt, type GearArtVariant } from '../../src/components/setlist/GearArt';
import { metronome } from '../../src/lib/setlist/art';
import { ERA_IDS, GEAR_IDS, type EraId, type GearId } from '../../src/lib/setlist/types';

const REFERENCE = join(__dirname, '../../docs/setlist-round5/setlist-round5.html');
const MODULE_CSS = join(__dirname, '../../src/components/setlist/GearArt.module.css');
const GLOBAL_CSS = join(__dirname, '../../src/components/setlist/setlist-global.css');

const VARIANTS: readonly GearArtVariant[] = ['strip', 'tab'];

// ---------------------------------------------------------------------------------------------------------------------
// The two trees

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const reference = parse(readFileSync(REFERENCE, 'utf8'));

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Not found: ${what}`);
  return value;
}

const referenceCss = must(reference.querySelector('style'), 'the reference <style>').textContent ?? '';

const referenceArt = (gear: GearId, variant: GearArtVariant) =>
  must(
    reference.querySelector(`${variant === 'strip' ? '.strip' : '.tab'}[data-gear="${gear}"] > svg`),
    `${gear} ${variant} art`,
  );
const referenceEraTab = () => must(reference.querySelector('.tab[data-gear="era"] > svg'), 'the Era tab art');
const referenceEraIcon = (era: EraId) =>
  must(reference.querySelector(`.era-btn[data-era="${era}"] > svg`), `the ${era} icon`);

/** Renders to static markup, parses it back and returns the one root element. */
function rendered(element: ReactElement): Element {
  const doc = parse(`<!doctype html><body>${renderToStaticMarkup(element)}`);
  expect(doc.body.children).toHaveLength(1);
  return must(doc.body.firstElementChild, 'the rendered root');
}

/** The reference's strip svg also carries `gear-art`, which is the parent's class (it sets the size). */
const PARENT_CLASS = 'gear-art';

const art = (gear: GearId, variant: GearArtVariant, value: number, className?: string) =>
  rendered(<GearArt gear={gear} variant={variant} value={value} className={className} />);

/** The strip as its parent renders it, with the parent's class; the tab has none. */
const artAsParentRenders = (gear: GearId, variant: GearArtVariant, value: number) =>
  art(gear, variant, value, variant === 'strip' ? PARENT_CLASS : undefined);

const eraTab = (eras: readonly EraId[], className?: string) => rendered(<EraTabArt eras={eras} className={className} />);
const eraIcon = (era: EraId) => rendered(<EraIcon era={era} />);

/** Every root svg the components draw. */
const everyRoot = (): Array<[string, Element]> => [
  ...GEAR_IDS.flatMap((gear) => VARIANTS.map((variant): [string, Element] => [`${gear} ${variant}`, art(gear, variant, 50)])),
  ['era tab', eraTab(['s90'])],
  ...ERA_IDS.map((era): [string, Element] => [`${era} icon`, eraIcon(era)]),
];

// ---------------------------------------------------------------------------------------------------------------------
// The walk

/** Reference classes mapped to the CSS-module class that stands for them here. */
const MODULE_CLASS: Record<string, string> = {
  'art-lane': 'artLane',
  'art-cream': 'artCream',
  'art-dark': 'artDark',
  'art-black': 'artBlack',
  'hist-note': 'histNote',
  'pop-bolt': 'popBolt',
  'metro-pend': 'metroPend',
  bob: 'bob',
  zap: 'zap',
};
/** Reference classes that only exist for its script to find an element. The components have no class for them. */
const SCRIPT_HOOKS = new Set(['lane-band', 'lane-dashes', 'lane-dash', 'metro-weight', 'era-dot']);

/** Attributes the reference's script sets, by the reference class of the element. The component sets them too. */
const DYNAMIC_ATTRS: Record<string, string[]> = {
  'lane-band': ['y', 'height', 'fill'],
  'lane-dashes': ['fill'],
  'lane-dash': ['y'],
  'metro-weight': ['transform'],
  'era-dot': ['fill'],
};
/** Inline style properties the reference's script sets. */
const DYNAMIC_STYLE: Record<string, string[]> = {
  'hist-note': ['opacity'],
  'pop-bolt': ['opacity'],
  'metro-pend': ['animation'],
};

const classTokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
/** vitest turns a module class `artLane` into `_artLane_<hash>`; a real build has its own scheme. Compare by name. */
const moduleName = (token: string) => /^_(.+)_[0-9a-f]+$/.exec(token)?.[1] ?? token;

function expectedClass(referenceClass: string): string[] {
  const own = MODULE_CLASS[referenceClass];
  if (own) return [own];
  if (SCRIPT_HOOKS.has(referenceClass)) return [];
  if (referenceClass === PARENT_CLASS) return [PARENT_CLASS];
  throw new Error(`The reference class "${referenceClass}" has no mapping in this test`);
}

function styleOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of (el.getAttribute('style') ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) out[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim();
  }
  return out;
}
const sortedEntries = (record: Record<string, string>) =>
  JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
const show = (value: string | null) => (value === null ? 'missing' : JSON.stringify(value));

interface Pair {
  ref: Element;
  got: Element;
}
interface Walk {
  problems: string[];
  pairs: Pair[];
}

function walk(ref: Element, got: Element, path: string, out: Walk): void {
  out.pairs.push({ ref, got });
  if (ref.localName !== got.localName) {
    out.problems.push(`${path}: <${ref.localName}> in the reference, <${got.localName}> in the component`);
    return;
  }
  const refClasses = classTokens(ref);
  const dynamicAttrs = refClasses.flatMap((c) => DYNAMIC_ATTRS[c] ?? []);
  const dynamicStyle = refClasses.flatMap((c) => DYNAMIC_STYLE[c] ?? []);

  // Attributes are identical, apart from the ones that follow the value.
  for (const name of new Set([...ref.getAttributeNames(), ...got.getAttributeNames()])) {
    if (name === 'class' || name === 'style' || dynamicAttrs.includes(name)) continue;
    if (ref.getAttribute(name) !== got.getAttribute(name)) {
      const was = show(ref.getAttribute(name));
      out.problems.push(`${path}: ${name} is ${was} in the reference, ${show(got.getAttribute(name))} in the component`);
    }
  }
  for (const name of dynamicAttrs) {
    if (!got.hasAttribute(name)) out.problems.push(`${path}: the component does not set ${name}`);
  }

  // Inline style is identical, apart from the properties that follow the value.
  const refStyle = styleOf(ref);
  const gotStyle = styleOf(got);
  for (const property of dynamicStyle) {
    if (!(property in gotStyle)) out.problems.push(`${path}: the component does not set style ${property}`);
    delete gotStyle[property];
  }
  if (sortedEntries(refStyle) !== sortedEntries(gotStyle)) {
    out.problems.push(`${path}: style is ${sortedEntries(refStyle)} in the reference, ${sortedEntries(gotStyle)} in the component`);
  }

  // The classes that carry the CSS are all there, and no others.
  const want = refClasses.flatMap(expectedClass).sort();
  const have = classTokens(got).map(moduleName).sort();
  if (want.join(' ') !== have.join(' ')) {
    out.problems.push(`${path}: classes are [${have}] but the reference's [${refClasses}] map to [${want}]`);
  }

  const refKids = [...ref.children];
  const gotKids = [...got.children];
  if (refKids.length !== gotKids.length) {
    out.problems.push(`${path}: ${refKids.length} children in the reference, ${gotKids.length} in the component`);
    return;
  }
  refKids.forEach((kid, i) => {
    const other = gotKids[i];
    if (other) walk(kid, other, `${path}>${kid.localName}[${i}]`, out);
  });
}

function compare(ref: Element, got: Element): Walk {
  const out: Walk = { problems: [], pairs: [] };
  walk(ref, got, ref.localName, out);
  return out;
}

const elementCount = (root: Element) => 1 + root.querySelectorAll('*').length;

/** Fails with the list of differences; also fails if the walk did not reach every element of the reference. */
function expectSameMarkup(ref: Element, got: Element): Walk {
  const walked = compare(ref, got);
  expect(walked.problems).toEqual([]);
  expect(walked.pairs).toHaveLength(elementCount(ref));
  expect(ref.textContent?.trim()).toBe('');
  expect(got.textContent).toBe('');
  return walked;
}

const attr = (name: string) => (el: Element) => el.getAttribute(name);
const styleProp = (name: string) => (el: Element) => styleOf(el)[name];
const attrs = (el: Element, names: string[]) => Object.fromEntries(names.map((name) => [name, el.getAttribute(name)]));
const INDEXES = ['0', '1', '2', '3', '4', '5', '6'];

/** Draws a gear's art at `value`, checks it against the reference, and finds elements by their reference class. */
function drawn(gear: GearId, variant: GearArtVariant, value: number) {
  const walked = expectSameMarkup(referenceArt(gear, variant), artAsParentRenders(gear, variant, value));
  const byClass = (name: string) => walked.pairs.filter(({ ref }) => classTokens(ref).includes(name)).map(({ got }) => got);
  return { byClass };
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the reference this test reads', () => {
  it('has the art blocks the components are checked against', () => {
    expect(reference.querySelectorAll('.strip > svg')).toHaveLength(4);
    expect(reference.querySelectorAll('.tab > svg')).toHaveLength(5);
    expect(reference.querySelectorAll('.era-btn > svg')).toHaveLength(7);
    expect([...reference.querySelectorAll('.era-btn')].map(attr('data-era'))).toEqual([...ERA_IDS]);
  });

  it('leaves the parts that follow a value blank until its script runs, which is why the walk skips them', () => {
    expect(reference.querySelectorAll('.hist-note[style], .pop-bolt[style], .metro-pend[style]')).toHaveLength(0);
    expect(reference.querySelectorAll('.metro-weight[transform], .era-dot[fill], .lane-dashes[fill], .lane-dash[y]')).toHaveLength(0);
    expect(reference.querySelectorAll('.lane-band')).toHaveLength(2);
    for (const band of reference.querySelectorAll('.lane-band')) {
      expect(attrs(band, ['y', 'height', 'fill'])).toEqual({ y: '0', height: '0', fill: null });
    }
  });
});

describe('GearArt: the markup is the reference markup', () => {
  for (const gear of GEAR_IDS) {
    for (const variant of VARIANTS) {
      it(`${gear} ${variant} matches the reference, element by element`, () => {
        // The structure must not depend on the value.
        for (const value of [0, 50, 100]) expectSameMarkup(referenceArt(gear, variant), artAsParentRenders(gear, variant, value));
      });
    }
  }

  it('draws both variants of every gear, as one svg on a 150x80 viewBox, hidden from assistive tech', () => {
    for (const gear of GEAR_IDS) {
      const strip = art(gear, 'strip', 50);
      const tab = art(gear, 'tab', 50);
      for (const root of [strip, tab]) {
        expect(root.localName).toBe('svg');
        expect(root.getAttribute('viewBox')).toBe('0 0 150 80');
        expect(root.getAttribute('aria-hidden')).toBe('true');
        expect(root.querySelectorAll('svg')).toHaveLength(0);
      }
      expect(strip.outerHTML).not.toBe(tab.outerHTML);
    }
  });

  it('puts the parent className on the root svg, after the background class that belongs to the gear', () => {
    const background: Record<GearId, string> = { difficulty: 'artLane', history: 'artCream', popularity: 'artDark', tempo: 'artCream' };
    for (const gear of GEAR_IDS) {
      for (const variant of VARIANTS) {
        expect(classTokens(art(gear, variant, 50, 'probe')).map(moduleName)).toEqual([background[gear], 'probe']);
        expect(classTokens(art(gear, variant, 50)).map(moduleName)).toEqual([background[gear]]);
      }
    }
    expect(classTokens(eraTab([], 'probe')).map(moduleName)).toEqual(['artBlack', 'probe']);
    expect(classTokens(eraTab([])).map(moduleName)).toEqual(['artBlack']);
  });
});

describe('GearArt: difficulty follows the value (the pitch lane)', () => {
  // The band is 14 + value x 0.62 high around y = 40, in the tier colour; the dashes spread with it.
  const DIFFICULTY = [
    { value: 0, color: '#4FD17A', bandY: '33', bandHeight: '14', dashY: ['40', '38', '33', '36', '41', '35', '33'] },
    { value: 20, color: '#4FD17A', bandY: '27', bandHeight: '26', dashY: ['45', '39', '27', '34', '47', '31', '28'] },
    { value: 60, color: '#F5B82E', bandY: '14', bandHeight: '51', dashY: ['55', '42', '14', '30', '60', '23', '17'] },
    { value: 90, color: '#FF6B70', bandY: '5', bandHeight: '70', dashY: ['63', '43', '5', '27', '69', '18', '8'] },
    { value: 100, color: '#FF6B70', bandY: '2', bandHeight: '76', dashY: ['65', '44', '2', '27', '72', '16', '6'] },
  ];

  for (const { value, color, bandY, bandHeight, dashY } of DIFFICULTY) {
    for (const variant of VARIANTS) {
      it(`${variant} at ${value}: band at y ${bandY}, ${bandHeight} high, in ${color}`, () => {
        const { byClass } = drawn('difficulty', variant, value);
        const band = byClass('lane-band').map((el) => attrs(el, ['x', 'y', 'width', 'height', 'fill', 'fill-opacity']));
        expect(band).toEqual([{ x: '0', y: bandY, width: '150', height: bandHeight, fill: color, 'fill-opacity': '0.2' }]);
        expect(byClass('lane-dashes').map(attr('fill'))).toEqual([color]);
        expect(byClass('lane-dash').map(attr('data-i'))).toEqual(INDEXES);
        expect(byClass('lane-dash').map(attr('y'))).toEqual(dashY);
      });
    }
  }
});

describe('GearArt: history notes and popularity bolts follow the value', () => {
  // Item i is drawn once the value reaches (i + 0.5) x 100 / 7, so 50 draws the first four.
  const ITEMS = [
    { value: 0, opacity: ['0', '0', '0', '0', '0', '0', '0'] },
    { value: 50, opacity: ['1', '1', '1', '1', '0', '0', '0'] },
    { value: 100, opacity: ['1', '1', '1', '1', '1', '1', '1'] },
  ];

  for (const { value, opacity } of ITEMS) {
    for (const variant of VARIANTS) {
      it(`history ${variant} at ${value}: note opacities ${opacity.join(' ')}`, () => {
        const notes = drawn('history', variant, value).byClass('hist-note');
        expect(notes.map(attr('data-i'))).toEqual(INDEXES);
        expect(notes.map(styleProp('opacity'))).toEqual(opacity);
      });

      it(`popularity ${variant} at ${value}: bolt opacities ${opacity.join(' ')}`, () => {
        const bolts = drawn('popularity', variant, value).byClass('pop-bolt');
        expect(bolts.map(attr('data-i'))).toEqual(INDEXES);
        expect(bolts.map(styleProp('opacity'))).toEqual(opacity);
      });
    }
  }

  it('bobs the notes and the bolts on the strip only, each with its own delay', () => {
    const delays = (gear: 'history' | 'popularity', variant: GearArtVariant, cls: string) =>
      drawn(gear, variant, 50)
        .byClass(cls)
        .map((el) => styleOf(el)['animation-delay']);
    expect(delays('history', 'strip', 'bob')).toEqual([undefined, '0.2s', '0.4s', '0.1s', '0.3s', '0.5s', '0.6s']);
    expect(delays('popularity', 'strip', 'zap')).toEqual([undefined, '0.1s', '0.2s', '0.3s', '0.4s', '0.5s', '0.6s']);
    expect(drawn('history', 'tab', 50).byClass('bob')).toHaveLength(0);
    expect(drawn('popularity', 'tab', 50).byClass('zap')).toHaveLength(0);
  });
});

describe('GearArt: tempo follows the value (the metronome)', () => {
  // Faster tempo: a shorter half-swing, a narrower swing and the weight further down the rod.
  const TEMPO = [
    { value: 0, animation: 'swing20 1.20s ease-in-out infinite alternate', weight: 'translate(0 16)' },
    { value: 55, animation: 'swing14 0.45s ease-in-out infinite alternate', weight: 'translate(0 31)' },
    { value: 100, animation: 'swing8 0.30s ease-in-out infinite alternate', weight: 'translate(0 43)' },
  ];

  for (const { value, animation, weight } of TEMPO) {
    for (const variant of VARIANTS) {
      it(`${variant} at ${value}: ${animation}, weight at ${weight}`, () => {
        const { byClass } = drawn('tempo', variant, value);
        expect(byClass('metro-pend').map(styleProp('animation'))).toEqual([animation]);
        expect(byClass('metro-weight').map(attr('transform'))).toEqual([weight]);
      });
    }
  }

  it('at tempo 55 swings 14 degrees each way, 0.45 s a half-swing (spec test 12)', () => {
    for (const variant of VARIANTS) {
      const pendulum = drawn('tempo', variant, 55).byClass('metro-pend');
      expect(pendulum.map(styleProp('animation'))).toEqual(['swing14 0.45s ease-in-out infinite alternate']);
    }
  });
});

describe('EraTabArt', () => {
  const PICKED = '#FFD84D';
  const NOT_PICKED = '#4A1B0C';
  // The fills are in ERA_IDS order: pre, s70, s80, s90, s00, s10, s20.
  const DOTS: Array<{ eras: EraId[]; fills: string[] }> = [
    { eras: [], fills: Array(7).fill(NOT_PICKED) },
    { eras: ['s90', 's00', 's10'], fills: [NOT_PICKED, NOT_PICKED, NOT_PICKED, PICKED, PICKED, PICKED, NOT_PICKED] },
    { eras: ['s20', 'pre'], fills: [PICKED, NOT_PICKED, NOT_PICKED, NOT_PICKED, NOT_PICKED, NOT_PICKED, PICKED] },
    { eras: ['s80'], fills: [NOT_PICKED, NOT_PICKED, PICKED, NOT_PICKED, NOT_PICKED, NOT_PICKED, NOT_PICKED] },
    { eras: [...ERA_IDS], fills: Array(7).fill(PICKED) },
  ];

  it('matches the reference Era tab art, element by element', () => {
    for (const { eras } of DOTS) expectSameMarkup(referenceEraTab(), eraTab(eras));
  });

  it('is one svg on a 62x33 viewBox, hidden from assistive tech', () => {
    const root = eraTab([]);
    expect(root.localName).toBe('svg');
    expect(root.getAttribute('viewBox')).toBe('0 0 62 33');
    expect(root.getAttribute('aria-hidden')).toBe('true');
  });

  for (const { eras, fills } of DOTS) {
    it(`eras [${eras.join(' ')}]: the dots of the picked eras are yellow and the rest dark`, () => {
      const dots = [...eraTab(eras).querySelectorAll('circle')];
      expect(dots.map(attr('data-era'))).toEqual([...ERA_IDS]);
      expect(dots.map(attr('fill'))).toEqual(fills);
    });
  }
});

describe('EraIcon', () => {
  it.each(ERA_IDS)('%s matches the icon in the reference era button, element by element', (era) => {
    expectSameMarkup(referenceEraIcon(era), eraIcon(era));
  });

  it('draws a different icon for each of the seven eras, 26x26 on a 30x30 grid, in the text colour', () => {
    const icons = ERA_IDS.map(eraIcon);
    expect(new Set(icons.map((icon) => icon.outerHTML)).size).toBe(7);
    for (const icon of icons) {
      expect(attrs(icon, ['width', 'height', 'viewBox', 'fill', 'stroke', 'aria-hidden'])).toEqual({
        width: '26',
        height: '26',
        viewBox: '0 0 30 30',
        fill: 'none',
        stroke: 'currentColor',
        'aria-hidden': 'true',
      });
    }
  });
});

describe('every root svg is decorative', () => {
  it('has aria-hidden, no id anywhere, no title or role, and no text', () => {
    const roots = everyRoot();
    expect(roots).toHaveLength(GEAR_IDS.length * VARIANTS.length + 1 + ERA_IDS.length);
    for (const [name, root] of roots) {
      expect(root.getAttribute('aria-hidden'), name).toBe('true');
      expect(root.hasAttribute('id') || root.hasAttribute('role'), name).toBe(false);
      expect(root.querySelectorAll('[id], [role], title, desc'), name).toHaveLength(0);
      expect(root.textContent, name).toBe('');
    }
  });
});

describe('the comparison itself', () => {
  it('notices a changed attribute, a missing element, a lost class and a value-driven part left unset', () => {
    const ref = referenceArt('difficulty', 'strip');
    const fresh = () => artAsParentRenders('difficulty', 'strip', 50);
    expect(compare(ref, fresh()).problems).toEqual([]);

    const changed = fresh();
    must(changed.querySelector('line'), 'a grid line').setAttribute('y1', '13');
    expect(compare(ref, changed).problems).toHaveLength(1);

    const missing = fresh();
    must(missing.querySelector('g'), 'a group').remove();
    expect(compare(ref, missing).problems.length).toBeGreaterThan(0);

    const classless = fresh();
    classless.removeAttribute('class');
    expect(compare(ref, classless).problems).toHaveLength(1);

    const unset = fresh();
    must(unset.querySelector('rect'), 'the band').removeAttribute('fill');
    expect(compare(ref, unset).problems).toEqual(['svg>rect[0]: the component does not set fill']);

    const noOpacity = artAsParentRenders('history', 'strip', 50);
    must(noOpacity.querySelector('[data-i]'), 'a note').removeAttribute('style');
    expect(compare(referenceArt('history', 'strip'), noOpacity).problems).toEqual([
      'svg>g[3]: the component does not set style opacity',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The CSS. vitest does not process CSS Modules: it hands back a made-up name for any key, so a class the components use
// but the stylesheet lacks would pass everything above. These checks read the files.

const squash = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,])\s*/g, '$1').trim();

/** The top-level rules of a stylesheet, or of the inside of an at-rule, as [prelude, body] with whitespace squeezed. */
function rulesOf(css: string): Array<[string, string]> {
  const text = squash(css);
  const out: Array<[string, string]> = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push([text.slice(start, open).trim(), text.slice(open + 1, i).trim()]);
        start = i + 1;
      }
    }
  }
  return out;
}

function bodyOf(css: string, prelude: string): string {
  const found = rulesOf(css).filter(([p]) => p === squash(prelude));
  expect(found, `the rule "${prelude}"`).toHaveLength(1);
  return found[0]?.[1] ?? '';
}

describe('GearArt.module.css', () => {
  const moduleCss = readFileSync(MODULE_CSS, 'utf8');

  it('defines exactly the classes the components use', () => {
    const used = new Set<string>();
    for (const [, root] of everyRoot()) {
      for (const el of [root, ...root.querySelectorAll('*')]) for (const token of classTokens(el)) used.add(moduleName(token));
    }
    const defined = new Set([...squash(moduleCss).matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1] ?? ''));
    expect([...used].sort()).toEqual([...defined].sort());
  });

  it('draws the reference backgrounds, as literal colours (the app has its own --bg)', () => {
    const tokenRules = [...bodyOf(referenceCss, ':root').matchAll(/(--[\w-]+):([^;]+);/g)];
    const tokens = new Map(tokenRules.map((m): [string, string] => [m[1] ?? '', m[2] ?? '']));
    const resolved = (body: string) =>
      body.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => tokens.get(name) ?? `unknown ${name}`).toLowerCase();
    const backgrounds = [
      ['.art-lane', '.artLane'],
      ['.art-cream', '.artCream'],
      ['.art-dark', '.artDark'],
      ['.art-black', '.artBlack'],
    ] as const;
    for (const [from, to] of backgrounds) {
      expect(bodyOf(moduleCss, to).toLowerCase()).toBe(resolved(bodyOf(referenceCss, from)));
    }
    expect(squash(moduleCss)).not.toContain('var(');
  });

  it('has the reference rules for the fade, the pendulum pivot and the bob', () => {
    const same = [
      ['.hist-note, .pop-bolt', '.histNote, .popBolt'],
      ['.metro-pend', '.metroPend'],
      ['@keyframes bob', '@keyframes bob'],
      ['.bob, .zap', '.bob, .zap'],
    ] as const;
    for (const [from, to] of same) expect(bodyOf(moduleCss, to), to).toBe(bodyOf(referenceCss, from));
  });

  it('turns the pendulum, bob and zap animations off for reduced motion, with !important', () => {
    const reduced = '@media (prefers-reduced-motion: reduce)';
    // In the reference that block also holds the rows' and the rack's transitions, which are not the art's.
    expect(rulesOf(bodyOf(referenceCss, reduced))[0]).toEqual(['.metro-pend,.bob,.zap', 'animation:none !important;']);
    expect(rulesOf(bodyOf(moduleCss, reduced))).toEqual([['.metroPend,.bob,.zap', 'animation:none !important;']]);
  });
});

describe('setlist-global.css', () => {
  const swings = (css: string) => rulesOf(css).filter(([prelude]) => prelude.startsWith('@keyframes swing'));
  const globalCss = readFileSync(GLOBAL_CSS, 'utf8');

  it('holds the reference swing keyframes and nothing else', () => {
    expect(rulesOf(globalCss)).toEqual(swings(referenceCss));
    const names = ['20', '18', '16', '14', '12', '10', '8'].map((n) => `@keyframes swing${n}`);
    expect(swings(globalCss).map(([prelude]) => prelude)).toEqual(names);
  });

  it('has a keyframes rule for every animation name the metronome can ask for', () => {
    const asked = new Set(Array.from({ length: 101 }, (_, tempo) => `@keyframes ${metronome(tempo).keyframes}`));
    expect([...asked].sort()).toEqual(swings(globalCss).map(([prelude]) => prelude).sort());
  });
});
