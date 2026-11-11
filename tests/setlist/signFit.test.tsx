// @vitest-environment jsdom
// R1 (QWW-57): the カラオケ sign is centred on the header's own middle, and goes when that would put it within 8 px of redo or the
// Spotify button. The rule is `signFits` (src/lib/setlist/fit.ts); `useSignFit` reads the three boxes from the page and sets
// `data-hidden`. jsdom has no layout, so the boxes are stubbed here; the real geometry is tests/e2e/setlist-frame.spec.ts.

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { SIGN_GAP, signFits } from '../../src/lib/setlist/fit';
import { el, RANGE, rankedSong, setlistProps } from '../helpers/setlist';

afterEach(cleanup);

describe('signFits', () => {
  const sign = { left: 130, right: 200 };

  it('shows the sign when it keeps 8 px clear of redo and of the Spotify button', () => {
    expect(SIGN_GAP).toBe(8);
    expect(signFits(sign, 100, 250)).toBe(true);
  });

  it('shows it at exactly 8 px on either side, and not at 7.9', () => {
    expect(signFits(sign, 122, 250)).toBe(true);
    expect(signFits(sign, 122.1, 250)).toBe(false);
    expect(signFits(sign, 100, 208)).toBe(true);
    expect(signFits(sign, 100, 207.9)).toBe(false);
  });

  it('goes when it would touch or cover redo, or the Spotify button', () => {
    expect(signFits(sign, 130, 250)).toBe(false);
    expect(signFits(sign, 150, 250)).toBe(false);
    expect(signFits(sign, 100, 200)).toBe(false);
    expect(signFits(sign, 100, 180)).toBe(false);
  });

  it('takes a gap of its own', () => {
    expect(signFits(sign, 125, 250, 4)).toBe(true);
    expect(signFits(sign, 125, 250, 8)).toBe(false);
  });
});

describe('the sign in the header', () => {
  /** What the stubbed layout says: where the sign, redo and the Spotify button are, in page pixels. */
  const layout = { sign: { left: 129.5, right: 198.5 }, redoRight: 110, spotifyLeft: 290 };
  const box = (left: number, right: number) => ({ left, right, top: 0, bottom: 28, width: right - left, height: 28, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

  let rect: typeof Element.prototype.getBoundingClientRect;
  let width: PropertyDescriptor | undefined;
  beforeEach(() => {
    rect = Element.prototype.getBoundingClientRect;
    width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 328 });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.hasAttribute('data-sign')) return box(layout.sign.left, layout.sign.right);
      if (this.hasAttribute('data-sign-left')) return box(layout.redoRight - 50, layout.redoRight);
      if (this.hasAttribute('data-sign-right')) return box(layout.spotifyLeft, layout.spotifyLeft + 30);
      return box(0, 0);
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = rect;
    if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
    else delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
    layout.redoRight = 110;
    layout.spotifyLeft = 290;
  });

  const draw = () => render(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')])} />);
  const sign = () => el('[data-sign]');

  it('is a child of the header row itself, centred by CSS, hidden from a screen reader and in Japanese', () => {
    draw();
    expect(sign().parentElement).toBe(el('header > div'));
    expect(sign().textContent).toBe('カラオケ');
    expect(sign().getAttribute('lang')).toBe('ja');
    expect(sign().getAttribute('aria-hidden')).toBe('true');
  });

  it('marks the neighbours it keeps clear of: redo on the left, the Spotify button on the right', () => {
    draw();
    expect(el('[data-sign-left]').getAttribute('aria-label')).toBe('Redo the singing test');
    expect(el('[data-sign-right]').getAttribute('aria-label')).toBe('Connect to Spotify');
  });

  it('shows the sign when it keeps 8 px clear of both', () => {
    draw();
    expect(sign().hasAttribute('data-hidden')).toBe(false);
  });

  it('hides it when a long range pushes redo to within 8 px of it, and shows it again when there is room', () => {
    layout.redoRight = 125; // 4.5 px short of the sign
    draw();
    expect(sign().hasAttribute('data-hidden')).toBe(true);
    layout.redoRight = 110;
    window.dispatchEvent(new Event('resize'));
    expect(sign().hasAttribute('data-hidden')).toBe(false);
  });

  it('hides it when the Spotify button is within 8 px on the right', () => {
    layout.spotifyLeft = 203;
    draw();
    expect(sign().hasAttribute('data-hidden')).toBe(true);
  });

  it('keeps it in the page when it is hidden: only its visibility goes, so it can be measured again', () => {
    layout.redoRight = 125;
    draw();
    expect(sign().isConnected).toBe(true);
    expect(sign().textContent).toBe('カラオケ');
  });
});

describe('without a layout (jsdom, or a screen that is not drawn yet)', () => {
  it('leaves the sign alone', () => {
    render(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')])} />);
    expect(el('[data-sign]').hasAttribute('data-hidden')).toBe(false);
  });
});
