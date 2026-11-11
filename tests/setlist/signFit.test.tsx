// @vitest-environment jsdom
// R1 (QWW-57): the カラオケ sign is centred on the header's own middle. It shrinks from 16 px down to 13 px to keep 8 px clear of redo and
// the Spotify button, and goes only when even 13 px does not fit. The rule is `signSize` (src/lib/setlist/fit.ts); `useSignFit` reads the
// boxes from the page and sets the sign's font size and `data-hidden`. jsdom has no layout, so the boxes are stubbed here; the real
// geometry is tests/e2e/setlist-frame.spec.ts.

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { SIGN_GAP, SIGN_MAX_SIZE, SIGN_MIN_SIZE, signSize } from '../../src/lib/setlist/fit';
import { el, RANGE, rankedSong, setlistProps } from '../helpers/setlist';

afterEach(cleanup);

describe('signSize', () => {
  // A sign 64 px wide at 16 px (4 px for each px of type), centred on 200: its box at 16 px is 168 to 232.
  const sign = { left: 168, right: 232 };
  const middle = 200;

  it('is 16 px, and never more, where the sign keeps 8 px clear of redo and of the Spotify button at full size', () => {
    expect([SIGN_GAP, SIGN_MAX_SIZE, SIGN_MIN_SIZE]).toEqual([8, 16, 13]);
    expect(signSize(sign, middle, 100, 300)).toBe(16);
    expect(signSize(sign, middle, -500, 900)).toBe(16);
  });

  it('is exactly 16 px with exactly 8 px to spare on both sides, and a hair under it with a hair less', () => {
    expect(signSize(sign, middle, 160, 240)).toBe(16);
    expect(signSize(sign, middle, 160.1, 240)).toBeCloseTo(15.95, 6);
    expect(signSize(sign, middle, 160, 239.9)).toBeCloseTo(15.95, 6);
  });

  it('is the largest size between, the one that leaves exactly the gap', () => {
    const size = signSize(sign, middle, 163, 400)!; // 37 px of room on the near side
    expect(size).toBe(14.5);
    // At 14.5 px the sign is 58 px wide, so 29 each side of the middle: 37 - 29 = 8.
    expect(middle - 163 - (64 * size) / 16 / 2).toBe(SIGN_GAP);
  });

  it('is exactly 13 px with exactly 13 px of room, and null a hair under: then the sign goes', () => {
    expect(signSize(sign, middle, 166, 234)).toBe(13);
    expect(signSize(sign, middle, 166.1, 234)).toBeNull();
    expect(signSize(sign, middle, 166, 233.9)).toBeNull();
  });

  it('is set by the nearer neighbour, on either side, and the other side does not matter', () => {
    expect(signSize(sign, middle, 163, 400)).toBe(14.5); // redo is the nearer
    expect(signSize(sign, middle, 163, 237)).toBe(14.5); // both are
    expect(signSize(sign, middle, -400, 237)).toBe(14.5); // the Spotify button is
    expect(signSize(sign, middle, -400, 233.9)).toBeNull();
    expect(signSize(sign, middle, 166.1, 900)).toBeNull();
  });

  it('is null when a neighbour is already at or past the middle', () => {
    expect(signSize(sign, middle, 200, 300)).toBeNull();
    expect(signSize(sign, middle, 210, 300)).toBeNull();
    expect(signSize(sign, middle, 100, 190)).toBeNull();
  });

  it('takes a gap of its own', () => {
    expect(signSize(sign, middle, 170, 230, 4)).toBe(13); // 30 px each side, less 4: 52 px of room
    expect(signSize(sign, middle, 170, 230, 8)).toBeNull(); // the same boxes with 8: 44 px of room
    expect(signSize(sign, middle, 170, 230)).toBeNull();
  });

  it('follows the sign\'s width: a sign twice as wide needs twice the room for the same size', () => {
    const wide = { left: 136, right: 264 }; // 128 px at 16 px
    expect(signSize(wide, middle, 140, 260)).toBe(13); // 60 px each side, less 8: 104 px of room
    expect(signSize(wide, middle, 140.1, 260)).toBeNull();
    expect(signSize(wide, middle, 100, 300)).toBe(16);
  });
});

