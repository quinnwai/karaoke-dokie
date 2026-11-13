// @vitest-environment jsdom
// The gear art against the reference (Round 6A §6 to §9, Round 7 §4, §5). docs/setlist-round7/setlist-round7-mood.html, which is Round
// 6A's reference with the Tempo gear drawn as the Mood speaker and nothing else of the art changed (QWW-72), is parsed as the markup
// as authored, and its script is run once, in a document of its own, only to ask its viewModel() what it draws for a state
// (README §2). Each component is rendered to static markup and parsed the same way, and the two trees are walked together:
// at every position the tag and every attribute must be identical, except
//   - `class`, which CSS Modules renames, so the class names are compared instead;
//   - `data-b` and `data-on`, the reference's own bindings. They say which attributes and inline styles its script draws
//     from a state, so the walk reads them and expects what the view model gives for that state (it applies the bindings
//     itself, rather than lean on how jsdom writes styles);
//   - ids, and the `url(#id)` that points at one: the component's filter ids are its own, one per instance;
//   - what the parent owns, which the walk requires to be absent: a strip's width and height, the glow on an era icon;
//   - the notes, bolts and rays the value does not reach (QWW-57, R7). The reference hides them (`style.opacity` 0, a binding the
//     walk reads) and this build draws them unlit, in full opacity, marked `data-lit="false"`; the walk expects that wherever the
//     reference's binding says hidden, and the lit colour and `data-lit="true"` wherever it says shown. It is the one place the
//     art deliberately differs from the reference's drawing (docs/setlist-round6a/README.md);
//   - the glow of the History and Popularity tab icons (QWW-57, R7). The reference puts a CSS drop-shadow on the whole svg, which lights
//     the unlit rays too; this build puts an SVG filter on one group of the body and the lit rays. Before it compares, the walk takes
//     out of the component's tree what that adds (the filter's `defs`, the group that names it, the rays split into lit and unlit),
//     expects `overflow="visible"` on the root (the glow reaches past the icon's box) and no filter in the root's style. What the glow
//     is and what it reaches are asserted on their own below;
//   - the Era tab's jukebox buttons (QWW-57, R24). The reference draws two, lit amber by how many eras are picked and a dark rose when
//     not; this build draws three, lit amber by which are picked and the unlit grey when not. The walk takes them out of both trees
//     (withoutJukeboxButtons), and they are asserted on their own below;
//   - the hooks the component adds for the browser tests (data-note, data-bolt, ...), asserted on their own below.
// Both trees are parsed with jsdom's DOMParser, the engine this test already runs on; `new JSDOM` would need @types/jsdom.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EraIcon, EraTabArt, GearArt, type GearArtVariant } from '../../src/components/setlist/GearArt';
import { FLICKER_MS, TAB_PX_PER_UNIT, flickerSession, neonFlicker, resetFlickerSession, speaker } from '../../src/lib/setlist/art';
import { DEFAULTS } from '../../src/lib/setlist/defaults';
import { ERA_IDS, GEAR_IDS, type EraId, type GearId } from '../../src/lib/setlist/types';

const REFERENCE = join(__dirname, '../../docs/setlist-round7/setlist-round7-mood.html');
const MODULE_CSS = join(__dirname, '../../src/components/setlist/GearArt.module.css');
const GLOBAL_CSS = join(__dirname, '../../src/components/setlist/setlist-global.css');

const VARIANTS: readonly GearArtVariant[] = ['strip', 'tab'];
const INDEXES = ['0', '1', '2', '3', '4', '5', '6'];
const VALUES = Array.from({ length: 101 }, (_, value) => value);

// The README's colours, written out (§3.1, §9), so a wrong value in art.ts cannot agree with itself here.
const COLOR = {
  unlit: '#34313D',
  pink: '#FF4FA0',
  cyan: '#4FDDE8',
  amber: '#FFC24A',
  violet: '#B583FF',
  easy: '#4DE89A',
  hard: '#FF5A8A',
  grid: '#1F1D26',
};

// Every case is a page's first load: the flicker remembers, for the life of the page, that a strip has been drawn (art.ts, flickerSession).
beforeEach(resetFlickerSession);
afterEach(cleanup);

// ---------------------------------------------------------------------------------------------------------------------
// The reference, and what its view model draws

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

type ViewModel = Record<string, unknown>;

/** What the reference's script exposes as `window.setlist` (README §2). */
interface ReferenceHook {
  setState(patch: object): void;
  viewModel(): ViewModel;
}

interface ReferenceState {
  difficulty: number;
  history: number;
  popularity: number;
  tempo: number;
  eras: EraId[];
  /** The gears that were reset, and 'era'. */
  off: Array<GearId | 'era'>;
}

/** The reference's own mock defaults (README §1), nothing off. Every state this test asks for is this plus a patch. */
const BASELINE: ReferenceState & { open: string; mini: boolean; dragY: null } = {
  difficulty: 30,
  history: 65,
  popularity: 80,
  tempo: 45,
  eras: ['s90', 's00', 's10'],
  off: [],
  open: 'history',
  mini: false,
  dragY: null,
};

/**
 * The app's real defaults (QWW-57), which replace the README's mock ones: Difficulty 0 on, History 100 off, Popularity 100
 * on, Tempo 50 off, Era off with no picks.
 */
const APP_DEFAULTS: Partial<ReferenceState> = {
  difficulty: 0,
  history: 100,
  popularity: 100,
  tempo: 50,
  eras: [],
  off: ['history', 'tempo', 'era'],
};

/** Runs the reference's script in a document of its own, so nothing it does reaches this test's document. */
function runReference(): ReferenceHook {
  const script = must(reference.querySelector('script'), 'the reference script').textContent ?? '';
  const doc = document.implementation.createHTMLDocument('reference');
  doc.body.innerHTML = reference.body.innerHTML;
  const fakeWindow: { setlist?: ReferenceHook } = {};
  new Function('document', 'window', 'location', script)(doc, fakeWindow, { search: '' });
  return must(fakeWindow.setlist, 'the reference script\'s window.setlist hook');
}
const hook = runReference();

/** The reference's view model for a state: the baseline with `patch` applied. */
function viewModelFor(patch: Partial<ReferenceState> = {}): ViewModel {
  hook.setState({ ...BASELINE, ...patch });
  return hook.viewModel();
}

/** The reference state a patch makes, for reading the values the components are given. */
const stateOf = (patch: Partial<ReferenceState>): ReferenceState => ({ ...BASELINE, ...patch });

interface Binding {
  target: string;
  path: string;
  suffix: string;
}

/** The reference's `data-b="target:path|suffix; ..."` (README §2). */
function bindingsOf(el: Element): Binding[] {
  const out: Binding[] = [];
  for (const spec of (el.getAttribute('data-b') ?? '').split(';')) {
    const text = spec.trim();
    if (!text) continue;
    const cut = text.indexOf(':');
    const [path = '', suffix = ''] = text
      .slice(cut + 1)
      .trim()
      .split('|');
    out.push({ target: text.slice(0, cut).trim(), path, suffix });
  }
  return out;
}

