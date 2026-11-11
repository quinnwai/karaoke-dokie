// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Credits from '../../app/credits/page';

afterEach(cleanup);

describe('/credits: the analytics note (QWW-51)', () => {
  it('tells testers what is recorded, and what is not', () => {
    render(<Credits />);
    expect(screen.getByRole('heading', { name: 'Analytics while we test' })).toBeTruthy();
    const note = screen.getByRole('heading', { name: 'Analytics while we test' }).closest('section')!;
    const text = note.textContent!;
    expect(text).toMatch(/record what you tap/);
    expect(text).toMatch(/random number made on your phone/);
    expect(text).toMatch(/never your name, your email or your Spotify account/);
    expect(text).toMatch(/replay of your screen/);
    expect(text).toMatch(/off while you are signed in to Spotify/);
    expect(text).toMatch(/Your voice is worked out on your phone and is never recorded or sent/);
    expect(text).toMatch(/PostHog/);
  });

  it('keeps the sources and credits list', () => {
    render(<Credits />);
    expect(screen.getByRole('heading', { name: 'Sources and credits' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'USDB (UltraStar DataBase)' })).toBeTruthy();
  });
});

// The Deezer line and the book icon open /credits in a new tab (QWW-57), whose history has one entry. There "‹ Back" closes the tab, so the
// singer is back in the tuned one; anywhere else it goes back; and a browser that will not close the tab gets the old link's behaviour.
// The e2e (tests/e2e/credits.spec.ts) does the same in a real browser. Here the browser is stubbed: `history.length`, `close`, `closed`, `location`.
describe('/credits: "‹ Back" (QWW-57)', () => {
  const link = () => screen.getByRole('link', { name: '‹ Back' });

  /** A browser with `entries` pages in the tab's history, whose `window.close()` closes the tab (`closes`) or is refused. */
  function browser({ entries, closes }: { entries: number; closes: boolean }) {
    vi.useFakeTimers();
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(entries);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    // The real one would end the test's own window. jsdom has no `closed`, so it is defined here and taken away after.
    let closed = false;
    Object.defineProperty(window, 'closed', { configurable: true, get: () => closed });
    const close = vi.spyOn(window, 'close').mockImplementation(() => {
      closed = closes;
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    return { back, close, assign };
  }

  /** Clicks the link and says whether the page took the click over (cancelled the link's own navigation). jsdom would try to follow a link nobody cancelled, so the document ends that after reading. */
  function click(init?: MouseEventInit) {
    let taken = false;
    const settle = (e: Event) => {
      taken = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener('click', settle);
    fireEvent.click(link(), init);
    document.removeEventListener('click', settle);
    return taken;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { closed?: boolean }).closed;
  });

  it('is still a link to the app: with no script, in a new tab by a middle click, and for a screen reader', () => {
    render(<Credits />);
    expect(link().getAttribute('href')).toBe('/');
  });

  it('in a tab of its own (one entry in its history) closes the tab, and neither goes back nor loads the app into it', () => {
    const { back, close, assign } = browser({ entries: 1, closes: true });
    render(<Credits />);
    expect(click()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(assign).not.toHaveBeenCalled();
  });

  it('goes to the app, after a short wait, when the browser did not close the tab', () => {
    const { back, close, assign } = browser({ entries: 1, closes: false });
    render(<Credits />);
    expect(click()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    // It waits to see whether the tab goes...
    expect(assign).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    // ...and then does what the link did.
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/');
    expect(back).not.toHaveBeenCalled();
  });

  it.each([2, 5])('with %i entries in its history it goes back, and neither closes the tab nor loads the app', (entries) => {
    const { back, close, assign } = browser({ entries, closes: true });
    render(<Credits />);
    expect(click()).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['a button that is not the main one', { button: 1 }],
  ])('a click with %s is left to the browser: the link is not taken over and nothing is closed', (_what, init) => {
    const { back, close, assign } = browser({ entries: 1, closes: true });
    render(<Credits />);
    expect(click(init)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(assign).not.toHaveBeenCalled();
  });
});
