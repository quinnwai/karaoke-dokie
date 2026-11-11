'use client';

import type { MouseEvent } from 'react';

/** How long a tab that was told to close has before "‹ Back" takes it that the browser said no. A tab that does close is gone in about 50 ms. */
const CLOSE_WAIT_MS = 250;

/**
 * "‹ Back" on the credits page (QWW-57). The Deezer line and the book icon open this page in a new tab, where a link to "/" would fill
 * that tab with a second app, untuned, while the tuned tab sits hidden behind it. So in a tab of its own (one entry in its history)
 * Back closes the tab, which shows the tuned one again; anywhere else it goes back. It stays a link to "/": with no script, for a click
 * that asks for a new tab or window, and for a screen reader. Only a plain click is taken over.
 */
export function CreditsBack({ className }: { className?: string }) {
  function leave(e: MouseEvent<HTMLAnchorElement>) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.close();
    // A browser may not count the tab as one a script can close: then Back is the link it always was.
    window.setTimeout(() => {
      if (!window.closed) window.location.assign('/');
    }, CLOSE_WAIT_MS);
  }

  return (
    <a href="/" className={className} onClick={leave}>
      ‹ Back
    </a>
  );
}
