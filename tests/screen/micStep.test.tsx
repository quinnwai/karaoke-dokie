// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASKING_PATIENCE_MS, MicStep, QUIET_HINT_MS } from '../../src/components/MicStep';
import { HEARD_LEVEL } from '../../src/lib/audio/level';
import type { BrowserInfo } from '../../src/lib/client/browser';
import { initialState, type MicGate, type MicView } from '../../src/lib/client/flow';
import type { MicProblem } from '../../src/lib/client/mic';
import { ANDROID_CHROME, INSTAGRAM, IOS_SAFARI } from '../helpers/micFlow';

// The mic step's screens on their own (QWW-50): what each browser is told, and what each button does. The whole
// walk, with the reducer and the microphone, is in app.test.tsx.

const IOS_CHROME: BrowserInfo = { os: 'ios', browser: 'chrome', inApp: null };
const DESKTOP: BrowserInfo = { os: 'other', browser: 'other', inApp: null };
const ANDROID_INSTAGRAM: BrowserInfo = { os: 'android', browser: 'other', inApp: 'instagram' };

function show(view: MicView, env: BrowserInfo | null, extra: Partial<MicGate> = {}, props: Partial<Parameters<typeof MicStep>[0]> = {}) {
  const handlers = { onAsk: vi.fn(), onTryHere: vi.fn(), onContinue: vi.fn(), onReload: vi.fn() };
  const gate: MicGate = { ...initialState.mic, view, env, ...extra };
  const utils = render(<MicStep gate={gate} readLevel={() => 0} {...handlers} {...props} />);
  return { ...utils, ...handlers };
}
const view = () => document.querySelector('[data-mic-view]')!.getAttribute('data-mic-view');
const lyric = () => document.querySelector('[data-lyric]')?.textContent;
const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent);

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
    act(() => void vi.advanceTimersByTime(ASKING_PATIENCE_MS - 1));
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Nothing happened? Reload this page' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('says it plainly, with one big button, and draws where the question appears on an iPhone', () => {
    const { onAsk } = show('prompt', IOS_SAFARI);
    expect(view()).toBe('prompt');
    expect(lyric()).toBe('We need to hear you sing');
    expect(screen.getByText(/Your phone will ask to use the microphone/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /box in the middle of its screen/ })).toBeTruthy();
    expect(screen.getByText('Your voice stays on your phone.')).toBeTruthy();
    expect(buttons()).toEqual(['Turn on microphone']);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on microphone' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('draws a panel from the bottom on Android', () => {
    show('prompt', ANDROID_CHROME);
    expect(screen.getByRole('img', { name: /panel sliding up from the bottom/ })).toBeTruthy();
  });

  it('says "browser" rather than "phone" on a computer', () => {
    show('prompt', DESKTOP);
    expect(screen.getByText(/Your browser will ask to use the microphone/)).toBeTruthy();
    expect(screen.getByText('Your voice stays on your browser.')).toBeTruthy();
  });

  it('while the question is up the button waits, and after a long silence it offers a reload', () => {
    const { onReload } = show('asking', IOS_SAFARI);
    expect(view()).toBe('asking');
    const wait = screen.getByRole('button', { name: 'Waiting for your phone…' }) as HTMLButtonElement;
    expect(wait.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Reload/ })).toBeNull();

    act(() => void vi.advanceTimersByTime(ASKING_PATIENCE_MS - 1));
    expect(screen.queryByRole('button', { name: /Reload/ })).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    fireEvent.click(screen.getByRole('button', { name: 'Nothing happened? Reload this page' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('offers no reload to a singer who has not tapped yet', () => {
    show('prompt', IOS_SAFARI);
    act(() => void vi.advanceTimersByTime(ASKING_PATIENCE_MS * 2));
    expect(buttons()).toEqual(['Turn on microphone']);
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

describe('MicStep: the level meter', () => {
  const frames = (levels: number[]) => {
    let i = 0;
    return vi.fn(() => levels[Math.min(i++, levels.length - 1)]!);
  };
  const fill = () => document.querySelector<HTMLElement>('[class*="meterFill"]')!;
  const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it('moves the bar with the sound, up at once and down gently', () => {
    show('level', IOS_SAFARI, {}, { readLevel: frames([0, 0.6, 0, 0]) });
    expect(view()).toBe('level');
    expect(lyric()).toBe('Say “ahh”');
    tick(50);
    expect(fill().style.transform).toBe('scaleX(0.000)');
    tick(50);
    expect(fill().style.transform).toBe('scaleX(0.600)');
    tick(50);
    expect(fill().style.transform).toBe('scaleX(0.480)'); // 0.6 * 0.8
    tick(50);
    expect(fill().style.transform).toBe('scaleX(0.384)');
  });

  it('says "We can hear you" once a voice gets past the line, and keeps saying it', () => {
    show('level', IOS_SAFARI, {}, { readLevel: frames([0.1, HEARD_LEVEL - 0.01, HEARD_LEVEL, 0]) });
    expect(screen.getByRole('status').textContent).toBe('Listening…');
    tick(100);
    expect(screen.getByRole('status').textContent).toBe('Listening…');
    tick(50);
    expect(screen.getByRole('status').textContent).toBe('We can hear you ✓');
    expect(document.querySelector('[data-heard]')!.getAttribute('data-heard')).toBe('true');
    tick(500);
    expect(screen.getByRole('status').textContent).toBe('We can hear you ✓');
  });

  it('after a few silent seconds says it hears nothing and what to check; a voice then takes that back', () => {
    const readLevel = vi.fn(() => 0);
    show('level', IOS_SAFARI, {}, { readLevel });
    tick(QUIET_HINT_MS - 100);
    expect(screen.getByRole('status').textContent).toBe('Listening…');
    expect(screen.queryByText(/covers the microphone/)).toBeNull();
    tick(150);
    expect(screen.getByRole('status').textContent).toBe('We can’t hear anything yet');
    expect(screen.getByText(/nothing covers the microphone/i)).toBeTruthy();
    readLevel.mockReturnValue(0.9);
    tick(50);
    expect(screen.getByRole('status').textContent).toBe('We can hear you ✓');
    expect(screen.queryByText(/covers the microphone/)).toBeNull();
  });

  it('never makes the singer wait for a sound: Continue is always there', () => {
    const { onContinue } = show('level', IOS_SAFARI);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('stops listening when it goes away', () => {
    const readLevel = vi.fn(() => 0);
    const { unmount } = show('level', IOS_SAFARI, {}, { readLevel });
    tick(100);
    const calls = readLevel.mock.calls.length;
    unmount();
    tick(1000);
    expect(readLevel.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
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
    ['unsupported', 'This browser can’t use the microphone'],
  ] as const)('%s has its own words, no settings steps, and still a way on', (problem, title) => {
    recovery(problem, ANDROID_CHROME);
    expect(lyric()).toBe(title);
    expect(document.querySelector('ol')).toBeNull();
    expect(buttons()).toEqual(['Try again', 'Reload this page']);
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
