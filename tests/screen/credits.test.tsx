// @vitest-environment jsdom
// Sources and credits (QWW-57): the page at /credits, kept for direct visits (its analytics note, its list, its "‹ Back"), and the panel
// inside the TV that the link in the chin opens (R28; Deezer's own credit stays in the line under the list, R29). The panel's layout, its touch targets and what the real
// browser does with `inert` and focus are tests/e2e/credits.spec.ts; here the DOM, the focus, the keys and the timers, in jsdom.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Credits from '../../app/credits/page';
import { CREDITS_GUARD_MS, Tv } from '../../src/components/Tv';
import { ANALYTICS_NOTE, CREDITS } from '../../src/lib/credits';
import { phone, unphone } from '../helpers/phone';

afterEach(() => {
  cleanup();
  unphone();
});

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

// The page is for direct visits and old links now (the app opens the panel), and a visit can be a tab of its own, whose history has one
// entry. There "‹ Back" closes the tab, so the singer is back in the tuned one; anywhere else it goes back; and a browser that will not
// close the tab gets the old link's behaviour. The e2e (tests/e2e/credits.spec.ts) does the same in a real browser. Here the browser is
// stubbed: `history.length`, `close`, `closed`, `location`.
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

// ---- the panel inside the TV (R28) ----

/** What a "Sources and credits" shows, read from the DOM: each source's name, address and what we use it for, and the notes after them. */
const shown = (root: HTMLElement) => ({
  sources: Array.from(root.querySelectorAll('li')).map((li) => [li.querySelector('a')!.textContent, li.querySelector('a')!.getAttribute('href'), li.querySelector('p')!.textContent]),
  notes: Array.from(root.querySelectorAll('section')).map((s) => s.textContent),
});

describe('/credits and the panel say the same thing, from the same data (R28)', () => {
  it('every source of CREDITS is a link to it that opens outside the app, with what we use it for, and the analytics note follows', () => {
    render(<Credits />);
    const page = screen.getByRole('main');
    for (const c of CREDITS) {
      const link = within(page).getByRole('link', { name: c.name });
      expect(link.getAttribute('href')).toBe(c.url);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toMatch(/noreferrer/);
      expect(link.nextElementSibling?.textContent).toBe(c.what);
    }
    expect(page.querySelectorAll('li')).toHaveLength(CREDITS.length);
    expect(within(page).getByRole('heading', { name: ANALYTICS_NOTE.title })).toBeTruthy();
    for (const text of ANALYTICS_NOTE.paragraphs) expect(within(page).getByText(text)).toBeTruthy();
  });

  it('the panel in the TV shows exactly what the page shows', () => {
    const { container, unmount } = render(<Credits />);
    const onPage = shown(container);
    unmount();
    render(<Tv>a step</Tv>);
    fireEvent.click(screen.getByRole('button', { name: 'Sources and credits' }));
    expect(shown(screen.getByRole('dialog', { name: 'Sources and credits' }))).toEqual(onPage);
    expect(onPage.sources).toHaveLength(CREDITS.length);
  });
});

describe('Deezer in Sources and credits', () => {
  it('is named with the words about private listening and the audio we do not keep, in the panel and on the page, and has no logo there: the logo is in the line under the list (R29)', () => {
    const deezer = CREDITS.find((c) => c.name === 'Deezer')!;
    expect(deezer.what).toMatch(/streamed from Deezer for your own private, non-commercial listening/);
    expect(deezer.what).toMatch(/We never keep the audio/);

    const { unmount } = render(<Tv>a step</Tv>);
    fireEvent.click(screen.getByRole('button', { name: 'Sources and credits' }));
    const panel = screen.getByRole('dialog', { name: 'Sources and credits' });
    const link = within(panel).getByRole('link', { name: 'Deezer' });
    expect(link.querySelector('svg')).toBeNull();
    expect(panel.querySelectorAll('li svg')).toHaveLength(0);
    expect(link.nextElementSibling?.textContent).toBe(deezer.what);
    unmount();

    render(<Credits />);
    expect(screen.getByRole('link', { name: 'Deezer' }).querySelector('svg')).toBeNull();
    expect(document.querySelectorAll('li svg')).toHaveLength(0);
  });
});