describe('the sign in the header', () => {
  // What the stubbed layout says, in page pixels. The header row is 0 to 328 (its middle is 164). The sign is centred on that and 69 px
  // wide at 16 px, its width following the font size the hook gives it, as a browser's does. Redo and the Spotify button are where the
  // test puts them. `seen` is the font size the sign had each time its box was read.
  const layout = { redoRight: 110, spotifyLeft: 290 };
  const seen: number[] = [];
  const box = (left: number, right: number) => ({ left, right, top: 0, bottom: 28, width: right - left, height: 28, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

  let rect: typeof Element.prototype.getBoundingClientRect;
  let width: PropertyDescriptor | undefined;
  beforeEach(() => {
    rect = Element.prototype.getBoundingClientRect;
    width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 328 });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.hasAttribute('data-sign')) {
        const size = Number.parseFloat((this as HTMLElement).style.fontSize) || SIGN_MAX_SIZE;
        seen.push(size);
        const half = (69 * size) / SIGN_MAX_SIZE / 2;
        return box(164 - half, 164 + half);
      }
      if (this.hasAttribute('data-sign-left')) return box(layout.redoRight - 50, layout.redoRight);
      if (this.hasAttribute('data-sign-right')) return box(layout.spotifyLeft, layout.spotifyLeft + 30);
      if (this === document.querySelector('header > div')) return box(0, 328);
      return box(0, 0);
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = rect;
    if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
    else delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
    layout.redoRight = 110;
    layout.spotifyLeft = 290;
    seen.length = 0;
  });

  const draw = (mode: 'catalogue' | 'library' = 'catalogue') => render(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { mode })} />);
  const sign = () => el('[data-sign]');
  const resize = () => window.dispatchEvent(new Event('resize'));
  /** The sign's font size as the hook left it ('' before it has run). */
  const size = () => sign().style.fontSize;
  const hidden = () => sign().hasAttribute('data-hidden');
  /** How far the sign is from redo and from the Spotify button, as the stubbed layout draws it at the size it has now. */
  const gaps = () => {
    const b = sign().getBoundingClientRect();
    return { redo: b.left - layout.redoRight, spotify: layout.spotifyLeft - b.right };
  };

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

  it('shows the sign at 16 px when it keeps 8 px clear of both at that size', () => {
    draw();
    expect(hidden()).toBe(false);
    expect(size()).toBe('16px');
  });

  it('shrinks it to the largest size that keeps 8 px clear of redo, instead of hiding it', () => {
    layout.redoRight = 125; // 39 px from the middle: room for 62 px of sign, which is 14.4 px of type
    draw();
    expect(hidden()).toBe(false);
    expect(size()).toBe('14.3px'); // 14.376 floored to a tenth
    const { redo, spotify } = gaps();
    expect(redo).toBeGreaterThanOrEqual(SIGN_GAP);
    expect(redo, 'the largest tenth that keeps the gap, not a smaller one').toBeLessThan(SIGN_GAP + 0.5);
    expect(spotify).toBeGreaterThanOrEqual(SIGN_GAP);
  });

  it('shrinks it for the Spotify button on the right too', () => {
    layout.spotifyLeft = 203; // 39 px from the middle
    draw();
    expect(hidden()).toBe(false);
    expect(size()).toBe('14.3px');
    expect(gaps().spotify).toBeGreaterThanOrEqual(SIGN_GAP);
  });

  it('does the same signed in: the account is the neighbour on the right', () => {
    layout.spotifyLeft = 203;
    draw('library');
    expect(el('[data-sign-right]').getAttribute('aria-label')).toBeNull(); // the account's wrapper, not the Connect button
    expect(hidden()).toBe(false);
    expect(size()).toBe('14.3px');
  });

  it('hides it only when even 13 px does not fit: 13 px at 127.9, gone at 128', () => {
    layout.redoRight = 127.9; // 56.2 px of room; 13 px of type is 56.06 px of sign
    draw();
    expect(hidden()).toBe(false);
    expect(size()).toBe('13px');
    expect(gaps().redo).toBeGreaterThanOrEqual(SIGN_GAP);
    layout.redoRight = 128; // 56 px of room: 12.99 px of type
    resize();
    expect(hidden()).toBe(true);
  });

  it('hides it when a long range leaves no room at all, and keeps it in the page: only its visibility goes, so it can be measured again', () => {
    layout.redoRight = 140;
    draw();
    expect(hidden()).toBe(true);
    expect(sign().isConnected).toBe(true);
    expect(sign().textContent).toBe('カラオケ');
  });

  it('leaves a hidden sign at 16 px, not at a stale small size, and sizes it from scratch when the room comes back', () => {
    layout.redoRight = 125;
    draw();
    expect(size()).toBe('14.3px');
    layout.redoRight = 130; // too tight even for 13 px
    resize();
    expect(hidden()).toBe(true);
    expect(size()).toBe('16px');
    layout.redoRight = 110; // a phone turned: room for the full size
    resize();
    expect(hidden()).toBe(false);
    expect(size()).toBe('16px');
    layout.redoRight = 125;
    resize();
    expect(size()).toBe('14.3px');
  });

  it('grows back as the room does, and shrinks again when it goes', () => {
    layout.redoRight = 125;
    draw();
    expect(size()).toBe('14.3px');
    layout.redoRight = 118; // 46 px from the middle: 76 px of room, more than the sign needs
    resize();
    expect(size()).toBe('16px');
    layout.redoRight = 127; // 37 px: 58 px of room
    resize();
    expect(size()).toBe('13.4px');
  });

  it('measures the sign at 16 px whatever size it was given last, so the answer is the same every time', () => {
    layout.redoRight = 125;
    draw();
    resize();
    resize();
    resize();
    expect(seen.length).toBeGreaterThan(3);
    expect(new Set(seen)).toEqual(new Set([SIGN_MAX_SIZE]));
    expect(size()).toBe('14.3px');
    expect(hidden()).toBe(false);
  });

  describe('what makes it measure again', () => {
    // A browser has a ResizeObserver and `document.fonts`; jsdom has neither, so these are stand-ins that the test fires by hand.
    class FakeResizeObserver {
      static all: FakeResizeObserver[] = [];
      observed: Element[] = [];
      disconnected = false;
      constructor(readonly callback: () => void) {
        FakeResizeObserver.all.push(this);
      }
      observe(node: Element) {
        this.observed.push(node);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    afterEach(() => {
      vi.unstubAllGlobals();
      FakeResizeObserver.all = [];
      delete (document as unknown as { fonts?: unknown }).fonts;
    });

    it('watches the row, redo and the Spotify button for their size, not the sign: its size is the hook\'s own doing', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const { unmount } = draw();
      const mine = FakeResizeObserver.all.find((o) => o.observed.includes(el('[data-sign-left]')))!;
      expect(mine.observed).toEqual([el('header > div'), el('[data-sign-left]'), el('[data-sign-right]')]);
      expect(mine.observed).not.toContain(sign());
      expect(size()).toBe('16px');
      layout.redoRight = 125; // the window got narrower
      mine.callback();
      expect(size()).toBe('14.3px');
      unmount();
      expect(mine.disconnected).toBe(true);
    });

    it('measures again when the fonts arrive, whose glyphs change the widths of the sign and of the range, and stops when the screen goes', () => {
      const fonts = new EventTarget();
      const removed = vi.spyOn(fonts, 'removeEventListener');
      Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
      const { unmount } = draw();
      expect(size()).toBe('16px');
      layout.redoRight = 125; // Inter arrived and the range note got wider
      fonts.dispatchEvent(new Event('loadingdone'));
      expect(size()).toBe('14.3px');
      unmount();
      expect(removed).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    });
  });
});

describe('without a layout (jsdom, or a screen that is not drawn yet)', () => {
  it('leaves the sign alone: no size, not hidden', () => {
    render(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')])} />);
    expect(el('[data-sign]').hasAttribute('data-hidden')).toBe(false);
    expect(el('[data-sign]').style.fontSize).toBe('');
  });
});
