// @vitest-environment jsdom
// The tuner's first sizing (QWW-57, decision 1: the first time a short phone reaches the tuner it opens the sheet in mini) and the
// "Turn your phone upright" message (the review of PR #38, a second pass): a page opened on its side saw no room under the message,
// sized itself to mini for good, and stayed mini when the phone was turned upright at 390x844, where it opens expanded. Now nothing is
// sized while the message is up; the first sizing is made from the page as laid out when the phone is upright.
// jsdom has no layout and no media queries, so both are stand-ins that the test sets and fires by hand. The same in a real browser is
// tests/e2e/landscape.spec.ts.

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { ROW_HEIGHT } from '../../src/lib/setlist/fit';
import { RACK_FULL } from '../../src/lib/setlist/sheet';
import { initialTuner } from '../../src/lib/setlist/tuner';
import { phone, unphone } from '../helpers/phone';
import { el, RANGE, rankedSong, SEL, setlistProps } from '../helpers/setlist';

/** What the browser's layout says, by the id of the element asked: the screen's root, the song list and the rack. */
const layout = { root: 0, list: 0, rack: RACK_FULL, overflow: 0 };
/** A window with room for the list: six rows above the expanded sheet. */
const upright = () => Object.assign(layout, { root: 844, list: 6 * ROW_HEIGHT, rack: RACK_FULL, overflow: 0 });
/** A short phone upright: one row above the expanded sheet. */
const short = () => Object.assign(layout, { root: 640, list: ROW_HEIGHT, rack: RACK_FULL, overflow: 0 });
/** The same page on its side, 640x360: the expanded sheet does not fit at all (the list is squeezed to nothing and spills over). */
const sideways = () => Object.assign(layout, { root: 328, list: 0, rack: RACK_FULL, overflow: 200 });

const prototypes = { clientHeight: Element.prototype, offsetHeight: HTMLElement.prototype, scrollHeight: Element.prototype };
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.id === 'app' ? layout.root : this.id === 'list-scroll' ? layout.list : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.id === 'rack' ? layout.rack : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.id === 'app' ? layout.root + layout.overflow : 0;
    },
  });
});
afterEach(() => {
  cleanup();
  unphone();
  for (const name of Object.keys(prototypes)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
});

/** The window changed size: a browser without a ResizeObserver tells the page so (jsdom has none). */
const resized = () => act(() => void window.dispatchEvent(new Event('resize')));

function draw() {
  const onSheetSized = vi.fn();
  const onTuner = vi.fn();
  const view = render(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { openMiniIfShort: true, onSheetSized, onTuner, tuner: initialTuner() })} />);
  return { ...view, onSheetSized, onTuner };
}
const mode = () => el(SEL.app).dataset.mode;

describe('the first sizing of a page that is upright', () => {
  it('opens a short phone in mini, once', () => {
    short();
    const { onSheetSized, onTuner } = draw();
    expect(onSheetSized).toHaveBeenCalledTimes(1);
    expect(onTuner.mock.calls).toEqual([[{ type: 'mini', mini: true }]]);
    resized();
    expect(onSheetSized).toHaveBeenCalledTimes(1);
  });

  it('opens a tall phone expanded, and says it was sized', () => {
    upright();
    const { onSheetSized, onTuner } = draw();
    expect(onSheetSized).toHaveBeenCalledTimes(1);
    expect(onTuner).not.toHaveBeenCalled();
    expect(mode()).toBe('expanded');
  });
});

describe('a page opened on its side', () => {
  it('sizes nothing while the message is up: the singer\'s own choice stands, and the sheet under the message follows the page as ever', () => {
    sideways();
    phone(true);
    const { onSheetSized, onTuner } = draw();
    expect(onSheetSized).not.toHaveBeenCalled();
    expect(onTuner).not.toHaveBeenCalled();
    resized();
    expect(onSheetSized).not.toHaveBeenCalled();
    expect(onTuner).not.toHaveBeenCalled();
    // The expanded sheet cannot fit the page on its side, so the handle keeps it in mini; that is the screen's own, nothing the tuner holds.
    expect(mode()).toBe('mini');
  });

  it('is sized when the phone is turned upright, from the page as laid out then: a tall phone opens expanded', () => {
    sideways();
    const turned = phone(true);
    const { onSheetSized, onTuner } = draw();
    upright();
    turned.turn(false);
    expect(onSheetSized).toHaveBeenCalledTimes(1);
    expect(onTuner).not.toHaveBeenCalled(); // not mini: the old first sizing had already said so, from the sideways layout
    resized(); // the browser tells the page its window changed
    expect(mode()).toBe('expanded');
    expect(onTuner).not.toHaveBeenCalled();
    expect(onSheetSized).toHaveBeenCalledTimes(1);
  });

  it('is sized when the phone is turned upright, and a short phone opens mini', () => {
    sideways();
    const turned = phone(true);
    const { onSheetSized, onTuner } = draw();
    short();
    turned.turn(false);
    expect(onSheetSized).toHaveBeenCalledTimes(1);
    expect(onTuner.mock.calls).toEqual([[{ type: 'mini', mini: true }]]);
  });

  it('is sized from the first measure after the turn, not from the one before it, even if the window has not told the page yet', () => {
    sideways();
    const turned = phone(true);
    const { onSheetSized, onTuner } = draw();
    // The turn is told first (the media query), the window's resize after: the page measures when the turn is told, at the new size.
    upright();
    turned.turn(false);
    expect(onSheetSized).toHaveBeenCalledTimes(1);
    expect(onTuner).not.toHaveBeenCalled();
  });
});

describe('a page opened upright and then turned', () => {
  it('is sized once, and turning it to its side and back sizes nothing again: the singer\'s choice is what they find', () => {
    upright();
    const turned = phone();
    const { onSheetSized, onTuner } = draw();
    expect(onSheetSized).toHaveBeenCalledTimes(1);
    expect(mode()).toBe('expanded');

    sideways();
    turned.turn(true);
    resized();
    // Under the message the expanded sheet cannot fit, so the handle keeps it in mini; the tuner is not told, and is not changed.
    expect(mode()).toBe('mini');
    upright();
    turned.turn(false);
    resized();
    expect(mode()).toBe('expanded');
    expect(onSheetSized).toHaveBeenCalledTimes(1);
    expect(onTuner).not.toHaveBeenCalled();
  });

  it('a short phone that opened mini is still mini after a turn and back', () => {
    short();
    const turned = phone();
    const { onTuner } = draw();
    expect(onTuner.mock.calls).toEqual([[{ type: 'mini', mini: true }]]);
    sideways();
    turned.turn(true);
    resized();
    short();
    turned.turn(false);
    resized();
    expect(onTuner).toHaveBeenCalledTimes(1);
  });
});