describe('the link and the panel in the TV (R28)', () => {
  /** A step with a life of its own, so a test can tell a step that was kept from one that was made again. */
  function Step({ log }: { log: string[] }) {
    useEffect(() => {
      log.push('mounted');
      return () => {
        log.push('unmounted');
      };
    }, [log]);
    return (
      <>
        <button type="button">Start</button>
        <input aria-label="a field" />
      </>
    );
  }
  const draw = (log: string[] = []) => render(<Tv><Step log={log} /></Tv>);
  const tvOf = () => screen.getByRole('region', { name: 'Karaoke screen' });
  const linkOf = () => screen.getByRole('button', { name: 'Sources and credits' });
  const panelOf = () => screen.getByRole('dialog', { name: 'Sources and credits' });
  const panelIn = () => screen.queryByRole('dialog', { name: 'Sources and credits' });
  const closeOf = () => screen.getByRole('button', { name: 'Close sources and credits' });
  /** What holds the step: the TV's screen is its parent, and the chin comes after the screen. */
  const underlay = () => screen.getByLabelText('a field').parentElement!;
  const chin = () => linkOf().parentElement!;

  it('is a button in the chin after the screen, closed to begin with, that says it opens a dialog; it is not a link', () => {
    draw();
    const link = linkOf();
    expect(link.tagName).toBe('BUTTON');
    expect(link.getAttribute('href')).toBeNull();
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
    expect(link.getAttribute('aria-expanded')).toBe('false');
    expect(panelIn()).toBeNull();
    // In the chin, which is the TV's last part and comes after the screen the steps are on: so it is the last stop of the page's tab order.
    expect(chin()).toBe(tvOf().lastElementChild);
    expect(underlay().parentElement!.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It is the chin's first part (bottom left), before the label and the LED, which are decoration and stay out of the accessibility tree.
    expect(chin().firstElementChild).toBe(link);
    expect(screen.getByText('karaoke-dokie').getAttribute('aria-hidden')).toBe('true');
    expect(chin().lastElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it("opens on a tap, inside the TV's screen and over the step, and the address does not change: no new tab, no history entry", () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const back = vi.spyOn(window.history, 'back');
    const href = window.location.href;
    const entries = window.history.length;
    draw();
    fireEvent.click(linkOf());

    const panel = panelOf();
    expect(panel.getAttribute('aria-modal')).toBe('true');
    // Inside the TV's screen, beside the step and not around it, so the screen's rounded corners cut it as they cut the step.
    expect(panel.parentElement).toBe(underlay().parentElement);
    expect(tvOf().contains(panel)).toBe(true);
    expect(within(panel).getByRole('heading', { name: 'Sources and credits' })).toBeTruthy();
    expect(linkOf().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(closeOf());
    expect(panelIn()).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(window.history.length).toBe(entries);
    vi.restoreAllMocks();
  });

  it('draws the panel over the step, never in place of it: the step is the same node with what was typed in it, and is made once', () => {
    const log: string[] = [];
    draw(log);
    const field = screen.getByLabelText<HTMLInputElement>('a field');
    fireEvent.change(field, { target: { value: 'mid-way' } });
    for (let i = 0; i < 3; i++) {
      fireEvent.click(linkOf());
      expect(panelOf()).toBeTruthy();
      fireEvent.click(closeOf());
    }
    expect(screen.getByLabelText('a field')).toBe(field);
    expect(field.value).toBe('mid-way');
    expect(log).toEqual(['mounted']);
  });

  it('makes what is under it inert while it is open: the step and the chin, not the panel, and not the TV as a whole', () => {
    draw();
    const step = underlay();
    expect(step.hasAttribute('inert')).toBe(false);
    expect(chin().hasAttribute('inert')).toBe(false);
    fireEvent.click(linkOf());
    expect(step.hasAttribute('inert')).toBe(true);
    expect(chin().hasAttribute('inert')).toBe(true);
    expect(panelOf().closest('[inert]')).toBeNull();
    // The whole TV is inert only for the landscape message: the panel is inside it.
    expect(tvOf().hasAttribute('inert')).toBe(false);
  });

  it('moves the focus into the panel when it opens, and back to the link when ✕ closes it', () => {
    draw();
    linkOf().focus();
    fireEvent.click(linkOf());
    expect(document.activeElement).toBe(panelOf());
    expect(panelOf().tabIndex).toBe(-1);

    fireEvent.click(closeOf());
    expect(panelIn()).toBeNull();
    expect(document.activeElement).toBe(linkOf());
    expect(chin().hasAttribute('inert')).toBe(false);
  });

  it('takes the focus into the panel when a tap that gave the link none opened it (Safari does not focus a button it taps)', () => {
    draw();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(linkOf());
    expect(document.activeElement).toBe(panelOf());
    fireEvent.click(closeOf());
    expect(document.activeElement).toBe(linkOf());
  });

  it('closes on Escape wherever the focus is, and gives the focus back to the link; no other key closes it', () => {
    draw();
    fireEvent.click(linkOf());
    for (const key of ['Enter', ' ', 'Tab', 'ArrowDown', 'a', 'Backspace']) fireEvent.keyDown(document.activeElement ?? document.body, { key });
    expect(panelIn()).not.toBeNull();

    // On the panel, where the focus is...
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(panelIn()).toBeNull();
    expect(document.activeElement).toBe(linkOf());
    // ...and with the focus gone to the page's body (a tap on the page around the TV).
    fireEvent.click(linkOf());
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(panelIn()).toBeNull();
    expect(document.activeElement).toBe(linkOf());
  });

  it('listens for Escape only while it is open, and lets go of it when it closes or the TV goes', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const keys = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === 'keydown').length;
    const { unmount } = draw();
    expect(keys(added)).toBe(0);
    fireEvent.click(linkOf());
    expect(keys(added)).toBe(1);
    fireEvent.click(closeOf());
    expect(keys(removed)).toBe(1);
    fireEvent.click(linkOf());
    unmount();
    expect(keys(added)).toBe(2);
    expect(keys(removed)).toBe(2);
    vi.restoreAllMocks();
  });

  it('does not take the focus from where the singer put it since: only from the body, where a closed panel leaves it', () => {
    draw();
    const outside = document.body.appendChild(document.createElement('input'));
    fireEvent.click(linkOf());
    // A focus that is somewhere else when the panel goes (the page's own controls are inert, so only something outside the TV can have it).
    outside.focus();
    fireEvent.click(closeOf());
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  describe('a double tap on its ✕ (the second tap lands on the screen the first one brought back)', () => {
    it('leaves the step out of reach for CREDITS_GUARD_MS after it closes, and the link usable at once', () => {
      vi.useFakeTimers();
      try {
        draw();
        fireEvent.click(linkOf());
        fireEvent.click(closeOf());
        expect(underlay().hasAttribute('inert')).toBe(true);
        expect(chin().hasAttribute('inert')).toBe(false);
        act(() => {
          vi.advanceTimersByTime(CREDITS_GUARD_MS - 1);
        });
        expect(underlay().hasAttribute('inert')).toBe(true);
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(underlay().hasAttribute('inert')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts the moment again from each close: a panel opened and closed within it is guarded for the whole of the second', () => {
      vi.useFakeTimers();
      try {
        draw();
        fireEvent.click(linkOf());
        fireEvent.click(closeOf());
        act(() => {
          vi.advanceTimersByTime(CREDITS_GUARD_MS - 100);
        });
        fireEvent.click(linkOf());
        fireEvent.click(closeOf());
        act(() => {
          vi.advanceTimersByTime(CREDITS_GUARD_MS - 100);
        });
        // The first close's moment would be over by now; the second's is not.
        expect(underlay().hasAttribute('inert')).toBe(true);
        act(() => {
          vi.advanceTimersByTime(100);
        });
        expect(underlay().hasAttribute('inert')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is the same moment as KaraokeApp gives a double tap on its own screens', async () => {
      const { TAP_GUARD_MS } = await import('../../src/components/KaraokeApp');
      expect(CREDITS_GUARD_MS).toBe(TAP_GUARD_MS);
    });
  });

  it('stays open as the step changes under it: the same panel, and the new step is inert under it', () => {
    const { rerender } = render(
      <Tv>
        <Step log={[]} />
      </Tv>,
    );
    fireEvent.click(linkOf());
    const panel = panelOf();
    rerender(
      <Tv>
        <p>the next step</p>
      </Tv>,
    );
    expect(panelOf()).toBe(panel);
    expect(screen.getByText('the next step').parentElement!.hasAttribute('inert')).toBe(true);
    fireEvent.click(closeOf());
    expect(screen.getByText('the next step')).toBeTruthy();
  });

  it('with the phone on its side the TV is inert, the panel with it, and upright again the panel is still open and has the focus', () => {
    const turned = phone();
    draw();
    fireEvent.click(linkOf());
    expect(document.activeElement).toBe(panelOf());

    turned.turn(true);
    expect(tvOf().hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Turn your phone upright' })).toBeTruthy();
    expect(panelIn()).not.toBeNull();

    turned.turn(false);
    expect(tvOf().hasAttribute('inert')).toBe(false);
    expect(panelOf()).toBeTruthy();
    expect(document.activeElement).toBe(panelOf());
    // And it still closes, with the focus going to the link.
    fireEvent.click(closeOf());
    expect(document.activeElement).toBe(linkOf());
  });
});
