// @vitest-environment jsdom
// The tuner's header after Quinn-Wai's iPhone review of #38 (QWW-57, R14, R19, R30): redo is a round icon button with no text, the count of songs that fit is
// at the header's top right, and the Spotify button's tooltip comes with a tap on a touch screen. jsdom applies no CSS, so the circle's size and
// the 44 px target, where the count stands, and what a real tap does are tests/e2e/setlist-header.spec.ts's; here is the DOM and the logic.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { TAP_GUARD_MS } from '../../src/lib/client/tapGuard';
import { RANGE, rankedSong, setlistProps } from '../helpers/setlist';

afterEach(() => {
  cleanup();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

/** A screen that can or cannot hover: what `matchMedia('(hover: none)')` answers. Any other query is no match. */
function screenThat(canHover: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ media: q, matches: q === '(hover: none)' ? !canHover : false, addEventListener() {}, removeEventListener() {} }),
  });
}

const draw = (over: Partial<Parameters<typeof setlistProps>[2]> = {}) => {
  const onRedo = vi.fn();
  const onConnect = vi.fn();
  const view = render(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { onRedo, onConnect, ...over })} />);
  return { ...view, onRedo, onConnect };
};

describe('R14: redo is a round icon button', () => {
  it('is named "Redo the range test", has no text, and draws an arrow the screen reader does not see', () => {
    const { onRedo } = draw();
    const redo = screen.getByRole('button', { name: 'Redo the range test' });
    expect(redo.textContent).toBe('');
    const svg = redo.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(redo.hasAttribute('data-sign-left')).toBe(true); // the sign keeps its 8 px from this one (R1)
    fireEvent.click(redo);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it('is not called "Redo the singing test" any more, and no "redo" word is drawn in the header', () => {
    draw();
    expect(screen.queryByRole('button', { name: 'Redo the singing test' })).toBeNull();
    expect(screen.queryByText('redo')).toBeNull();
  });
});

describe('R19: the count of songs that fit', () => {
  const count = () => document.querySelector('[data-song-count]');

  it('is in the header, with a thousands comma, and says "1 song" for one', () => {
    const { rerender } = draw({ total: 1136 });
    expect(count()!.textContent).toBe('1,136 songs');
    expect(count()!.closest('header')).not.toBeNull();
    rerender(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { total: 1 })} />);
    expect(count()!.textContent).toBe('1 song');
    rerender(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { total: 0 })} />);
    expect(count()!.textContent).toBe('0 songs');
  });

  it('follows every answer of the engine, and is not there before the first one', () => {
    const { rerender } = draw({});
    expect(count()).toBeNull();
    rerender(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { total: 25 })} />);
    expect(count()!.textContent).toBe('25 songs');
    rerender(<SetlistScreen {...setlistProps(RANGE, [rankedSong('a')], { total: 4 })} />);
    expect(count()!.textContent).toBe('4 songs');
  });
});

