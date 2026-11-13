// @vitest-environment jsdom
// The browser's Back button for what opens on top of the song list (QWW-57, src/lib/client/useOverlayHistory.ts): opening pushes one
// history entry and leaves the address alone; the system Back pops it and closes what was opened; the app closing it itself takes
// the entry off again, so the next Back press leaves the page as before. jsdom runs the real History API, popstate included.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_STATE_KEY, useOverlayHistory } from '../../src/lib/client/useOverlayHistory';

/** Lets the History API's traversal (asynchronous, with its popstate) finish. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const marker = () => (window.history.state as Record<string, unknown> | null)?.[OVERLAY_STATE_KEY];

beforeEach(() => {
  // A new entry on top, so no entry is left ahead of the current one by an earlier test's Back (History.length counts those too).
  window.history.pushState(null, '', '/?start');
});
afterEach(() => {
  cleanup();
});

const setup = (initial: string | null = null) => {
  const close = vi.fn();
  const view = renderHook(({ overlay }: { overlay: string | null }) => useOverlayHistory(overlay, close), { initialProps: { overlay: initial } });
  return { close, ...view };
};

describe('useOverlayHistory', () => {
  it('pushes one entry when something opens, and leaves the address as it was', () => {
    const before = window.history.length;
    const { rerender } = setup();
    expect(window.history.length).toBe(before);
    rerender({ overlay: 'song' });
    expect(window.history.length).toBe(before + 1);
    expect(marker()).toBe('song');
    expect(window.location.pathname + window.location.search).toBe('/?start');
    // Rendering again, or what is open changing from one thing to another, pushes nothing more.
    rerender({ overlay: 'song' });
    rerender({ overlay: 'redo' });
    expect(window.history.length).toBe(before + 1);
  });

  it('closes what was opened when the system Back button is pressed, and takes no second entry', async () => {
    const before = window.history.length;
    const { close, rerender } = setup();
    rerender({ overlay: 'song' });
    act(() => window.history.back());
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(marker()).toBeUndefined();
    // The app closes it in answer: nothing is pushed or popped again.
    rerender({ overlay: null });
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(window.history.length).toBe(before + 1); // the entry is still there, ahead of the current one, as after any Back
    expect(window.location.pathname + window.location.search).toBe('/?start');
  });

  it('takes its entry off the stack when the app closes it itself, and does not answer the popstate that causes', async () => {
    const { close, rerender } = setup();
    rerender({ overlay: 'song' });
    expect(marker()).toBe('song');
    const back = vi.spyOn(window.history, 'back');
    rerender({ overlay: null });
    expect(back).toHaveBeenCalledTimes(1);
    await settle();
    expect(close).not.toHaveBeenCalled();
    expect(marker()).toBeUndefined(); // back on the entry the page started with
    back.mockRestore();
  });

  it('can open and close again, each time with one entry and one Back', async () => {
    const { close, rerender } = setup();
    for (let i = 1; i <= 3; i++) {
      rerender({ overlay: 'song' });
      expect(marker()).toBe('song');
      act(() => window.history.back());
      await settle();
      expect(close).toHaveBeenCalledTimes(i);
      rerender({ overlay: null });
      await settle();
    }
  });

  it('ignores a Back press when nothing is open', async () => {
    const { close } = setup();
    window.history.pushState({ other: true }, '');
    act(() => window.history.back());
    await settle();
    expect(close).not.toHaveBeenCalled();
  });

  it('calls the latest close, not the one from when it opened', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ close }: { close: () => void }) => useOverlayHistory('song', close), { initialProps: { close: first } });
    rerender({ close: second });
    act(() => window.history.back());
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
