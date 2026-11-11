// Whether the phone is on its side, so the "Turn your phone upright" message is up (QWW-57, the review of PR #38, finding 1).
// The message itself is drawn by CSS alone (the one media query in src/components/screen.module.css); this is the same question put to
// the browser from script, for what CSS cannot do: making the page under the message inert, moving focus to it, and not measuring
// the page while nobody can see it.

import { useSyncExternalStore } from 'react';

/**
 * The one query that shows the message: a touch screen (no hover, a coarse pointer) in landscape and under 500 px tall. It is the same
 * text as the rule in screen.module.css, and tests/screen/rotateNotice.test.tsx fails when the two differ.
 */
export const ROTATE_QUERY = '(hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 500px)';

const ask = (): MediaQueryList | null => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(ROTATE_QUERY) : null);

/** True while the message is up. False where there is nobody to ask: the server, and a test with no media queries. */
export const isSideways = (): boolean => ask()?.matches ?? false;

/** `isSideways`, kept up to date: the component draws again when the phone is turned. */
export function useSideways(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = ask();
      query?.addEventListener('change', onChange);
      return () => query?.removeEventListener('change', onChange);
    },
    isSideways,
    () => false,
  );
}
