// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldStep } from '../../src/components/HoldStep';
import { ASKING_PATIENCE_MS, BUSY_PATIENCE_MS, MicStep } from '../../src/components/MicStep';
import type { BrowserInfo } from '../../src/lib/client/browser';
import { initialState, type MicGate, type MicView } from '../../src/lib/client/flow';
import type { MicProblem } from '../../src/lib/client/mic';
import { ANDROID_CHROME, INSTAGRAM, IOS_SAFARI } from '../helpers/micFlow';

// The mic step's screens on their own (QWW-50): what each browser is told, and what each button does. The whole
// walk, with the reducer and the microphone, is in app.test.tsx.

const IOS_CHROME: BrowserInfo = { os: 'ios', browser: 'chrome', inApp: null };
const DESKTOP: BrowserInfo = { os: 'other', browser: 'other', inApp: null };
const ANDROID_INSTAGRAM: BrowserInfo = { os: 'android', browser: 'other', inApp: 'instagram' };

function show(view: MicView, env: BrowserInfo | null, extra: Partial<MicGate> = {}) {
  const handlers = { onAsk: vi.fn(), onTryHere: vi.fn(), onReload: vi.fn() };
  const gate: MicGate = { ...initialState.mic, view, env, ...extra };
  const utils = render(<MicStep gate={gate} {...handlers} />);
  return { ...utils, ...handlers };
}
const view = () => document.querySelector('[data-mic-view]')!.getAttribute('data-mic-view');
const lyric = () => document.querySelector('[data-lyric]')?.textContent;
/** Each button by the name it is read out as: the round one has no words on it, only an aria-label. */
const buttons = () => screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe('MicStep: before the browser is asked', () => {
  it('shows nothing to read while it looks at the browser or opens a microphone that was already allowed', () => {
    for (const v of ['checking', 'opening'] as const) {
      const { container, unmount } = show(v, null);
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(buttons()).toEqual([]);
      unmount();
    }
    // Without a browser to describe there is nothing to say yet, whatever the view.
    const { container } = show('prompt', null);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('but if that goes on, the blank screen offers a reload instead of leaving the singer looking at nothing', () => {
    const { onReload, container } = show('opening', IOS_SAFARI);
    act(() => void vi.advanceTimersByTime(BUSY_PATIENCE_MS - 1));
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Nothing happened? Reload this page' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('says it plainly: a title, one line, and one round button with a microphone on it', () => {
    const { onAsk } = show('prompt', IOS_SAFARI);
    expect(view()).toBe('prompt');
    expect(lyric()).toBe('Set up your microphone');
    expect(screen.getByText(/Your phone will ask to use the microphone/).textContent).toBe('Your phone will ask to use the microphone. Tap Allow.');
    // Nothing else: no picture of a phone, no word about where the voice goes.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/voice stays/)).toBeNull();
    expect(buttons()).toEqual(['Turn on microphone']);
    const turnOn = screen.getByRole('button', { name: 'Turn on microphone' }) as HTMLButtonElement;
    // No words on it: the microphone says it, and the name is for screen readers, so the picture is hidden from them.
    expect(turnOn.textContent).toBe('');
    expect(turnOn.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(turnOn.disabled).toBe(false);
    expect(turnOn.getAttribute('aria-busy')).toBe('false');
    // The screen-reader line is there, empty, so that its change is announced.
    expect(screen.getByRole('status').textContent).toBe('');
    fireEvent.click(turnOn);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('reads the same on Android, and says "browser" rather than "phone" on a computer', () => {
    show('prompt', ANDROID_CHROME);
    expect(lyric()).toBe('Set up your microphone');
    expect(screen.getByText(/Your phone will ask to use the microphone/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    cleanup();
    show('prompt', DESKTOP);
    expect(screen.getByText(/Your browser will ask to use the microphone/)).toBeTruthy();
  });

  it('while the question is up the button shows it is waiting: lit, busy, not tappable, and still the same name', () => {
    const { onAsk } = show('asking', IOS_SAFARI);
    expect(view()).toBe('asking');
    expect(lyric()).toBe('Set up your microphone');
    const wait = screen.getByRole('button', { name: 'Turn on microphone' }) as HTMLButtonElement;
    expect(wait.disabled).toBe(true);
    expect(wait.getAttribute('aria-busy')).toBe('true');
    expect(wait.className).toMatch(/roundActive/);
    // No words come and go on it either; screen readers are told what the lit button shows everyone else.
    expect(wait.textContent).toBe('');
    expect(screen.getByRole('status').textContent).toBe('Waiting for your phone…');
    fireEvent.click(wait);
    expect(onAsk).not.toHaveBeenCalled();
    cleanup();
    show('asking', DESKTOP);
    expect(screen.getByRole('status').textContent).toBe('Waiting for your browser…');
  });

  it('and after a long silence it offers a reload: the way out when the browser\'s question never comes', () => {
    const { onReload } = show('asking', IOS_SAFARI);
    expect(screen.queryByRole('button', { name: /Reload/ })).toBeNull();

    act(() => void vi.advanceTimersByTime(ASKING_PATIENCE_MS - 1));
    expect(screen.queryByRole('button', { name: /Reload/ })).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    fireEvent.click(screen.getByRole('button', { name: 'Nothing happened? Reload this page' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    // The round button is still there, still waiting.
    expect(buttons()).toEqual(['Turn on microphone', 'Nothing happened? Reload this page']);
  });

  it('offers no reload to a singer who has not tapped yet', () => {
    show('prompt', IOS_SAFARI);
    act(() => void vi.advanceTimersByTime(ASKING_PATIENCE_MS * 2));
    expect(buttons()).toEqual(['Turn on microphone']);
  });

  it('the round button is the record button\'s: one shared button, so the two look alike', () => {
    show('prompt', IOS_SAFARI);
    render(<HoldStep kind="low" status="ready" live={null} lowNote={null} onPress={() => {}} onRelease={() => {}} />);
    const turnOn = screen.getByRole('button', { name: 'Turn on microphone' });
    const record = screen.getByRole('button', { name: 'Hold to record your lowest note' });
    const round = Array.from(turnOn.classList).find((c) => c.includes('roundButton'));
    expect(round).toBeTruthy();
    expect(Array.from(record.classList)).toContain(round);
    // Lit the same way: held down on the record button, waiting on the microphone button.
    expect(record.className).not.toMatch(/roundActive/);
    cleanup();
    show('asking', IOS_SAFARI);
    render(<HoldStep kind="low" status="holding" live={null} lowNote={null} onPress={() => {}} onRelease={() => {}} />);
    const lit = (el: HTMLElement) => /roundActive/.test(el.className);
    expect(lit(screen.getByRole('button', { name: 'Turn on microphone' }))).toBe(true);
    expect(lit(screen.getByRole('button', { name: 'Hold to record your lowest note' }))).toBe(true);
    // Only the record button is held down, so only it blocks scrolling and selecting under the finger.
    expect(screen.getByRole('button', { name: 'Hold to record your lowest note' }).className).toMatch(/holdPress/);
    expect(screen.getByRole('button', { name: 'Turn on microphone' }).className).not.toMatch(/holdPress/);
  });
});

describe('MicStep: inside another app', () => {
  it('on an iPhone says to open Safari, how, and offers to copy the link', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { onTryHere } = show('inapp', INSTAGRAM);
    expect(view()).toBe('inapp');
    expect(lyric()).toBe('Open this in Safari');
    expect(screen.getByText(/open inside Instagram/)).toBeTruthy();
    expect(screen.getByText('•••')).toBeTruthy();
    expect(screen.getByText('Open in Safari')).toBeTruthy();
    expect(buttons()).toEqual(['Copy link', 'Try here anyway']);
    // No link that pretends to open Safari: an iPhone offers no way to, so the words and the copy button carry it.
    expect(screen.queryByRole('link')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    });
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(screen.getByRole('button', { name: 'Link copied ✓' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try here anyway' }));
    expect(onTryHere).toHaveBeenCalledTimes(1);
  });

  it('on Android has a real "Open in Chrome" link, then the menu route, then the copy button', () => {
    show('inapp', ANDROID_INSTAGRAM);
    expect(lyric()).toBe('Open this in Chrome');
    const open = screen.getByRole('link', { name: 'Open in Chrome' });
    expect(open.getAttribute('href')).toBe(
      `intent://localhost:3000/#Intent;scheme=http;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(window.location.href)};end`,
    );
    expect(screen.getByText('Open in browser')).toBeTruthy();
    expect(buttons()).toEqual(['Copy link', 'Try here anyway']);
  });

  it('names the app, or says "another app" for one it only recognises as a webview', () => {
    show('inapp', { os: 'ios', browser: 'other', inApp: 'messenger' });
    expect(screen.getByText(/open inside Messenger/)).toBeTruthy();
    cleanup();
    show('inapp', { os: 'ios', browser: 'other', inApp: 'webview' });
    expect(screen.getByText(/open inside another app/)).toBeTruthy();
  });

  it('when the clipboard is refused, falls back to selecting the link so a long press can copy it', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('blocked'))) }, configurable: true });
    const exec = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    show('inapp', INSTAGRAM);
    const field = screen.getByLabelText('Link to this page') as HTMLInputElement;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    });
    expect(exec).toHaveBeenCalledWith('copy');
    // It says nothing false: the button still reads "Copy link", and the link is selected for the singer.
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
    delete (document as unknown as Record<string, unknown>).execCommand;
  });

  it('copes with no clipboard at all', async () => {
    show('inapp', INSTAGRAM);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    });
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });
});

describe('MicStep: the main button stays on screen', () => {
  // How it stays (sticky, at the bottom of the scrolling screen) is CSS, checked in the browser by mic-permission.spec.ts;
  // here, that every screen's one thing to tap is inside the wrapper that does it.
  const inMain = (name: string, role: 'button' | 'link' = 'button') => screen.getByRole(role, { name }).closest('[class*="micMain"]') !== null;

  it.each([
    ['the prompt', () => show('prompt', IOS_SAFARI), 'Turn on microphone', 'button'],
    ['the steps', () => show('recovery', IOS_SAFARI, { problem: 'denied' }), 'Try again', 'button'],
    ['the in-app screen on an iPhone', () => show('inapp', INSTAGRAM), 'Copy link', 'button'],
    ['the in-app screen on Android', () => show('inapp', ANDROID_INSTAGRAM), 'Open in Chrome', 'link'],
  ] as const)('%s', (_name, render, name, role) => {
    render();
    expect(inMain(name, role)).toBe(true);
  });
});

describe('MicStep: the backdrop behind the main button', () => {
  // The backdrop hides words that scroll under the button, so it is on only while the button is held up over them. Where
  // the button sits when everything fits, a backdrop would be a dark band across the screen. Which of the two it is, the
  // browser decides (mic-permission.spec.ts checks that in one); here, that the screen follows what it is told.
  class FakeObserver {
    static all: FakeObserver[] = [];
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(private callback: (entries: { intersectionRatio: number }[]) => void) {
      FakeObserver.all.push(this);
    }
    report(ratio: number) {
      act(() => this.callback([{ intersectionRatio: ratio }]));
    }
  }
  const backdrop = () => /micHeld/.test(document.querySelector('[class*="micMain"]')!.className);

  /** The prompt inside a scroller, with the bottom edge of the scroller at 500 and of the button where the test says. */
  function inScroller(bottomOfButton: number) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bottom = /micMain/.test(this.className) ? bottomOfButton : 500;
      return { bottom, top: bottom - 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: bottom - 100, toJSON() {} } as DOMRect;
    });
    const gate: MicGate = { ...initialState.mic, view: 'prompt', env: IOS_SAFARI };
    return render(
      <div style={{ overflowY: 'auto' }}>
        <MicStep gate={gate} onAsk={vi.fn()} onTryHere={vi.fn()} onReload={vi.fn()} />
      </div>,
    );
  }

  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has none where everything fits: the button sits well inside the screen', () => {
    inScroller(300);
    expect(backdrop()).toBe(false);
    FakeObserver.all[0]!.report(1);
    expect(backdrop()).toBe(false);
  });

  it('has it from the first paint when the screen scrolls and the button is held up at the bottom edge', () => {
    inScroller(502); // the button is set 2px below the edge, and the browser holds it there
    expect(backdrop()).toBe(true);
  });

  it('follows the browser as the scrolling holds the button up and lets it go', () => {
    inScroller(300);
    const [watch] = FakeObserver.all;
    watch!.report(0.985); // a sliver of it is cut off at the edge
    expect(backdrop()).toBe(true);
    watch!.report(1); // scrolled to the end: it is back in its place, with nothing under it
    expect(backdrop()).toBe(false);
    watch!.report(0.9995); // rounding, not a sliver
    expect(backdrop()).toBe(false);
  });

  it('watches the one button, and stops when the screen goes away', () => {
    const { unmount } = inScroller(300);
    expect(FakeObserver.all).toHaveLength(1);
    const [watch] = FakeObserver.all;
    expect(watch!.observe).toHaveBeenCalledTimes(1);
    expect(String((watch!.observe.mock.calls[0]![0] as HTMLElement).className)).toMatch(/micMain/);
    unmount();
    expect(watch!.disconnect).toHaveBeenCalledTimes(1);
  });

  it('works in a browser with no IntersectionObserver: the first look decides', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    inScroller(300);
    expect(backdrop()).toBe(false);
    cleanup();
    inScroller(502);
    expect(backdrop()).toBe(true);
  });
});