describe('R30: the Spotify button on a screen that cannot hover', () => {
  // The button's moment (TAP_GUARD_MS) is a matter of how long since the tap that showed the tooltip: only Date is faked, so a test says how long it is.
  beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => void vi.useRealTimers());
  const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const button = () => screen.getByRole('button', { name: 'Connect to Spotify' });
  const tipOpen = () => button().getAttribute('data-tip') === 'open';
  /** A finger's tap: a click with a detail of 1, as a browser makes it (a keyboard's or a screen reader's has 0). */
  const tap = (el: HTMLElement) => fireEvent.click(el, { detail: 1 });

  it('the first tap shows the tooltip and connects to nothing; the second, after the moment, connects', () => {
    screenThat(false);
    const { onConnect } = draw();
    expect(tipOpen()).toBe(false);
    tap(button());
    expect(tipOpen()).toBe(true);
    expect(onConnect).not.toHaveBeenCalled();
    tick(TAP_GUARD_MS); // a tap that is meant comes after the moment a double tap's second one would
    tap(button());
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(tipOpen()).toBe(false);
  });

  it.each([80, 150, 250, 350])('a double tap, %i ms apart: the second is ignored, the tooltip stays open, and a tap after the moment connects', (gap) => {
    screenThat(false);
    const { onConnect } = draw();
    tap(button());
    tick(gap);
    tap(button()); // before the tooltip could be read
    expect(onConnect).not.toHaveBeenCalled();
    expect(tipOpen(), 'the tooltip is still up to be read').toBe(true);

    tick(TAP_GUARD_MS); // the ignored tap put the moment off again
    tap(button());
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(tipOpen()).toBe(false);
  });

  it('a run of taps 150 ms apart never connects: an ignored tap puts the moment off again, so the fourth, 450 ms after the first, is ignored too', () => {
    screenThat(false);
    const { onConnect } = draw();
    tap(button());
    for (let i = 0; i < 3; i++) {
      tick(150);
      tap(button());
    }
    expect(onConnect).not.toHaveBeenCalled();
    expect(tipOpen()).toBe(true);

    tick(TAP_GUARD_MS);
    tap(button());
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('the moment ends exactly TAP_GUARD_MS after the tap that showed the tooltip: a millisecond before, a tap is ignored', () => {
    screenThat(false);
    const { onConnect } = draw();
    tap(button());
    tick(TAP_GUARD_MS - 1);
    tap(button());
    expect(onConnect).not.toHaveBeenCalled();
    tick(TAP_GUARD_MS); // from the ignored tap, which started the moment again
    tap(button());
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('the keyboard and a screen reader (detail 0) connect at once, even inside the moment, since they have the name and no tooltip to read', () => {
    screenThat(false);
    const { onConnect } = draw();
    tap(button()); // the tooltip is up, and the moment has started
    fireEvent.click(button()); // Enter, Space or a screen reader's activate: detail 0
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(tipOpen()).toBe(false);
  });

  it('a tap that follows a tap elsewhere shows the tooltip again, as it did, whatever the time since the first', () => {
    screenThat(false);
    const { onConnect } = draw();
    tap(button());
    tick(100);
    act(() => void fireEvent.pointerDown(screen.getByRole('heading', { name: 'Tune your setlist' }))); // hides the tooltip
    expect(tipOpen()).toBe(false);
    tap(button()); // shows it again: it is a first tap, not a second
    expect(tipOpen()).toBe(true);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('a tap anywhere else, or Escape, hides the tooltip, and the next tap on the button shows it again instead of connecting', () => {
    screenThat(false);
    const { onConnect } = draw();
    tap(button());
    expect(tipOpen()).toBe(true);
    act(() => void fireEvent.pointerDown(screen.getByRole('heading', { name: 'Tune your setlist' })));
    expect(tipOpen()).toBe(false);

    tap(button());
    expect(tipOpen()).toBe(true);
    act(() => void fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(tipOpen()).toBe(false);
    expect(onConnect).not.toHaveBeenCalled();

    tap(button());
    expect(tipOpen()).toBe(true);
    // A press on the button itself is not "elsewhere".
    act(() => void fireEvent.pointerDown(button()));
    expect(tipOpen()).toBe(true);
  });

  it('a click that is not a finger (Enter, Space, a screen reader\'s activate) connects at once: it has the name, and no tooltip to read', () => {
    screenThat(false);
    const { onConnect } = draw();
    fireEvent.click(button()); // detail 0
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(tipOpen()).toBe(false);
  });

  it('with a pointer that hovers one click connects, as it always did, and the tooltip is the stylesheet\'s hover and focus', () => {
    screenThat(true);
    const { onConnect } = draw();
    tap(button());
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(tipOpen()).toBe(false);
  });

  it('with no media queries at all (jsdom, an old browser) one click connects too', () => {
    const { onConnect } = draw();
    tap(button());
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