const lookup = (vm: ViewModel, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((o, key) => (o === null || o === undefined ? undefined : (o as Record<string, unknown>)[key]), vm);

/** What the reference's binder would write for a binding, or null when it would remove the attribute. */
function boundValue(vm: ViewModel, binding: Binding): string | null {
  const raw = lookup(vm, binding.path);
  return raw === undefined || raw === null ? null : String(raw) + binding.suffix;
}

const isStyleBinding = (b: Binding) => b.target.startsWith('style.');
const isAttributeBinding = (b: Binding) =>
  !isStyleBinding(b) && !b.target.startsWith('class.') && b.target !== 'text' && b.target !== 'value';
/** What shows a note, a bolt or a ray in the reference: `style.opacity` from art.oN (History) or art.qN (Popularity), 1 or 0. */
const isShownBinding = (b: Binding) => b.target === 'style.opacity' && /^art\.[oq]\d$/.test(b.path);
/** The colour of a note, a bolt or a ray in the reference: art.nN (History) or art.bN (Popularity). */
const isItemColour = (b: Binding) => /^art\.[nb]\d$/.test(b.path);
/**
 * The glow of a History or Popularity tab in the reference: `style.filter` on the root svg. R7 moves it onto the lit parts, so the
 * walk expects no filter on that root, and the `overflow="visible"` that lets the glow reach past the icon's box.
 */
const isMovedGlow = (b: Binding) => b.target === 'style.filter' && /^tabs\.(history|popularity)\.glow$/.test(b.path);

// ---------------------------------------------------------------------------------------------------------------------
// Rendering

/** Renders to static markup, parses it back and returns the one root element. */
function rendered(element: ReactElement): Element {
  const doc = parse(`<!doctype html><body>${renderToStaticMarkup(element)}`);
  expect(doc.body.children).toHaveLength(1);
  return must(doc.body.firstElementChild, 'the rendered root');
}

/** The reference's strip svg also carries `gear-art`, which is the parent's class (it sets the size and the box). */
const PARENT_CLASS = 'gear-art';

const art = (gear: GearId, variant: GearArtVariant, value: number, off: boolean, className?: string) =>
  rendered(<GearArt gear={gear} variant={variant} value={value} off={off} className={className} />);

/** The strip as its parent renders it, with the parent's class; the tab has none. */
const artAsParentRenders = (gear: GearId, variant: GearArtVariant, value: number, off: boolean) =>
  art(gear, variant, value, off, variant === 'strip' ? PARENT_CLASS : undefined);

const eraTab = (eras: readonly EraId[], off: boolean, className?: string) =>
  rendered(<EraTabArt eras={eras} off={off} className={className} />);
const eraIcon = (era: EraId) => rendered(<EraIcon era={era} />);

/** Every root svg the components draw, by name. */
const everyRoot = (): Array<[string, Element]> => [
  ...GEAR_IDS.flatMap((gear) =>
    VARIANTS.map((variant): [string, Element] => [`${gear} ${variant}`, art(gear, variant, 50, false)]),
  ),
  ['era tab', eraTab(['s90'], false)],
  ...ERA_IDS.map((era): [string, Element] => [`${era} icon`, eraIcon(era)]),
];

// ---------------------------------------------------------------------------------------------------------------------
// The walk

/** The classes the components carry. Reference classes mapped to the CSS-module class that stands for them. */
function expectedClass(referenceClass: string, variant: Context['variant']): string[] {
  switch (referenceClass) {
    case PARENT_CLASS: // the parent's, which this test passes in
    case 'flick':
    case 'fade':
    case 'bob':
      return [referenceClass];
    case 'thump':
      // The cone's centre differs between the strip's 150x80 grid and the tab's 28x22, so the module has a class for each.
      return [variant === 'tab' ? 'thumpTab' : 'thump'];
    default:
      throw new Error(`The reference class "${referenceClass}" has no mapping in this test`);
  }
}

/** The attributes the walk does not compare one by one. */
const NOT_COMPARED = new Set(['class', 'style', 'id', 'data-b', 'data-on']);
/** What the components add so the browser tests can find a part. Each is asserted on its own. */
const HOOKS = new Set(['data-note', 'data-bolt', 'data-ray', 'data-i', 'data-thump', 'data-cone', 'data-wave', 'data-jukebox']);
/** An id that is safe inside `url(#...)`. */
const PLAIN_ID = /^[A-Za-z][\w-]*$/;

const classTokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
/** vitest turns a module class `thump` into `_thump_<hash>`; a real build has its own scheme. Compare by name. */
const moduleName = (token: string) => /^_(.+)_[0-9a-f]+$/.exec(token)?.[1] ?? token;

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

interface Context {
  vm: ViewModel;
  /** Where the art is: a strip's width and height are the parent's; an era icon's glow is the era button's. */
  variant: 'strip' | 'tab' | 'era-icon';
  /** The reference's filter ids mapped to the component's, filled in as the walk meets each filter. */
  ids: Map<string, string>;
  /** The gear is off: none of its notes, bolts or rays is lit, whatever the value (README §7). */
  off: boolean;
}

const contextFor = (vm: ViewModel, variant: Context['variant'], off = false): Context => ({ vm, variant, ids: new Map(), off });

interface Pair {
  ref: Element;
  got: Element;
}
interface Walk {
  problems: string[];
  pairs: Pair[];
}

/**
 * `litAbove` is what the nearest note or bolt group above says (a note's colour is on its inner group, a bolt's on its path);
 * null where there is none. A ray carries both its colour and its shown-or-hidden binding on its own path.
 */
function walk(ref: Element, got: Element, path: string, ctx: Context, out: Walk, litAbove: boolean | null = null): void {
  out.pairs.push({ ref, got });
  if (ref.localName !== got.localName) {
    out.problems.push(`${path}: <${ref.localName}> in the reference, <${got.localName}> in the component`);
    return;
  }
  const bindings = bindingsOf(ref);
  // R7: where the reference hides a note, a bolt or a ray this build draws it unlit and says so with data-lit; where it shows
  // one, it is lit, unless the gear is off. The tube's colour follows: UNLIT unless it is lit.
  const shownBinding = bindings.find(isShownBinding);
  const lit = shownBinding ? !ctx.off && boundValue(ctx.vm, shownBinding) === '1' : litAbove;
  // What the parent owns is on the root svg alone: the band inside a strip has a height of its own.
  const isRoot = !path.includes('>');
  const parentAttrs = isRoot && ctx.variant === 'strip' ? ['width', 'height'] : [];
  const parentStyle = isRoot && ctx.variant === 'era-icon' ? ['filter'] : [];

  // Attributes: what the reference's markup says, then what its bindings write for this state.
  const want = new Map<string, string>();
  for (const name of ref.getAttributeNames()) {
    if (!NOT_COMPARED.has(name)) want.set(name, ref.getAttribute(name) ?? '');
  }
  for (const binding of bindings.filter(isAttributeBinding)) {
    if (parentAttrs.includes(binding.target)) continue;
    const value = lit === false && isItemColour(binding) ? COLOR.unlit : boundValue(ctx.vm, binding);
    if (value === null) want.delete(binding.target);
    else want.set(binding.target, value);
  }
  if (shownBinding) want.set('data-lit', String(lit));
  if (bindings.some(isMovedGlow)) want.set('overflow', 'visible');

  // A filter is found by id, and the component's ids are its own: the walk learns each one, then checks the url() that uses it.
  const refId = ref.getAttribute('id');
  const gotId = got.getAttribute('id');
  if (refId !== null && gotId !== null && PLAIN_ID.test(gotId)) ctx.ids.set(refId, gotId);
  else if (refId !== null || gotId !== null) {
    out.problems.push(`${path}: id is ${show(refId)} in the reference, ${show(gotId)} in the component`);
  }
  for (const [name, value] of want) {
    const url = /^url\(#(.+)\)$/.exec(value);
    if (url) want.set(name, `url(#${ctx.ids.get(url[1] ?? '') ?? 'a filter the component does not have'})`);
  }

  for (const name of new Set([...want.keys(), ...got.getAttributeNames()])) {
    if (NOT_COMPARED.has(name) || HOOKS.has(name)) continue;
    const wanted = want.get(name) ?? null;
    if (wanted !== got.getAttribute(name)) {
      out.problems.push(`${path}: ${name} is ${show(wanted)} in the reference, ${show(got.getAttribute(name))} in the component`);
    }
  }

  // Inline style: the reference's own, then what its bindings write. The speaker cone's centre is in the module CSS (checked
  // with the CSS below), so it must not be inline.
  const wantStyle = styleOf(ref);
  delete wantStyle['transform-origin'];
  for (const binding of bindings.filter(isStyleBinding)) {
    // The opacity is what R7 replaces: nothing is hidden by it any more.
    if (binding === shownBinding) continue;
    // So is the root's glow, on the two icons that have unlit rays: it is on the lit parts, and the root has no filter.
    if (isMovedGlow(binding)) continue;
    const property = binding.target.slice('style.'.length);
    if (parentStyle.includes(property)) continue;
    const value = boundValue(ctx.vm, binding);
    if (value === null) delete wantStyle[property];
    else wantStyle[property] = value;
  }
  const gotStyle = styleOf(got);
  if (sortedEntries(wantStyle) !== sortedEntries(gotStyle)) {
    out.problems.push(`${path}: style is ${sortedEntries(wantStyle)} in the reference, ${sortedEntries(gotStyle)} in the component`);
  }

  // The classes that carry the CSS are all there, and no others.
  const wantClasses = classTokens(ref)
    .flatMap((c) => expectedClass(c, ctx.variant))
    .sort();
  const haveClasses = classTokens(got).map(moduleName).sort();
  if (wantClasses.join(' ') !== haveClasses.join(' ')) {
    out.problems.push(`${path}: classes are [${haveClasses}] but the reference's [${classTokens(ref)}] map to [${wantClasses}]`);
  }

  const refKids = [...ref.children];
  const gotKids = [...got.children];
  if (refKids.length !== gotKids.length) {
    out.problems.push(`${path}: ${refKids.length} children in the reference, ${gotKids.length} in the component`);
    return;
  }
  refKids.forEach((kid, i) => {
    const other = gotKids[i];
    if (other) walk(kid, other, `${path}>${kid.localName}[${i}]`, ctx, out, lit);
  });
}

/**
 * A tab icon as the reference draws it (QWW-57, R7): a copy without the glow's `defs`, without the group that names the filter (a
 * group with no attribute but that one, which an off gear leaves bare), and with the lit rays and the unlit rays back in one group.
 * The History and Popularity icons are built differently on purpose, and the tests on their glow say how. Any other icon comes
 * back as it is: the reference's tab icons have no group of that kind (checked with the reference, above).
 */
function withoutTabGlow(root: Element): Element {
  const copy = root.cloneNode(true) as Element;
  for (const defs of copy.querySelectorAll('defs')) defs.remove();
  for (const group of copy.querySelectorAll('g')) {
    if (group.getAttributeNames().every((name) => name === 'filter')) group.replaceWith(...group.childNodes);
  }
  if (copy.querySelector('[data-ray]')) {
    // What is left is the body, the lit rays and the unlit rays.
    const [, first, ...more] = copy.children;
    for (const group of more) {
      first?.append(...group.childNodes);
      group.remove();
    }
  }
  return copy;
}

/**
 * An Era tab icon without its jukebox buttons (QWW-57, R24). The reference draws two, amber or a dark rose by how many eras are
 * picked; this build draws three, amber or the unlit grey by which eras are picked. So the walk compares the rest of the icon (the body, the
 * window and the bars, the root's stroke and glow), and the buttons are asserted on their own in the jukebox tests below.
 */
function withoutJukeboxButtons(root: Element): Element {
  const copy = root.cloneNode(true) as Element;
  for (const button of copy.querySelectorAll('circle')) button.remove();
  return copy;
}

function compare(ref: Element, got: Element, ctx: Context): Walk {
  const out: Walk = { problems: [], pairs: [] };
  walk(ref, ctx.variant === 'tab' ? withoutTabGlow(got) : got, ref.localName, ctx, out);
  return out;
}

const elementCount = (root: Element) => 1 + root.querySelectorAll('*').length;

/** Fails with the list of differences; also fails if the walk did not reach every element of the reference. */
function expectSameMarkup(ref: Element, got: Element, ctx: Context): Walk {
  const walked = compare(ref, got, ctx);
  expect(walked.problems).toEqual([]);
  expect(walked.pairs).toHaveLength(elementCount(ref));
  expect(ref.textContent?.trim()).toBe('');
  expect(got.textContent).toBe('');
  return walked;
}

/** One art to check: a gear's strip or tab, or the Era tab. */
type Part = { gear: GearId; variant: GearArtVariant } | { gear: 'era' };
const GEAR_PARTS: Part[] = GEAR_IDS.flatMap((gear) => VARIANTS.map((variant): Part => ({ gear, variant })));
const ALL_PARTS: Part[] = [...GEAR_PARTS, { gear: 'era' }];

/** A part drawn for a state, next to the reference's art for it. */
function drawn(part: Part, state: ReferenceState) {
  const off = state.off.includes(part.gear);
  if ('variant' in part) {
    const { gear, variant } = part;
    return {
      label: `${gear} ${variant}`,
      ref: referenceArt(gear, variant),
      got: artAsParentRenders(gear, variant, state[gear], off),
      variant,
      off,
    };
  }
  return {
    label: 'era tab',
    ref: withoutJukeboxButtons(referenceEraTab()),
    got: withoutJukeboxButtons(eraTab(state.eras, off)),
    variant: 'tab' as const,
    off,
  };
}

/** Draws `parts` for a state and compares each with the reference's art for that state. Returns every difference. */
function differences(patch: Partial<ReferenceState>, parts: readonly Part[]): string[] {
  const state = stateOf(patch);
  const vm = viewModelFor(patch);
  const problems: string[] = [];
  for (const part of parts) {
    const { label, ref, got, variant, off } = drawn(part, state);
    const walked = compare(ref, got, contextFor(vm, variant, off));
    problems.push(...walked.problems.map((problem) => `${label} at ${JSON.stringify(patch)}: ${problem}`));
    if (walked.pairs.length !== elementCount(ref)) problems.push(`${label} at ${JSON.stringify(patch)}: the walk missed elements`);
  }
  return problems;
}

const attr = (name: string) => (el: Element) => el.getAttribute(name);
const styleProp = (name: string) => (el: Element) => styleOf(el)[name];
const attrs = (el: Element, names: string[]) => Object.fromEntries(names.map((name) => [name, el.getAttribute(name)]));
const all = (root: Element, selector: string) => [...root.querySelectorAll(selector)];
const one = (root: Element, selector: string) => must(root.querySelector(selector), selector);

/** Whether an element draws or defines a filter: it is a `<filter>`, or has a `filter` attribute or a style that is not `none`. */
const carriesFilter = (el: Element) => el.localName === 'filter' || el.hasAttribute('filter') || (styleOf(el).filter ?? 'none') !== 'none';
/** Everything in an art that carries a filter, the root included. */
const filtersIn = (root: Element) => [root, ...root.querySelectorAll('*')].filter(carriesFilter);

/** The colours an art is drawn in: every stroke and fill, and a tab's `color`, apart from the faint grid behind the strip. */
function paints(root: Element): string[] {
  const found = new Set<string>();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const name of ['stroke', 'fill']) {
      const value = el.getAttribute(name);
      if (value && value !== 'none' && value !== 'currentColor') found.add(value);
    }
    const color = styleOf(el).color;
    if (color) found.add(color);
  }
  found.delete(COLOR.grid);
  return [...found].sort();
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the reference this test reads', () => {
  it('has the art blocks the components are checked against', () => {
    expect(reference.querySelectorAll('.strip > svg')).toHaveLength(4);
    expect(reference.querySelectorAll('.tab > svg')).toHaveLength(5);
    expect(reference.querySelectorAll('.era-btn > svg')).toHaveLength(7);
    expect([...reference.querySelectorAll('.era-btn')].map(attr('data-era'))).toEqual([...ERA_IDS]);
  });

  it('draws no group without an attribute in its tab icons, so a bare group in the component is the glow\'s (withoutTabGlow)', () => {
    for (const svg of reference.querySelectorAll('.tab > svg')) {
      for (const group of svg.querySelectorAll('g')) expect(group.getAttributeNames().length).toBeGreaterThan(0);
    }
  });

  it('leaves the parts that follow a state to its bindings, which is why the walk reads them', () => {
    // The raw markup has no opacity, animation or colour on the parts that move; its script writes them.
    expect(reference.querySelectorAll('.fade[style], .bob[style*="opacity"], .thump[style*="animation"]')).toHaveLength(0);
    expect(reference.querySelectorAll('.strip > svg[style], .tab > svg[style]')).toHaveLength(0);
  });

  it('is run in a document of its own, and its view model answers for the state it is given', () => {
    // README test 26: at the mock defaults five notes and six bolts show.
    const vm = viewModelFor();
    expect(INDEXES.map((i) => lookup(vm, `art.o${i}`))).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(INDEXES.map((i) => lookup(vm, `art.q${i}`))).toEqual([1, 1, 1, 1, 1, 1, 0]);
    expect(lookup(viewModelFor({ off: ['tempo'] }), 'spk.anim')).toBe('none');
    expect(lookup(viewModelFor({ tempo: 80 }), 'spk.anim')).toBe('thump12 0.52s ease-in-out infinite');
    expect(lookup(viewModelFor({ tempo: 80 }), 'spk.tabConeR')).toBe('2.18');
  });

  it('binds every part of its art that follows a state to a view-model value that exists', () => {
    // A binding to a path the view model lacks would write nothing, and the walk would then expect nothing.
    const vm = viewModelFor();
    const svgs = [
      ...GEAR_IDS.flatMap((gear) => VARIANTS.map((variant) => referenceArt(gear, variant))),
      referenceEraTab(),
      ...ERA_IDS.map(referenceEraIcon),
    ];
    expect(svgs).toHaveLength(16);
    let checked = 0;
    for (const svg of svgs) {
      for (const el of [svg, ...svg.querySelectorAll('[data-b]')]) {
        for (const binding of bindingsOf(el)) {
          expect(boundValue(vm, binding), `${el.localName} ${binding.target}:${binding.path}`).not.toBeNull();
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('GearArt: the markup is the reference markup', () => {
  for (const gear of GEAR_IDS) {
    for (const variant of VARIANTS) {
      it(`${gear} ${variant} matches the reference, element by element, at the mock defaults`, () => {
        const vm = viewModelFor();
        const state = stateOf({});
        expectSameMarkup(referenceArt(gear, variant), artAsParentRenders(gear, variant, state[gear], false), contextFor(vm, variant));
      });
    }
  }

  it('draws a whole screen of art as the reference does, in the mock defaults and the app defaults and with everything off or at an end', () => {
    const states: Array<Partial<ReferenceState>> = [
      {},
      APP_DEFAULTS,
      { off: ['difficulty', 'history', 'popularity', 'tempo', 'era'] },
      { difficulty: 0, history: 0, popularity: 0, tempo: 0, eras: [] },
      { difficulty: 100, history: 100, popularity: 100, tempo: 100, eras: [...ERA_IDS] },
      { difficulty: 100, history: 0, popularity: 100, tempo: 0, off: ['history', 'tempo'] },
    ];
    for (const patch of states) expect(differences(patch, ALL_PARTS)).toEqual([]);
  });

  it('draws both variants of every gear, strip on a 150x80 viewBox and tab on a 28x22 one, hidden from assistive tech', () => {
    for (const gear of GEAR_IDS) {
      const strip = art(gear, 'strip', 50, false);
      const tab = art(gear, 'tab', 50, false);
      expect(strip.localName).toBe('svg');
      expect(strip.getAttribute('viewBox')).toBe('0 0 150 80');
      expect(tab.getAttribute('viewBox')).toBe('0 0 28 22');
      for (const root of [strip, tab]) {
        expect(root.localName).toBe('svg');
        expect(root.getAttribute('aria-hidden')).toBe('true');
        expect(root.querySelectorAll('svg')).toHaveLength(0);
      }
      expect(strip.outerHTML).not.toBe(tab.outerHTML);
    }
  });

  it('keeps the structure whatever the value, and whether the gear is on or off', () => {
    // A tab's glow is its own matter (QWW-57, R7): which rays are in the filtered group follows the value, and the filter is there
    // only while the gear is on. `withoutTabGlow` is the tab drawn without that, which is the part that must not change.
    const shape = (root: Element, variant: GearArtVariant) => {
      const flat = variant === 'tab' ? withoutTabGlow(root) : root;
      return [flat, ...flat.querySelectorAll('*')].map((el) => el.localName).join(' ');
    };
    for (const gear of GEAR_IDS) {
      for (const variant of VARIANTS) {
        const shapes = new Set(VALUES.flatMap((value) => [false, true].map((off) => shape(art(gear, variant, value, off), variant))));
        expect(shapes.size, `${gear} ${variant}`).toBe(1);
      }
    }
  });
});

describe('GearArt: every value, on and off, is drawn as the reference draws it', () => {
  // The reference's view model is asked for each value; the walk expects the component to hold exactly what it gives. This
  // covers the pitch lane's band and dashes at every difficulty, the thresholds of the seven notes, bolts and rays, and the
  // Mood speaker's waves, thump and cone at every value of the Tempo gear.
  for (const gear of GEAR_IDS) {
    it(`${gear}, strip and tab, at every value from 0 to 100`, () => {
      const parts = VARIANTS.map((variant): Part => ({ gear, variant }));
      const problems: string[] = [];
      for (const value of VALUES) {
        for (const off of [false, true]) {
          const patch: Partial<ReferenceState> = { off: off ? [gear] : [] };
          patch[gear] = value;
          problems.push(...differences(patch, parts));
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('the Era tab, with no era, one, two, three and all seven picked, on and off', () => {
    const picks: EraId[][] = [[], ['s90'], ['s80', 's90'], ['s90', 's00', 's10'], [...ERA_IDS]];
    const problems: string[] = [];
    for (const eras of picks) {
      for (const off of [false, true]) problems.push(...differences({ eras, off: off ? ['era'] : [] }, [{ gear: 'era' }]));
    }
    expect(problems).toEqual([]);
  });
});

describe('GearArt: difficulty follows the value (the pitch lane)', () => {
  // The band is 14 + value x 0.62 high around y = 40 at 12%; the seven dashes are round-capped lines that spread with it.
  const DIFFICULTY = [
    { value: 0, color: COLOR.easy, bandY: '33', bandHeight: '14', dashY: ['43', '41', '36', '39', '44', '38', '36'] },
    { value: 30, color: COLOR.easy, bandY: '24', bandHeight: '33', dashY: ['51', '43', '27', '36', '53', '32', '28'] },
    { value: 60, color: '#FFC24A', bandY: '14', bandHeight: '51', dashY: ['58', '45', '17', '33', '63', '26', '20'] },
    { value: 100, color: COLOR.hard, bandY: '2', bandHeight: '76', dashY: ['68', '47', '5', '30', '75', '19', '9'] },
  ];

  for (const { value, color, bandY, bandHeight, dashY } of DIFFICULTY) {
    it(`strip at ${value}: band at y ${bandY}, ${bandHeight} high at 12%, and the dashes in ${color}`, () => {
      const root = art('difficulty', 'strip', value, false);
      const band = one(root, 'rect');
      expect(attrs(band, ['x', 'y', 'width', 'height', 'fill', 'fill-opacity'])).toEqual({
        x: '0',
        y: bandY,
        width: '150',
        height: bandHeight,
        fill: color,
        'fill-opacity': '0.12',
      });
      const dashes = all(root, 'g[filter] > line');
      expect(dashes).toHaveLength(7);
      expect(one(root, 'g[filter]').getAttribute('stroke')).toBe(color);
      expect(dashes.map((line) => [line.getAttribute('x1'), line.getAttribute('x2')])).toEqual([
        ['9', '22'],
        ['30', '36'],
        ['46', '62'],
        ['71', '77'],
        ['87', '97'],
        ['107', '115'],
        ['125', '141'],
      ]);
      // A dash is a horizontal line: both ends at one y.
      expect(dashes.map(attr('y1'))).toEqual(dashY);
      expect(dashes.map(attr('y2'))).toEqual(dashY);
    });

    it(`tab at ${value}: three dashes in ${color}, no band`, () => {
      const root = art('difficulty', 'tab', value, false);
      expect(styleOf(root).color).toBe(color);
      expect(root.getAttribute('stroke')).toBe('currentColor');
      expect(one(root, 'path').getAttribute('d')).toBe('M4 15 H9 M12 8 H17 M20 12 H25');
      expect(all(root, '*')).toHaveLength(1);
    });
  }

  it('hides the band and unlights the dashes while the gear is off, at the value it is given (README §7)', () => {
    const root = art('difficulty', 'strip', 0, true);
    expect(attrs(one(root, 'rect'), ['fill', 'fill-opacity', 'y', 'height'])).toEqual({
      fill: COLOR.unlit,
      'fill-opacity': '0',
      y: '33',
      height: '14',
    });
    expect(one(root, 'g[filter]').getAttribute('stroke')).toBe(COLOR.unlit);
  });
});

describe('GearArt: history notes and popularity bolts follow the value', () => {
  // Item i is lit once the value reaches (i + 0.5) x 100 / 7, so 50 lights the first four. The ones it does not reach are drawn
  // unlit, in full opacity, not hidden (QWW-57, R7): the drawing keeps its whole shape and only the lit items glow.
  const ITEMS = [
    { value: 0, lit: [false, false, false, false, false, false, false] },
    { value: 50, lit: [true, true, true, true, false, false, false] },
    { value: 100, lit: [true, true, true, true, true, true, true] },
  ];
  const NOTE_COLORS = [COLOR.cyan, COLOR.pink, COLOR.pink, COLOR.cyan, COLOR.cyan, COLOR.pink, COLOR.cyan];
  const BOLT_COLORS = Array(7).fill(COLOR.amber) as string[];
  /** What each item is drawn in: its colour while it is lit, the unlit tube's otherwise. */
  const drawnIn = (lit: boolean[], colors: string[]) => lit.map((on, i) => (on ? colors[i] : COLOR.unlit));

  for (const { value, lit } of ITEMS) {
    const marks = lit.map((on) => (on ? 'lit' : 'unlit')).join(' ');

    it(`history strip at ${value}: notes ${marks}`, () => {
      const root = art('history', 'strip', value, false);
      const notes = all(root, '[data-note]');
      expect(notes.map(attr('data-i'))).toEqual(INDEXES);
      expect(notes.map(attr('data-lit'))).toEqual(lit.map(String));
      // A note's colour is on the group inside the one that carries the hook.
      expect(all(root, '[data-note] > g').map(attr('fill'))).toEqual(drawnIn(lit, NOTE_COLORS));
    });

    it(`popularity strip at ${value}: bolts ${marks}`, () => {
      const root = art('popularity', 'strip', value, false);
      const bolts = all(root, '[data-bolt]');
      expect(bolts.map(attr('data-i'))).toEqual(INDEXES);
      expect(bolts.map(attr('data-lit'))).toEqual(lit.map(String));
      expect(all(root, '[data-bolt] > path').map(attr('fill'))).toEqual(drawnIn(lit, BOLT_COLORS));
    });

    for (const [gear, colors] of [
      ['history', NOTE_COLORS],
      ['popularity', BOLT_COLORS],
    ] as const) {
      it(`${gear} tab at ${value}: rays ${marks}`, () => {
        const rays = all(art(gear, 'tab', value, false), '[data-ray]');
        expect(rays.map(attr('data-i'))).toEqual(INDEXES);
        expect(rays.map(attr('data-lit'))).toEqual(lit.map(String));
        expect(rays.map(attr('stroke'))).toEqual(drawnIn(lit, colors));
      });
    }
  }

  const litCount = (els: Element[]) => els.filter((el) => el.getAttribute('data-lit') === 'true').length;

  it('lights five notes at 65 and six bolts at 80, the mock defaults, on the strip and as rays on the tab, and draws the rest unlit (README test 26)', () => {
    for (const [els, lit] of [
      [all(art('history', 'strip', 65, false), '[data-note]'), 5],
      [all(art('popularity', 'strip', 80, false), '[data-bolt]'), 6],
      [all(art('history', 'tab', 65, false), '[data-ray]'), 5],
      [all(art('popularity', 'tab', 80, false), '[data-ray]'), 6],
    ] as const) {
      expect(els).toHaveLength(7);
      expect(litCount(els)).toBe(lit);
    }
  });

  it('Popularity on at 30 lights 2 bolts and 2 rays in amber and draws 5 of each in the unlit colour; History on at 65 lights 5 notes and leaves 2 unlit (R7)', () => {
    const strip = art('popularity', 'strip', 30, false);
    const tab = art('popularity', 'tab', 30, false);
    expect(all(strip, '[data-bolt] > path').map(attr('fill'))).toEqual([COLOR.amber, COLOR.amber, ...Array(5).fill(COLOR.unlit)]);
    expect(all(tab, '[data-ray]').map(attr('stroke'))).toEqual([COLOR.amber, COLOR.amber, ...Array(5).fill(COLOR.unlit)]);
    const notes = all(art('history', 'strip', 65, false), '[data-note]');
    expect(litCount(notes)).toBe(5);
    expect(notes.filter((el) => el.getAttribute('data-lit') === 'false').map(attr('data-i'))).toEqual(['5', '6']);
  });

  it('draws every note, bolt and ray whatever the value, in full opacity: only data-lit and the colour change, and the strip ones keep the fade', () => {
    // The markup of an item with its lit state and its colour taken out.
    const sameShape = (el: Element) =>
      el.outerHTML.replace(/data-lit="(true|false)"/g, 'data-lit="_"').replace(/(fill|stroke)="#[0-9A-Fa-f]{6}"/g, '$1="_"');
    for (const [gear, variant, hookSelector] of [
      ['history', 'strip', '[data-note]'],
      ['popularity', 'strip', '[data-bolt]'],
      ['history', 'tab', '[data-ray]'],
      ['popularity', 'tab', '[data-ray]'],
    ] as const) {
      const unlit = all(art(gear, variant, 0, false), hookSelector);
      const lit = all(art(gear, variant, 100, false), hookSelector);
      expect(unlit, `${gear} ${variant}`).toHaveLength(7);
      expect(unlit.map(sameShape), `${gear} ${variant}`).toEqual(lit.map(sameShape));
      // Nothing is hidden: no opacity on the hook or anything inside it, lit or not.
      for (const el of [...unlit, ...lit]) {
        expect(el.outerHTML, `${gear} ${variant}`).not.toMatch(/opacity/);
      }
      // Only the strip's notes and bolts fade (the colour, over 180 ms, in the CSS); the reference's rays do not.
      const classes = unlit.map((el) => classTokens(el).map(moduleName));
      expect(classes, `${gear} ${variant}`).toEqual(Array(7).fill(variant === 'strip' ? ['fade'] : []));
    }
  });

  it('bobs the notes and the bolts on the strip only, each with its own delay', () => {
    const delays = (gear: 'history' | 'popularity', variant: GearArtVariant) =>
      all(art(gear, variant, 50, false), '*')
        .filter((el) => classTokens(el).map(moduleName).includes('bob'))
        .map((el) => styleOf(el)['animation-delay']);
    expect(delays('history', 'strip')).toEqual([undefined, '0.2s', '0.4s', '0.1s', '0.3s', '0.5s', '0.6s']);
    expect(delays('popularity', 'strip')).toEqual([undefined, '0.1s', '0.2s', '0.3s', '0.4s', '0.5s', '0.6s']);
    expect(delays('history', 'tab')).toEqual([]);
    expect(delays('popularity', 'tab')).toEqual([]);
  });
});

describe('GearArt: tempo follows the value (the Mood speaker, Round 7 §4, §5)', () => {
  /** How many arcs show on each side: the inner pair always, the others while their opacity is 1. */
  const wavesPerSide = (root: Element) => {
    const shown = all(root, '[data-wave]').filter((el) => styleOf(el).opacity !== '0');
    const right = shown.filter((el) => / 0 0 1 /.test(el.getAttribute('d') ?? '')).length;
    const left = shown.filter((el) => / 0 0 0 /.test(el.getAttribute('d') ?? '')).length;
    expect(left, 'as many arcs on the left as on the right').toBe(right);
    return right;
  };
  const thump = (root: Element) => styleOf(one(root, '[data-thump]')).animation;
  const cone = (root: Element) => one(root, '[data-cone]').getAttribute('r');

  // README test 33 and the brief's check: 1, 2 and 3 waves a side, thump4, thump8 and thump12, in the strip and the tab.
  const ZONES = [
    { value: 20, waves: 1, animation: 'thump4 1.18s ease-in-out infinite', coneR: '10.6', tabConeR: '1.82' },
    { value: 50, waves: 2, animation: 'thump8 0.85s ease-in-out infinite', coneR: '11.5', tabConeR: '2.00' },
    { value: 80, waves: 3, animation: 'thump12 0.52s ease-in-out infinite', coneR: '12.4', tabConeR: '2.18' },
  ];
  for (const { value, waves, animation, coneR, tabConeR } of ZONES) {
    it(`at ${value}: ${waves} wave(s) a side and ${animation}, strip and tab`, () => {
      const strip = art('tempo', 'strip', value, false);
      const tab = art('tempo', 'tab', value, false);
      expect(wavesPerSide(strip)).toBe(waves);
      expect(wavesPerSide(tab)).toBe(waves);
      expect(thump(strip)).toBe(animation);
      expect(thump(tab)).toBe(animation);
      expect(cone(strip)).toBe(coneR);
      expect(cone(tab)).toBe(tabConeR);
    });
  }

  it('at 80 the tab cone has the strip cone\'s animation, thump12 at 0.52 s, and r 2.18 (README test 28)', () => {
    const strip = art('tempo', 'strip', 80, false);
    const tab = art('tempo', 'tab', 80, false);
    expect(thump(strip)).toBe('thump12 0.52s ease-in-out infinite');
    expect(thump(tab)).toBe(thump(strip));
    expect(cone(tab)).toBe('2.18');
  });

  it('grows the strip cone from r 10.0 at 0 to 13.0 at 100 (README test 34)', () => {
    expect(cone(art('tempo', 'strip', 0, false))).toBe('10.0');
    expect(cone(art('tempo', 'strip', 100, false))).toBe('13.0');
  });

  it('adds a wave pair at each zone\'s edge: 33 and 34, 66 and 67', () => {
    for (const variant of VARIANTS) {
      expect([33, 34, 66, 67].map((v) => wavesPerSide(art('tempo', variant, v, false))), variant).toEqual([1, 2, 2, 3]);
    }
  });

  it('fades the strip\'s middle and outer arcs, and only those; the tab\'s arcs have no fade, as in the reference', () => {
    const faded = (root: Element) => all(root, '[data-wave]').map((el) => classTokens(el).map(moduleName).join(' '));
    expect(faded(art('tempo', 'strip', 50, false))).toEqual(['', '', 'fade', 'fade', 'fade', 'fade']);
    expect(faded(art('tempo', 'tab', 50, false))).toEqual(['', '', '', '', '', '']);
  });

  it('thumps each cone around its own centre, the strip\'s and the tab\'s', () => {
    expect(classTokens(one(art('tempo', 'strip', 50, false), '[data-thump]')).map(moduleName)).toEqual(['thump']);
    expect(classTokens(one(art('tempo', 'tab', 50, false), '[data-thump]')).map(moduleName)).toEqual(['thumpTab']);
  });

  it('draws what speaker() in art.ts gives, at every value', () => {
    for (const value of VALUES) {
      const spk = speaker(value);
      expect(thump(art('tempo', 'strip', value, false)), `at ${value}`).toBe(spk.animation);
      expect(cone(art('tempo', 'strip', value, false)), `at ${value}`).toBe(spk.coneR);
      expect(cone(art('tempo', 'tab', value, false)), `at ${value}`).toBe(spk.tabConeR);
    }
  });
});

describe('EraTabArt: the jukebox (README §9, test 27; QWW-57, R24)', () => {
  const jukebox = (eras: EraId[], off: boolean) => {
    const root = eraTab(eras, off);
    return {
      body: root.getAttribute('stroke'),
      buttons: all(root, '[data-jukebox="button"]').map(attr('fill')),
      glow: styleOf(root).filter,
    };
  };

  const { pink, amber, unlit } = COLOR;
  // The buttons are left, middle, right: before the '90s, the '90s, after them. One case for each row of R24's table (all 21 pairs
  // are in art.test.ts); a button is amber where the picked eras light it and the unlit grey where they do not.
  const CASES: Array<{ name: string; eras: EraId[]; off: boolean; body: string; buttons: string[] }> = [
    { name: "the '90s alone: the middle button", eras: ['s90'], off: false, body: pink, buttons: [unlit, amber, unlit] },
    { name: "the '80s alone: the left button", eras: ['s80'], off: false, body: pink, buttons: [amber, unlit, unlit] },
    { name: "the '10s alone: the right button", eras: ['s10'], off: false, body: pink, buttons: [unlit, unlit, amber] },
    { name: "the '70s and the '00s, one before and one after: left and right", eras: ['s70', 's00'], off: false, body: pink, buttons: [amber, unlit, amber] },
    { name: "the '70s and the '80s, both before the '90s: left and middle", eras: ['s70', 's80'], off: false, body: pink, buttons: [amber, amber, unlit] },
    { name: "the '80s and the '90s, both the '90s or earlier: left and middle", eras: ['s80', 's90'], off: false, body: pink, buttons: [amber, amber, unlit] },
    { name: "the '90s and the '00s, both the '90s or later: middle and right", eras: ['s90', 's00'], off: false, body: pink, buttons: [unlit, amber, amber] },
    { name: "the '10s and the '20s, both after the '90s: middle and right", eras: ['s10', 's20'], off: false, body: pink, buttons: [unlit, amber, amber] },
    { name: 'three eras: all three', eras: ['s90', 's00', 's10'], off: false, body: pink, buttons: [amber, amber, amber] },
    { name: 'all seven eras: all three', eras: [...ERA_IDS], off: false, body: pink, buttons: [amber, amber, amber] },
    { name: 'Era on and none picked: body pink, no button lit', eras: [], off: false, body: pink, buttons: [unlit, unlit, unlit] },
    { name: 'Era off with nothing parked (every gear reset): body unlit, all three buttons unlit', eras: [], off: true, body: unlit, buttons: [unlit, unlit, unlit] },
    { name: 'Era off with picks parked: body unlit, all three buttons unlit, none lit', eras: ['s90', 's00', 's10'], off: true, body: unlit, buttons: [unlit, unlit, unlit] },
  ];

  for (const { name, eras, off, body, buttons } of CASES) {
    it(name, () => {
      expect(jukebox(eras, off)).toEqual({ body, buttons, glow: off ? 'none' : `drop-shadow(0 0 3px ${COLOR.pink})` });
    });
  }

  it('matches the reference Era tab art but for its buttons, element by element, whatever is picked and whether Era is on or off', () => {
    const picks: EraId[][] = [[], ['s90'], ['s20', 'pre'], ['s90', 's00', 's10'], [...ERA_IDS]];
    for (const eras of picks) {
      for (const off of [false, true]) {
        const vm = viewModelFor({ eras, off: off ? ['era'] : [] });
        expectSameMarkup(withoutJukeboxButtons(referenceEraTab()), withoutJukeboxButtons(eraTab(eras, off)), contextFor(vm, 'tab'));
      }
    }
  });

  it('is one svg on a 28x22 viewBox, 34x27 on screen, hidden from assistive tech', () => {
    const root = eraTab([], false);
    expect(root.localName).toBe('svg');
    expect(attrs(root, ['viewBox', 'width', 'height', 'aria-hidden'])).toEqual({
      viewBox: '0 0 28 22',
      width: '34',
      height: '27',
      'aria-hidden': 'true',
    });
  });

  it('has one body path and three button circles, left to right, marked for the browser tests', () => {
    const root = eraTab(['s90'], false);
    expect(all(root, '[data-jukebox]').map((el) => [el.localName, el.getAttribute('data-jukebox'), el.getAttribute('data-i')])).toEqual([
      ['path', 'body', null],
      ['circle', 'button', '0'],
      ['circle', 'button', '1'],
      ['circle', 'button', '2'],
    ]);
    expect(all(root, '[data-i]')).toHaveLength(3);
  });

  it("draws the three buttons in the style of the reference's two: its radius and height, in a row centred on the body, inside the window", () => {
    const buttons = all(eraTab(['s90'], false), '[data-jukebox="button"]');
    const reference = all(referenceEraTab(), 'circle');
    expect(reference).toHaveLength(2);
    for (const button of buttons) {
      expect(attrs(button, ['cy', 'r', 'stroke'])).toEqual({ cy: reference[0]?.getAttribute('cy'), r: reference[0]?.getAttribute('r'), stroke: 'none' });
    }
    const cx = buttons.map((button) => Number(button.getAttribute('cx')));
    const r = Number(buttons[0]?.getAttribute('r'));
    expect(cx).toEqual([8, 14, 20]);
    // The body's arch runs from x 3 to 25, so its middle is 14: the middle button is on it, the outer two as far each side.
    expect(cx[1]).toBe(14);
    expect(cx[1]! - cx[0]!).toBe(cx[2]! - cx[1]!);
    // The window runs from x 6.2 to 21.8: the outer buttons are inside it, and each gap between buttons is at least 2 units.
    expect(cx[0]! - r).toBeGreaterThanOrEqual(6.2);
    expect(cx[2]! + r).toBeLessThanOrEqual(21.8);
    expect(cx[1]! - cx[0]! - 2 * r).toBeGreaterThanOrEqual(2);
  });

  it('puts the parent className on the root svg', () => {
    expect(classTokens(eraTab([], false, 'probe'))).toEqual(['probe']);
    expect(eraTab([], false).hasAttribute('class')).toBe(false);
  });
});

describe('EraIcon', () => {
  it.each(ERA_IDS)('%s matches the icon in the reference era button, element by element', (era) => {
    // The glow is the era button's: its CSS draws the lit drop-shadow, so the icon must not set a filter of its own.
    expectSameMarkup(referenceEraIcon(era), eraIcon(era), contextFor(viewModelFor(), 'era-icon'));
  });

  it('draws a different neon outline for each of the seven eras, 22x22 on a 30x30 grid, in the text colour', () => {
    const icons = ERA_IDS.map(eraIcon);
    expect(new Set(icons.map((icon) => icon.outerHTML)).size).toBe(7);
    for (const icon of icons) {
      expect(attrs(icon, ['width', 'height', 'viewBox', 'fill', 'stroke', 'aria-hidden'])).toEqual({
        width: '22',
        height: '22',
        viewBox: '0 0 30 30',
        fill: 'none',
        stroke: 'currentColor',
        'aria-hidden': 'true',
      });
      expect(icon.hasAttribute('style')).toBe(false);
      expect(icon.hasAttribute('class')).toBe(false);
    }
  });

  it('has no colour of its own: every stroke and fill is currentColor or none, so the era button sets the colour', () => {
    for (const era of ERA_IDS) {
      const icon = eraIcon(era);
      expect(icon.getAttribute('stroke'), era).toBe('currentColor');
      expect(paints(icon), era).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The off state and the colours (README §3.1, §7)

describe('GearArt: an off gear is a switched-off sign (README §7, test 25)', () => {
  it('draws every tube of an off gear, strip and tab, in the unlit colour', () => {
    for (const gear of GEAR_IDS) {
      for (const variant of VARIANTS) {
        expect(paints(art(gear, variant, 50, true)), `${gear} ${variant}`).toEqual([COLOR.unlit]);
      }
    }
    // The jukebox's three buttons are the unlit grey too, with nothing of 6A's dark rose left (R24).
    expect(paints(eraTab(['s90'], true))).toEqual([COLOR.unlit]);
  });

  it('lights none of an off gear\'s notes, bolts and rays, whatever the value: all seven are drawn, unlit (R7)', () => {
    for (const [gear, variant, selector] of [
      ['history', 'strip', '[data-note]'],
      ['popularity', 'strip', '[data-bolt]'],
      ['history', 'tab', '[data-ray]'],
      ['popularity', 'tab', '[data-ray]'],
    ] as const) {
      for (const value of [0, 50, 100]) {
        const root = art(gear, variant, value, true);
        const hooks = all(root, selector);
        expect(hooks.map(attr('data-lit')), `${gear} ${variant} at ${value}`).toEqual(Array(7).fill('false'));
        expect(paints(root), `${gear} ${variant} at ${value}`).toEqual([COLOR.unlit]);
      }
    }
  });

  it('stills the speaker: a reset Tempo (Mood) has unlit strokes and a cone with no animation, drawn at the default with 2 waves a side, strip and tab', () => {
    // The app's default is 50 (QWW-47); the README's mock default is 45. Both are Feel-good, so 2 waves a side either way.
    expect(DEFAULTS.tempo).toBe(50);
    for (const variant of VARIANTS) {
      const root = art('tempo', variant, DEFAULTS.tempo, true);
      expect(paints(root), variant).toEqual([COLOR.unlit]);
      expect(styleOf(one(root, '[data-thump]')).animation, variant).toBe('none');
      // It still has the shape its value gives it.
      const shown = all(root, '[data-wave]').filter((el) => styleOf(el).opacity !== '0');
      expect(shown, variant).toHaveLength(4);
      expect(one(root, '[data-cone]').getAttribute('r'), variant).toBe(variant === 'strip' ? '11.5' : '2.00');
    }
  });

  it('puts no glow on an off tab icon and no flicker on an off strip', () => {
    for (const gear of GEAR_IDS) {
      // Difficulty and Tempo say `none` on the root; History and Popularity have no filter at all (R7: see the tab glow tests).
      expect(styleOf(art(gear, 'tab', 50, true)).filter, gear).toBe(gear === 'history' || gear === 'popularity' ? undefined : 'none');
      expect(filtersIn(art(gear, 'tab', 50, true)), gear).toEqual([]);
      expect(styleOf(art(gear, 'strip', 50, true)).animation, gear).toBe('none');
    }
    expect(styleOf(eraTab(['s90'], true)).filter).toBe('none');
  });
});

describe('GearArt: a lit gear is drawn in its colours (README §3.1, §6, §9)', () => {
  it('Difficulty is its tier colour: green below 34, amber below 67, pink-red from there, strip and tab', () => {
    const tiers: Array<[number, string]> = [
      [0, COLOR.easy],
      [33, COLOR.easy],
      [34, COLOR.amber],
      [66, COLOR.amber],
      [67, COLOR.hard],
      [100, COLOR.hard],
    ];
    for (const [value, color] of tiers) {
      for (const variant of VARIANTS) {
        expect(paints(art('difficulty', variant, value, false)), `${variant} at ${value}`).toEqual([color]);
      }
    }
  });

  it("History has cyan headphones, and notes in the reference order, pink and cyan; the tab's rays follow the notes", () => {
    const { cyan, pink } = COLOR;
    const order = [cyan, pink, pink, cyan, cyan, pink, cyan];

    const strip = art('history', 'strip', 100, false);
    // The headband and both muffs, with the button line inside the left one, are cyan and nothing else.
    const headphones = all(strip, 'g[filter] > path, g[filter] > g[transform^="rotate"]');
    expect(headphones).toHaveLength(3);
    expect(headphones.map(attr('stroke'))).toEqual([cyan, cyan, cyan]);
    expect(all(strip, '[data-note] > g').map(attr('fill'))).toEqual(order);
    expect(paints(strip)).toEqual([cyan, pink].sort());

    const tab = art('history', 'tab', 100, false);
    // The first group with a stroke is the headphones: the group around them, which names the glow, has none.
    expect(one(tab, 'g[stroke]').getAttribute('stroke')).toBe(cyan);
    expect(all(tab, '[data-ray]').map(attr('stroke'))).toEqual(order);
    expect(paints(tab)).toEqual([cyan, pink].sort());
  });

  it('Popularity has a pink mic and amber bolts, and amber rays on the tab', () => {
    const { pink, amber } = COLOR;
    const strip = art('popularity', 'strip', 100, false);
    expect(one(strip, 'g[transform^="translate(75 44)"]').getAttribute('stroke')).toBe(pink);
    expect(all(strip, '[data-bolt] > path').map(attr('fill'))).toEqual(Array(7).fill(amber));
    expect(paints(strip)).toEqual([pink, amber].sort());

    const tab = art('popularity', 'tab', 100, false);
    expect(one(tab, 'g[transform^="rotate(-16"]').getAttribute('stroke')).toBe(pink);
    expect(all(tab, '[data-ray]').map(attr('stroke'))).toEqual(Array(7).fill(amber));
    expect(paints(tab)).toEqual([pink, amber].sort());
  });

  it('Tempo is violet, strip and tab', () => {
    for (const variant of VARIANTS) expect(paints(art('tempo', variant, 50, false)), variant).toEqual([COLOR.violet]);
  });

  it('Era is a pink jukebox with amber lights, and the unlit grey for a button that is not lit (R24)', () => {
    expect(paints(eraTab(['s90', 's00'], false))).toEqual([COLOR.pink, COLOR.amber, COLOR.unlit].sort());
    // Every button lit, nothing is left grey.
    expect(paints(eraTab(['s90', 's00', 's10'], false))).toEqual([COLOR.pink, COLOR.amber].sort());
  });

  it('glows a lit Difficulty, Tempo or Era tab icon with a 3 px drop-shadow in its gear colour on its root (README §7, §9)', () => {
    // History's and Popularity's glow is not on the root: it reaches only what is lit (R7, the tab glow tests below).
    const glow = (root: Element) => styleOf(root).filter;
    expect(glow(art('difficulty', 'tab', 20, false))).toBe(`drop-shadow(0 0 3px ${COLOR.easy})`);
    expect(glow(art('difficulty', 'tab', 50, false))).toBe(`drop-shadow(0 0 3px ${COLOR.amber})`);
    expect(glow(art('difficulty', 'tab', 90, false))).toBe(`drop-shadow(0 0 3px ${COLOR.hard})`);
    expect(glow(art('tempo', 'tab', 50, false))).toBe(`drop-shadow(0 0 3px ${COLOR.violet})`);
    expect(glow(eraTab(['s90'], false))).toBe(`drop-shadow(0 0 3px ${COLOR.pink})`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The flicker (README §7, test 29)

describe('GearArt: the turn-on flicker (README §7, test 29)', () => {
  it('is an inline neonOn animation on the strip root, once for 0.7 s, linear; none while the gear is off', () => {
    for (const gear of GEAR_IDS) {
      expect(styleProp('animation')(art(gear, 'strip', 50, false)), gear).toBe('neonOn 0.7s linear 1');
      expect(styleProp('animation')(art(gear, 'strip', 50, true)), gear).toBe('none');
    }
    expect(neonFlicker(false, true)).toBe('neonOn 0.7s linear 1');
  });

  it('is not on a tab icon: its root carries a glow (not History\'s or Popularity\'s, R7), and for Difficulty a colour, and no animation', () => {
    const styled: Record<GearId, string[]> = { difficulty: ['color', 'filter'], history: [], popularity: [], tempo: ['filter'] };
    for (const gear of GEAR_IDS) {
      const style = styleOf(art(gear, 'tab', 50, false));
      expect(Object.keys(style).sort(), gear).toEqual(styled[gear]);
    }
    expect(Object.keys(styleOf(eraTab(['s90'], false)))).toEqual(['filter']);
  });

  it('plays on first load and each time the gear goes from off to on, and is left alone when only the value changes', () => {
    const draw = (value: number, off: boolean) => <GearArt gear="tempo" variant="strip" value={value} off={off} />;
    const view = render(draw(50, false));
    const svg = must(view.container.querySelector('svg'), 'the strip svg');
    const animation = () => styleOf(svg).animation;

    // First load: the animation is there from the first paint.
    expect(animation()).toBe('neonOn 0.7s linear 1');

    // A browser restarts an animation when its `animation` style is written with a different value, and not otherwise.
    const observer = new MutationObserver(() => {});
    observer.observe(svg, { attributes: true, attributeFilter: ['style'] });
    const writes = () => observer.takeRecords().length;

    view.rerender(draw(60, false));
    expect(writes(), 'a new value, still on').toBe(0);
    view.rerender(draw(61, false));
    expect(writes(), 'another new value').toBe(0);

    view.rerender(draw(61, true));
    expect(writes(), 'reset').toBeGreaterThan(0);
    expect(animation()).toBe('none');

    view.rerender(draw(62, true));
    expect(writes(), 'a value change while off').toBe(0);
    view.rerender(draw(62, false));
    expect(writes(), 'turned back on').toBeGreaterThan(0);
    expect(animation()).toBe('neonOn 0.7s linear 1');

    // The same svg throughout: it was updated, not replaced.
    expect(view.container.querySelector('svg')).toBe(svg);
    observer.disconnect();
  });
});

// QWW-57, adversarial review of PR #38, the flicker finding: it played whenever a strip was shown, not only on first load and on a
// turn-on. A strip is not drawn again when the singer switches tab or expands the sheet (it is hidden and shown, and a browser plays
// an animation again each time its element is shown), so the style must be gone once the flicker has played: tests/e2e/setlist-flicker.spec.ts
// has that in a browser. What is checked here is the part that does not need one: when the art says `neonOn` and when it says `none`.
describe('GearArt: the flicker plays on first load and on a turn-on, and at no other time (PR 38 review)', () => {
  const NEON = 'neonOn 0.7s linear 1';
  const draw = (gear: GearId, off: boolean, value = 50) => <GearArt key={gear} gear={gear} variant="strip" value={value} off={off} />;
  const rootOf = (container: HTMLElement) => must(container.querySelector('svg'), 'the strip svg');
  const animation = (svg: Element) => styleOf(svg).animation;
  const elapse = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  /** Not the first load: a strip has been drawn on this page already. */
  const notFirstLoad = () => {
    flickerSession.done = true;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('plays on first load for every strip of the first commit that is on, whichever gear, and not for one that is off', () => {
    const { container } = render(
      <>
        {GEAR_IDS.map((gear) => (
          <GearArt key={gear} gear={gear} variant="strip" value={50} off={gear === 'tempo'} />
        ))}
      </>,
    );
    expect(GEAR_IDS).toEqual(['difficulty', 'history', 'popularity', 'tempo']);
    expect([...container.querySelectorAll('svg')].map(animation)).toEqual([NEON, NEON, NEON, 'none']);
  });

  it('plays for each of them in React StrictMode too, which renders twice and runs its effects twice before anything is on screen', () => {
    const { container } = render(
      <StrictMode>
        <GearArt gear="difficulty" variant="strip" value={50} off={false} />
        <GearArt gear="popularity" variant="strip" value={50} off={false} />
      </StrictMode>,
    );
    expect([...container.querySelectorAll('svg')].map(animation)).toEqual([NEON, NEON]);
    expect(flickerSession.done).toBe(true);
    elapse(FLICKER_MS);
    expect([...container.querySelectorAll('svg')].map(animation)).toEqual(['none', 'none']);
  });

  it('does not play for a strip drawn after the first load: coming back from a song, or doing the singing test again', () => {
    const first = render(draw('tempo', false));
    expect(animation(rootOf(first.container))).toBe(NEON);
    expect(flickerSession.done).toBe(true);
    first.unmount();
    // The sheet is drawn again, at once, in whatever mode: the same art, on, a moment after the first one went.
    const again = render(<>{GEAR_IDS.map((gear) => draw(gear, false))}</>);
    expect([...again.container.querySelectorAll('svg')].map(animation)).toEqual(['none', 'none', 'none', 'none']);
  });

  it('does not play for a second strip drawn beside one that is still flickering, if it is not drawn in the same commit', () => {
    const first = render(draw('difficulty', false));
    const second = render(draw('popularity', false));
    expect(animation(rootOf(first.container))).toBe(NEON);
    expect(animation(rootOf(second.container))).toBe('none');
  });

  it('plays when a gear that was drawn off goes on, on the first load and after it', () => {
    for (const firstLoad of [true, false]) {
      resetFlickerSession();
      if (!firstLoad) notFirstLoad();
      const view = render(draw('tempo', true));
      const svg = rootOf(view.container);
      expect(animation(svg), `drawn off, first load ${firstLoad}`).toBe('none');
      view.rerender(draw('tempo', false));
      expect(animation(svg), `turned on, first load ${firstLoad}`).toBe(NEON);
      cleanup();
    }
  });

  it('is over after 0.7 s: the style goes back to none, so showing the strip again does not play it again', () => {
    const view = render(draw('tempo', false));
    const svg = rootOf(view.container);
    elapse(FLICKER_MS - 1);
    expect(animation(svg)).toBe(NEON);
    elapse(1);
    expect(animation(svg)).toBe('none');
    // Nothing brings it back: not a new value, not another render, not more time. A strip that was hidden at first load (the mini
    // sheet's other three) is in the same case: no one saw it play, and it is not due once its 0.7 s have passed.
    view.rerender(draw('tempo', false, 70));
    elapse(5000);
    expect(animation(svg)).toBe('none');
  });

  it('plays again each time the gear goes from off to on, and is left alone while only its value changes', () => {
    const view = render(draw('tempo', false));
    const svg = rootOf(view.container);
    elapse(FLICKER_MS);
    expect(animation(svg)).toBe('none');
    for (const value of [51, 52, 53]) {
      view.rerender(draw('tempo', true, value));
      expect(animation(svg), `reset at ${value}`).toBe('none');
      view.rerender(draw('tempo', false, value));
      expect(animation(svg), `on at ${value}`).toBe(NEON);
      elapse(FLICKER_MS - 1);
      view.rerender(draw('tempo', false, value + 10));
      expect(animation(svg), `a new value inside the flicker, at ${value}`).toBe(NEON);
      elapse(1);
      expect(animation(svg), `over, at ${value}`).toBe('none');
    }
  });

  it('restarts for a gear turned off and on again inside the flicker, and gives the new one its whole 0.7 s', () => {
    const view = render(draw('tempo', false));
    const svg = rootOf(view.container);
    elapse(300);
    view.rerender(draw('tempo', true));
    expect(animation(svg)).toBe('none');
    elapse(100);
    view.rerender(draw('tempo', false));
    expect(animation(svg)).toBe(NEON);
    // 300 + 100 + 699 ms: past the end of the first flicker, which the reset ended, and inside the second.
    elapse(FLICKER_MS - 1);
    expect(animation(svg)).toBe(NEON);
    elapse(1);
    expect(animation(svg)).toBe('none');
  });

  it('keeps no timer while the gear is off or once the flicker is over, and none after the art is removed', () => {
    const none = vi.getTimerCount();
    const off = render(draw('tempo', true));
    expect(vi.getTimerCount() - none, 'off').toBe(0);
    off.unmount();
    notFirstLoad();
    const afterFirstLoad = render(draw('tempo', false));
    expect(vi.getTimerCount() - none, 'on, not due').toBe(0);
    afterFirstLoad.unmount();
    resetFlickerSession();
    const on = render(draw('tempo', false));
    expect(vi.getTimerCount() - none, 'on, due').toBe(1);
    elapse(FLICKER_MS);
    expect(vi.getTimerCount() - none, 'over').toBe(0);
    on.rerender(draw('tempo', true));
    on.rerender(draw('tempo', false));
    expect(vi.getTimerCount() - none, 'on again').toBe(1);
    on.unmount();
    expect(vi.getTimerCount() - none, 'removed').toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The hooks, and what the parent owns

describe('GearArt: the hooks the browser tests use', () => {
  const counts = (root: Element) => ({
    notes: all(root, '[data-note]').length,
    bolts: all(root, '[data-bolt]').length,
    rays: all(root, '[data-ray]').length,
    thumps: all(root, '[data-thump]').length,
    cones: all(root, '[data-cone]').length,
    waves: all(root, '[data-wave]').length,
    jukebox: all(root, '[data-jukebox]').length,
    indexed: all(root, '[data-i]').length,
    lit: all(root, '[data-lit]').length,
  });
  const NONE = { notes: 0, bolts: 0, rays: 0, thumps: 0, cones: 0, waves: 0, jukebox: 0, indexed: 0, lit: 0 };

  it('puts each hook on its own part and nowhere else', () => {
    expect(counts(art('difficulty', 'strip', 50, false))).toEqual(NONE);
    expect(counts(art('difficulty', 'tab', 50, false))).toEqual(NONE);
    expect(counts(art('history', 'strip', 50, false))).toEqual({ ...NONE, notes: 7, indexed: 7, lit: 7 });
    expect(counts(art('history', 'tab', 50, false))).toEqual({ ...NONE, rays: 7, indexed: 7, lit: 7 });
    expect(counts(art('popularity', 'strip', 50, false))).toEqual({ ...NONE, bolts: 7, indexed: 7, lit: 7 });
    expect(counts(art('popularity', 'tab', 50, false))).toEqual({ ...NONE, rays: 7, indexed: 7, lit: 7 });
    for (const variant of VARIANTS) {
      expect(counts(art('tempo', variant, 50, false)), variant).toEqual({ ...NONE, thumps: 1, cones: 1, waves: 6 });
    }
    expect(counts(eraTab([], false))).toEqual({ ...NONE, jukebox: 4, indexed: 3 });
  });

  it('puts them on the elements the tests read: notes and bolts on their group, rays on their path, the speaker\'s thump on its group, its cone and arcs on their own shapes', () => {
    const tags = (root: Element, selector: string) => [...new Set(all(root, selector).map((el) => el.localName))];
    expect(tags(art('history', 'strip', 50, false), '[data-note]')).toEqual(['g']);
    expect(tags(art('popularity', 'strip', 50, false), '[data-bolt]')).toEqual(['g']);
    for (const gear of ['history', 'popularity'] as const) {
      expect(tags(art(gear, 'tab', 50, false), '[data-ray]'), gear).toEqual(['path']);
    }
    for (const variant of VARIANTS) {
      expect(tags(art('tempo', variant, 50, false), '[data-thump]'), variant).toEqual(['g']);
      expect(tags(art('tempo', variant, 50, false), '[data-cone]'), variant).toEqual(['circle']);
      expect(tags(art('tempo', variant, 50, false), '[data-wave]'), variant).toEqual(['path']);
    }
  });

  it('says on the element that carries the hook whether a note, bolt or ray is lit (data-lit), and puts no opacity on it (R7)', () => {
    for (const [gear, variant, selector] of [
      ['history', 'strip', '[data-note]'],
      ['popularity', 'strip', '[data-bolt]'],
      ['history', 'tab', '[data-ray]'],
      ['popularity', 'tab', '[data-ray]'],
    ] as const) {
      const hooks = all(art(gear, variant, 50, false), selector);
      expect(hooks.map(attr('data-lit')), `${gear} ${variant}`).toEqual(['true', 'true', 'true', 'true', 'false', 'false', 'false']);
      for (const el of hooks) expect(styleOf(el).opacity, `${gear} ${variant}`).toBeUndefined();
    }
  });
});

describe('GearArt: what the parent owns', () => {
  it("leaves the strip art's size, corner radius and box to the parent: no width, height or background of its own", () => {
    for (const gear of GEAR_IDS) {
      for (const off of [false, true]) {
        const root = art(gear, 'strip', 50, off);
        expect(root.hasAttribute('width') || root.hasAttribute('height'), gear).toBe(false);
        // The one thing it styles itself is the flicker.
        expect(Object.keys(styleOf(root)), gear).toEqual(['animation']);
        expect(classTokens(root).map(moduleName), gear).toEqual(['flick']);
      }
    }
  });

  it('brings its own size to a tab icon: 34x27 on screen', () => {
    for (const gear of GEAR_IDS) {
      expect(attrs(art(gear, 'tab', 50, false), ['width', 'height']), gear).toEqual({ width: '34', height: '27' });
    }
  });

  it("puts the parent's className on the root svg, after the art's own", () => {
    for (const gear of GEAR_IDS) {
      expect(classTokens(art(gear, 'strip', 50, false, 'probe')).map(moduleName), gear).toEqual(['flick', 'probe']);
      expect(classTokens(art(gear, 'tab', 50, false, 'probe')), gear).toEqual(['probe']);
      expect(art(gear, 'tab', 50, false).hasAttribute('class'), gear).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Decorative, and the glow filter

describe('every root svg is decorative', () => {
  it("has aria-hidden, no role, title or text, and no id except a strip's glow filter and a lit History or Popularity tab's", () => {
    const roots = everyRoot();
    expect(roots).toHaveLength(GEAR_IDS.length * VARIANTS.length + 1 + ERA_IDS.length);
    for (const [name, root] of roots) {
      expect(root.getAttribute('aria-hidden'), name).toBe('true');
      expect(root.hasAttribute('id') || root.hasAttribute('role'), name).toBe(false);
      expect(root.querySelectorAll('[role], title, desc'), name).toHaveLength(0);
      const filtered = name.endsWith('strip') || name === 'history tab' || name === 'popularity tab';
      expect(root.querySelectorAll('[id]'), name).toHaveLength(filtered ? 1 : 0);
      expect(root.textContent, name).toBe('');
    }
  });
});

describe('the glow filter on the strips (README §6)', () => {
  it('blurs the art by 2 and merges the sharp art on top, in a region a little larger than the art', () => {
    const regions: Record<GearId, [string, string]> = {
      difficulty: ['-40%', '180%'],
      history: ['-30%', '160%'],
      popularity: ['-30%', '160%'],
      tempo: ['-20%', '140%'],
    };
    for (const gear of GEAR_IDS) {
      const filter = one(art(gear, 'strip', 50, false), 'defs > filter');
      const [y, height] = regions[gear];
      expect(attrs(filter, ['x', 'y', 'width', 'height']), gear).toEqual({ x: '-20%', y, width: '140%', height });
      expect(all(filter, '*').map((el) => el.localName), gear).toEqual(['feGaussianBlur', 'feMerge', 'feMergeNode', 'feMergeNode']);
      expect(attrs(one(filter, 'feGaussianBlur'), ['stdDeviation', 'result']), gear).toEqual({ stdDeviation: '2', result: 'b' });
      expect(all(filter, 'feMergeNode').map(attr('in')), gear).toEqual(['b', 'SourceGraphic']);
    }
  });

  it('is drawn once per strip, on one group, and the Difficulty and Tempo tab icons have none (their glow is a CSS filter on the root)', () => {
    for (const gear of GEAR_IDS) {
      const strip = art(gear, 'strip', 50, false);
      expect(all(strip, 'filter'), gear).toHaveLength(1);
      expect(all(strip, '[filter]'), gear).toHaveLength(1);
      if (gear === 'difficulty' || gear === 'tempo') expect(all(art(gear, 'tab', 50, false), 'filter, [filter]'), gear).toHaveLength(0);
    }
  });

  it('has an id of its own in each instance, so every strip on a screen uses its own filter', () => {
    const doc = parse(
      `<!doctype html><body>${renderToStaticMarkup(
        <>
          {[0, 1].flatMap((copy) =>
            GEAR_IDS.map((gear) => <GearArt key={`${copy}${gear}`} gear={gear} variant="strip" value={50} off={false} />),
          )}
        </>,
      )}`,
    );
    const svgs = [...doc.querySelectorAll('svg')];
    expect(svgs).toHaveLength(8);
    const ids = svgs.map((svg) => one(svg, 'filter').id);
    expect(new Set(ids).size).toBe(8);
    svgs.forEach((svg, i) => {
      // An id that is safe inside url(#...), and the one group that uses the filter names this svg's own.
      expect(ids[i]).toMatch(PLAIN_ID);
      expect(one(svg, '[filter]').getAttribute('filter')).toBe(`url(#${ids[i]})`);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The glow of the History and Popularity tab icons

describe('the glow of the History and Popularity tab icons reaches only what is lit (QWW-57, R7)', () => {
  // Both have a body and seven rays, and the rays the value does not reach are drawn unlit. A CSS filter on the root lit those too,
  // in the gear's colour. Here one group holds the body and the lit rays and names an SVG filter, and nothing else is filtered.
  const GLOWING = [
    { gear: 'history', color: COLOR.cyan, body: (tab: Element) => one(tab, 'g[stroke]') },
    { gear: 'popularity', color: COLOR.amber, body: (tab: Element) => one(tab, 'g[transform^="rotate(-16"]') },
  ] as const;

  /** `el`, then each element above it, up to and including the root svg. */
  function upToRoot(el: Element): Element[] {
    const chain: Element[] = [];
    for (let at: Element | null = el; at; at = at.parentElement) {
      chain.push(at);
      if (at.localName === 'svg') break;
    }
    return chain;
  }

  for (const { gear, color, body } of GLOWING) {
    it(`${gear}: the body and every lit ray are in the one filtered group, and no unlit ray has a filter on it or above it, at every value`, () => {
      const seen = { lit: 0, unlit: 0 };
      for (const value of VALUES) {
        const where = `${gear} at ${value}`;
        const tab = art(gear, 'tab', value, false);
        expect(all(tab, '[filter]'), where).toHaveLength(1);
        const group = one(tab, '[filter]');
        expect(group.localName, where).toBe('g');
        expect(group.contains(body(tab)), `${where}: the body`).toBe(true);
        // Moving rays between the groups must not move them in the document: they stay in index order.
        expect(all(tab, '[data-ray]').map(attr('data-i')), where).toEqual(INDEXES);
        for (const ray of all(tab, '[data-ray]')) {
          const lit = ray.getAttribute('data-lit') === 'true';
          const above = upToRoot(ray).filter(carriesFilter);
          expect(above.length, `${where}: ray ${ray.getAttribute('data-i')}`).toBe(lit ? 1 : 0);
          if (lit) expect(above[0], `${where}: ray ${ray.getAttribute('data-i')}`).toBe(group);
          seen[lit ? 'lit' : 'unlit']++;
        }
      }
      // The loop would pass for any filter if it never met one kind of ray.
      expect(seen.lit).toBeGreaterThan(0);
      expect(seen.unlit).toBeGreaterThan(0);
    });

    it(`${gear}: a gear that is off has no filter anywhere in its icon, at every value`, () => {
      for (const value of VALUES) expect(filtersIn(art(gear, 'tab', value, true)), `${gear} at ${value}`).toEqual([]);
    });

    it(`${gear}: the group names the one filter this svg defines, in the gear's colour whatever the colour of the parts, blurred by the 3 px of the glow it replaces`, () => {
      const tab = art(gear, 'tab', 50, false);
      const id = /^url\(#(.+)\)$/.exec(one(tab, '[filter]').getAttribute('filter') ?? '')?.[1];
      expect(id).toMatch(PLAIN_ID);
      expect(all(tab, 'filter').map((el) => el.id)).toEqual([id]);
      expect(all(tab, 'defs > filter')).toHaveLength(1);

      const filter = one(tab, 'filter');
      expect(attrs(filter, ['filterUnits', 'color-interpolation-filters'])).toEqual({
        filterUnits: 'userSpaceOnUse',
        'color-interpolation-filters': 'sRGB',
      });
      expect(all(filter, '*').map((el) => el.localName)).toEqual(['feGaussianBlur', 'feFlood', 'feComposite', 'feMerge', 'feMergeNode', 'feMergeNode']);
      // The shadow is the alpha of the group, blurred, painted in the gear's colour, and merged under the group itself.
      const blur = one(filter, 'feGaussianBlur');
      expect(attrs(blur, ['in', 'result'])).toEqual({ in: 'SourceAlpha', result: 'b' });
      // CSS drop-shadow(0 0 3px) blurs with a standard deviation of 3 screen px; the icon draws 34 / 28 screen px to a grid unit.
      expect(Number(blur.getAttribute('stdDeviation'))).toBeCloseTo(3 / (34 / 28), 10);
      expect(one(filter, 'feFlood').getAttribute('flood-color')).toBe(color);
      expect(attrs(one(filter, 'feComposite'), ['in2', 'operator'])).toEqual({ in2: 'b', operator: 'in' });
      expect(all(filter, 'feMergeNode').map(attr('in'))).toEqual(['glow', 'SourceGraphic']);
      expect(one(filter, 'feComposite').getAttribute('result')).toBe('glow');
    });

    it(`${gear}: the filter's region is the 28x22 grid and three standard deviations all round it, so none of the glow is cut`, () => {
      const filter = one(art(gear, 'tab', 50, false), 'filter');
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) => Number(filter.getAttribute(name)));
      const reach = 3 * (3 / (34 / 28));
      expect(x, 'x').toBeLessThanOrEqual(-reach);
      expect(y, 'y').toBeLessThanOrEqual(-reach);
      expect((x ?? NaN) + (width ?? NaN), 'right').toBeGreaterThanOrEqual(28 + reach);
      expect((y ?? NaN) + (height ?? NaN), 'bottom').toBeGreaterThanOrEqual(22 + reach);
    });

    it(`${gear}: lets the glow past the icon's box, and the root has no filter and no style of its own`, () => {
      const tab = art(gear, 'tab', 50, false);
      expect(tab.getAttribute('overflow')).toBe('visible');
      expect(tab.hasAttribute('style')).toBe(false);
    });
  }

  it('has a filter of its own in each instance, so every tab on a screen uses its own', () => {
    const doc = parse(
      `<!doctype html><body>${renderToStaticMarkup(
        <>
          {[0, 1].flatMap((copy) =>
            GLOWING.map(({ gear }) => <GearArt key={`${copy}${gear}`} gear={gear} variant="tab" value={50} off={false} />),
          )}
        </>,
      )}`,
    );
    const svgs = [...doc.querySelectorAll('svg')];
    expect(svgs).toHaveLength(4);
    const ids = svgs.map((svg) => one(svg, 'filter').id);
    expect(new Set(ids).size).toBe(4);
    svgs.forEach((svg, i) => {
      expect(ids[i]).toMatch(PLAIN_ID);
      expect(one(svg, '[filter]').getAttribute('filter')).toBe(`url(#${ids[i]})`);
    });
    // A tab and a strip of the same gear do not share an id either.
    const withStrip = parse(
      `<!doctype html><body>${renderToStaticMarkup(
        <>
          <GearArt gear="history" variant="strip" value={50} off={false} />
          <GearArt gear="history" variant="tab" value={50} off={false} />
        </>,
      )}`,
    );
    expect(new Set([...withStrip.querySelectorAll('filter')].map((el) => el.id)).size).toBe(2);
  });

  it('is drawn at the scale the blur was converted by: 34 px for 28 grid units', () => {
    for (const { gear } of GLOWING) {
      const tab = art(gear, 'tab', 50, false);
      const gridWidth = Number((tab.getAttribute('viewBox') ?? '').split(' ')[2]);
      expect(Number(tab.getAttribute('width')) / gridWidth, gear).toBeCloseTo(TAB_PX_PER_UNIT, 10);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the comparison itself', () => {
  it('notices a changed attribute, a missing element, a lost class, a wrong value, an unset binding and a filter that points nowhere', () => {
    const vm = viewModelFor();
    const ctx = () => contextFor(vm, 'strip');
    const ref = referenceArt('difficulty', 'strip');
    const fresh = () => artAsParentRenders('difficulty', 'strip', 30, false);
    expect(compare(ref, fresh(), ctx()).problems).toEqual([]);

    const changed = fresh();
    one(changed, 'line').setAttribute('y1', '13');
    expect(compare(ref, changed, ctx()).problems).toHaveLength(1);

    const extra = fresh();
    one(extra, 'line').setAttribute('data-x', '1');
    expect(compare(ref, extra, ctx()).problems).toHaveLength(1);

    const missing = fresh();
    one(missing, 'g').remove();
    expect(compare(ref, missing, ctx()).problems.length).toBeGreaterThan(0);

    const classless = fresh();
    classless.setAttribute('class', PARENT_CLASS);
    expect(compare(ref, classless, ctx()).problems).toHaveLength(1);

    const wrong = fresh();
    one(wrong, 'rect').setAttribute('y', '25');
    expect(compare(ref, wrong, ctx()).problems).toEqual(['svg>rect[2]: y is "24" in the reference, "25" in the component']);

    const unset = fresh();
    one(unset, 'rect').removeAttribute('fill-opacity');
    expect(compare(ref, unset, ctx()).problems).toEqual([
      'svg>rect[2]: fill-opacity is "0.12" in the reference, missing in the component',
    ]);

    const noFlicker = fresh();
    noFlicker.removeAttribute('style');
    expect(compare(ref, noFlicker, ctx()).problems).toHaveLength(1);

    // The parent sets a strip's size; if the art did too, the parent's class could not win.
    const sized = fresh();
    sized.setAttribute('width', '120');
    expect(compare(ref, sized, ctx()).problems).toEqual(['svg: width is missing in the reference, "120" in the component']);

    const nowhere = fresh();
    one(nowhere, 'g[filter]').setAttribute('filter', 'url(#nothing)');
    expect(compare(ref, nowhere, ctx()).problems).toHaveLength(1);

    // R7: at History 65 the first five notes are lit and the last two are drawn unlit. The walk notices a lit note marked or
    // coloured as unlit, an unlit one marked or coloured as lit, and a hidden one (the reference's opacity).
    const historyAt65 = () => artAsParentRenders('history', 'strip', 65, false);
    const walkHistory = (root: Element) => compare(referenceArt('history', 'strip'), root, contextFor(vm, 'strip')).problems;
    expect(walkHistory(historyAt65())).toEqual([]);

    const markedUnlit = historyAt65();
    one(markedUnlit, '[data-note]').setAttribute('data-lit', 'false');
    expect(walkHistory(markedUnlit)).toHaveLength(1);
    expect(walkHistory(markedUnlit)[0]).toContain('data-lit');

    const markedLit = historyAt65();
    all(markedLit, '[data-note]')[6]?.setAttribute('data-lit', 'true');
    expect(walkHistory(markedLit)).toHaveLength(1);

    const litButDark = historyAt65();
    one(litButDark, '[data-note] > g').setAttribute('fill', COLOR.unlit);
    expect(walkHistory(litButDark)).toHaveLength(1);
    expect(walkHistory(litButDark)[0]).toContain('fill');

    const unlitButBright = historyAt65();
    all(unlitButBright, '[data-note] > g')[6]?.setAttribute('fill', COLOR.cyan);
    expect(walkHistory(unlitButBright)).toHaveLength(1);

    const hidden = historyAt65();
    all(hidden, '[data-note]')[6]?.setAttribute('style', 'opacity:0');
    expect(walkHistory(hidden)).toHaveLength(1);
    expect(walkHistory(hidden)[0]).toContain('style');

    // The tab glow (R7): the walk takes the filter's structure out of the tab before it compares, but expects the root to carry no
    // filter and to let the glow past its box, and still sees a ray that is not where the reference has it.
    const historyTab = () => art('history', 'tab', 65, false);
    const walkTab = (root: Element) => compare(referenceArt('history', 'tab'), root, contextFor(vm, 'tab')).problems;
    expect(walkTab(historyTab())).toEqual([]);

    const glowOnRoot = historyTab();
    glowOnRoot.setAttribute('style', `filter:drop-shadow(0 0 3px ${COLOR.cyan})`);
    expect(walkTab(glowOnRoot)).toHaveLength(1);
    expect(walkTab(glowOnRoot)[0]).toContain('style');

    const clipped = historyTab();
    clipped.removeAttribute('overflow');
    expect(walkTab(clipped)).toEqual(['svg: overflow is "visible" in the reference, missing in the component']);

    const bent = historyTab();
    one(bent, '[data-ray]').setAttribute('d', 'M0 0 L1 1');
    expect(walkTab(bent)).toHaveLength(1);
    expect(walkTab(bent)[0]).toContain('d is');
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
  const REDUCED = '@media (prefers-reduced-motion: reduce)';

  it('defines exactly the classes the components use', () => {
    const used = new Set<string>();
    for (const [, root] of everyRoot()) {
      for (const el of [root, ...root.querySelectorAll('*')]) for (const token of classTokens(el)) used.add(moduleName(token));
    }
    // The strip root's flicker hook and the tab cone's thump class are both drawn by the roots above.
    expect([...used].sort()).toEqual(['bob', 'fade', 'flick', 'thump', 'thumpTab']);
    const defined = new Set([...squash(moduleCss).matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1] ?? ''));
    expect([...used].sort()).toEqual([...defined].sort());
  });

  it('has the reference rules for the bob, and the fade as the reference has it except that it is the colour that fades (R7)', () => {
    const same = [
      ['@keyframes bob', '@keyframes bob'],
      ['.bob', '.bob'],
    ] as const;
    for (const [from, to] of same) expect(bodyOf(moduleCss, to), to).toBe(bodyOf(referenceCss, from));
    // README §10: 2 px up, 1.1 s, alternate; the fade is 180 ms. The reference fades the part's opacity (`.fade`, on the group
    // that carries the hook) because it hides what the value does not reach. Here that is drawn unlit, so the tube's colour
    // fades, and the `fill` is on the group's one child.
    expect(bodyOf(referenceCss, '.fade')).toBe('transition:opacity 180ms;');
    expect(bodyOf(moduleCss, '.bob')).toBe('animation:bob 1.1s ease-in-out infinite alternate;');
    expect(bodyOf(moduleCss, '.fade > *')).toBe('transition:fill 180ms;');
    // The Mood speaker's arcs are hidden by opacity as in the reference (Round 7 §4), so on them it is the opacity that fades.
    expect(bodyOf(moduleCss, 'path.fade')).toBe(bodyOf(referenceCss, '.fade'));
  });

  it('thumps the cone around its centre where the reference does: (70, 48) on the strip and (14, 13.6) on the tab', () => {
    // The reference sets the origin inline on each cone group, strip first; the module carries it in a class for each.
    const origins = [...reference.querySelectorAll('.thump')].map((el) => styleOf(el)['transform-origin']);
    expect(origins).toEqual(['70px 48px', '14px 13.6px']);
    expect(bodyOf(moduleCss, '.thump')).toBe(`transform-origin:${origins[0]};`);
    expect(bodyOf(moduleCss, '.thumpTab')).toBe(`transform-origin:${origins[1]};`);
  });

  it("turns the thump, the bob and the strip flicker off for reduced motion, and the fade's transition, with !important (README test 30)", () => {
    // In the reference that block also holds the sign's buzz, the lyric wipe and the rows' and the rack's transitions, which
    // are not the art's. The art's classes are the reference's .thump, .bob, .flick and .fade, and .thump has a twin for the tab.
    const OWN: Record<string, string[]> = {
      '.thump': ['.thump', '.thumpTab'],
      '.bob': ['.bob'],
      '.flick': ['.flick'],
      '.fade': ['.fade > *', 'path.fade'],
    };
    const owned = rulesOf(bodyOf(referenceCss, REDUCED))
      .map(([selectors, body]): [string, string] => [selectors.split(',').flatMap((s) => OWN[s] ?? []).join(','), body])
      .filter(([selectors]) => selectors !== '');
    expect(owned).toEqual([
      ['.thump,.thumpTab,.bob,.flick', 'animation:none !important;'],
      // The reference's `.fade`; here the transition is on the group's child, and on a speaker arc itself (see above).
      ['.fade > *,path.fade', 'transition:none !important;'],
    ]);
    expect(rulesOf(bodyOf(moduleCss, REDUCED))).toEqual(owned);
  });

  it('leaves the size, the corner radius, the box and the dimming to the parent: it sets none of them', () => {
    const css = squash(moduleCss);
    expect(css).not.toMatch(/background|width|height|radius|grayscale|play-state|filter:/);
    expect(css).not.toMatch(/(^|[{;])opacity:/);
  });

  it('leaves the keyframes of the inline animations to setlist-global.css, where CSS Modules cannot rename them', () => {
    expect(squash(moduleCss)).not.toMatch(/@keyframes (thump|swing|neonOn)/);
    expect(squash(moduleCss)).not.toContain('var(');
  });
});

describe('setlist-global.css', () => {
  const globalCss = readFileSync(GLOBAL_CSS, 'utf8');
  /** The keyframes the art needs from the reference: the thumps, and the flicker. */
  const artKeyframes = (css: string) => rulesOf(css).filter(([prelude]) => /^@keyframes (thump\d+|neonOn)$/.test(prelude));

  it('holds the reference thump keyframes and the neonOn flicker, and nothing else: the metronome\'s swings are gone (Round 7 §6)', () => {
    expect(rulesOf(globalCss)).toEqual(artKeyframes(referenceCss));
    expect(squash(globalCss)).not.toContain('swing');
    const names = ['4', '8', '12'].map((n) => `@keyframes thump${n}`);
    expect(artKeyframes(globalCss).map(([prelude]) => prelude)).toEqual([...names, '@keyframes neonOn']);
  });

  it('plays the flicker the README describes: 0.25 to 1 to 0.35 to 1 to 0.6 to 1, then holds at 1 (§7)', () => {
    expect(bodyOf(globalCss, '@keyframes neonOn')).toBe(
      '0%{opacity:0.25;}8%{opacity:1;}12%{opacity:0.35;}20%{opacity:1;}26%{opacity:0.6;}34%{opacity:1;}100%{opacity:1;}',
    );
  });

  it('has a keyframes rule for every animation name the art can ask for', () => {
    const asked = new Set([...VALUES.map((tempo) => speaker(tempo).keyframes), neonFlicker(false, true).split(' ')[0]]);
    const defined = rulesOf(globalCss).map(([prelude]) => prelude.replace('@keyframes ', ''));
    expect([...asked].sort()).toEqual(defined.sort());
  });
});