describe('MicStep: when it did not work', () => {
  const recovery = (problem: MicProblem, env: BrowserInfo, fails = 1) => show('recovery', env, { problem, fails });

  it('iPhone Safari: aA, Website Settings, Microphone, Allow; and that Safari may ask again', () => {
    const { onAsk, onReload } = recovery('denied', IOS_SAFARI);
    expect(view()).toBe('recovery');
    expect(lyric()).toBe('The microphone is blocked');
    const steps = Array.from(document.querySelectorAll('ol li')).map((li) => li.textContent);
    expect(steps).toEqual(['Tap aA in the address bar', 'Tap Website Settings', 'Set Microphone to Allow', 'Then tap Try again']);
    expect(screen.getByText('Safari may ask again each time you open this page. That’s normal.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload this page' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('Android Chrome: the lock icon, Permissions, Microphone; and no word about Safari', () => {
    recovery('denied', ANDROID_CHROME);
    const steps = Array.from(document.querySelectorAll('ol li')).map((li) => li.textContent);
    expect(steps).toEqual(['Tap the lock or settings icon by the web address', 'Tap Permissions', 'Turn on Microphone', 'Then tap Try again']);
    expect(screen.queryByText(/ask again each time/)).toBeNull();
  });

  it('Chrome on an iPhone points at the iPhone Settings app, and does not call itself Safari', () => {
    recovery('denied', IOS_CHROME);
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByText('Your browser may ask again each time you open this page. That’s normal.')).toBeTruthy();
  });

  it('a computer says click, not tap', () => {
    recovery('denied', DESKTOP);
    expect(screen.getByText(/Click the/)).toBeTruthy();
    expect(screen.getByText(/Your browser said no/)).toBeTruthy();
  });

  it('a closed question says to try again and tap Allow, with the steps in case it does not come back', () => {
    recovery('dismissed', IOS_SAFARI);
    expect(lyric()).toBe('The question was closed');
    expect(screen.getByText(/If the question doesn’t come back/)).toBeTruthy();
    expect(document.querySelectorAll('ol li').length).toBe(4);
  });

  it.each([
    ['missing', 'We can’t find a microphone'],
    ['busy', 'The microphone is busy'],
    ['unsupported', 'The microphone didn’t start'],
  ] as const)('%s has its own words, no settings steps, and still a way on', (problem, title) => {
    recovery(problem, ANDROID_CHROME);
    expect(lyric()).toBe(title);
    expect(document.querySelector('ol')).toBeNull();
    expect(buttons()).toEqual(['Try again', 'Reload this page']);
  });

  it('"unsupported" tells a browser we do not point to to open Safari or Chrome, but never tells Safari to open Safari', () => {
    recovery('unsupported', IOS_CHROME);
    expect(lyric()).toBe('This browser can’t use the microphone');
    expect(screen.getByText('Open this page in Safari and try again.')).toBeTruthy();
    cleanup();
    recovery('unsupported', { os: 'android', browser: 'other', inApp: null });
    expect(screen.getByText('Open this page in Chrome and try again.')).toBeTruthy();
    cleanup();
    recovery('unsupported', DESKTOP);
    expect(screen.getByText('Open this page in Chrome or Safari and try again.')).toBeTruthy();
    cleanup();
    // Already in the browser we would send them to: another browser is no help, so it says to try again or reload.
    recovery('unsupported', IOS_SAFARI);
    expect(lyric()).toBe('The microphone didn’t start');
    expect(screen.queryByText(/Open this page in/)).toBeNull();
    expect(screen.getByText(/Something went wrong/)).toBeTruthy();
  });

  it('Android\'s own switch for the browser has its own steps, in the phone\'s Settings and not the page\'s', () => {
    recovery('system', ANDROID_CHROME);
    expect(lyric()).toBe('Your phone is blocking the microphone');
    expect(Array.from(document.querySelectorAll('ol li')).map((li) => li.textContent)).toEqual([
      'Open your phone’s Settings',
      'Tap Apps, then your browser (such as Chrome), then Permissions',
      'Turn on Microphone',
      'Then tap Try again',
    ]);
    expect(screen.queryByText('Website Settings')).toBeNull();
    expect(screen.queryByText(/lock or settings icon/)).toBeNull();
  });

  it('inside another app\'s browser a refusal shows the way out of the app, not settings that are not there', () => {
    const { onAsk } = recovery('denied', INSTAGRAM);
    expect(view()).toBe('recovery');
    expect(lyric()).toBe('Open this in Safari');
    expect(screen.getByText(/open inside Instagram/)).toBeTruthy();
    expect(screen.queryByText('Website Settings')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(buttons()).toEqual(['Copy link', 'Try again']);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    cleanup();
    recovery('denied', ANDROID_INSTAGRAM);
    expect(lyric()).toBe('Open this in Chrome');
    expect(screen.getByRole('link', { name: 'Open in Chrome' }).getAttribute('href')).toMatch(/^intent:\/\//);
    expect(view()).toBe('recovery');
  });

  it('tells an iPhone user Safari may ask again before the steps, where a small screen still shows it', () => {
    recovery('denied', IOS_SAFARI);
    const note = screen.getByText(/may ask again each time/);
    const list = document.querySelector('ol')!;
    expect(note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says "still" from the second no, not the first', () => {
    recovery('denied', IOS_SAFARI, 1);
    expect(screen.queryByText(/Still not working/)).toBeNull();
    cleanup();
    recovery('denied', IOS_SAFARI, 2);
    expect(screen.getByText('Still not working. Follow the steps, then tap Try again.')).toBeTruthy();
  });

  it('falls back to "blocked" if the reason is somehow missing', () => {
    show('recovery', IOS_SAFARI, { problem: null });
    expect(lyric()).toBe('The microphone is blocked');
  });
});
