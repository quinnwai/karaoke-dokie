// The browser's Back button for what opens on top of the song list (QWW-57): a song's page, and the quiet, mic and note steps of a
// redo. The screen is one address, so Back on a phone used to leave the app from a song page; it now closes the page, like the
// page's own ‹ Back, with the tuning kept (that lives in the screen's state, not in the address).

import { useEffect, useRef } from 'react';

/** What `history.state` carries on the entry pushed here, to tell it apart in a test or the history. The address stays as it is. */
export const OVERLAY_STATE_KEY = 'kdOverlay';

/**
 * `overlay` names what is open on top of the list, or is null. When something opens, one history entry is pushed. The system Back
 * button, a swipe back and Android's back gesture then pop that entry, and `close` is called to close what was opened. When the app
 * closes it itself (its own Back button, or the flow moving on), the entry is taken off the stack again with history.back(), so the
 * next Back press leaves the page as it did before, not into an entry that does nothing; the popstate that causes is not ours to answer.
 * `close` is read when a Back press comes, so it may change on every render.
 */
export function useOverlayHistory(overlay: string | null, close: () => void): void {
  const pushed = useRef(false);
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (overlay !== null && !pushed.current) {
      window.history.pushState({ [OVERLAY_STATE_KEY]: overlay }, '');
      pushed.current = true;
    } else if (overlay === null && pushed.current) {
      pushed.current = false;
      window.history.back();
    }
  }, [overlay]);

  useEffect(() => {
    const onPopState = () => {
      if (!pushed.current) return;
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
}
