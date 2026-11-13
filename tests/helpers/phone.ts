// A phone that a test turns by hand, for the jsdom tests of the "Turn your phone upright" message and what depends on it. jsdom has
// no media queries, so this is what `window.matchMedia(ROTATE_QUERY)` answers, and the listeners that a turn calls. Any other query is
// no match. Remove it again with `unphone()` (the tests do it in afterEach): without it jsdom has no `matchMedia` at all.

import { act } from '@testing-library/react';
import { ROTATE_QUERY } from '../../src/lib/client/useSideways';

export function phone(sideways = false) {
  let on = sideways;
  const listeners = new Set<() => void>();
  const query = {
    media: ROTATE_QUERY,
    get matches() {
      return on;
    },
    addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => (q === ROTATE_QUERY ? query : { media: q, matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  return {
    listeners,
    /** Turns the phone onto its side (true) or upright (false), and tells whoever asked. */
    turn(to: boolean) {
      on = to;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

export const unphone = () => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
};
