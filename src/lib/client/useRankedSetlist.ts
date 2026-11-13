// Asks the ranking engine for the list that goes with what the singer has set, and keeps the answer.
// The screen never ranks: it sends the request and draws what comes back.

import { useEffect, useRef, useState } from 'react';
import type { SetlistEngine } from '../setlist/engine';
import type { SetlistRequest, SetlistResponse } from '../setlist/types';

export interface RankedSetlist {
  /** The engine's answer, or null until it has answered once for this screen. A new request keeps the last answer until its own arrives. */
  result: SetlistResponse | null;
  /** True when the engine could not answer. */
  failed: boolean;
}

const NOTHING: RankedSetlist = { result: null, failed: false };

/**
 * `request` null means there is nothing to ask for yet (no range, or the songs are still loading), and nothing is
 * shown: the answer to an earlier range or sign-in must not stand in. The engine is asked again whenever it changes
 * or the request does. A request that a newer one replaces is aborted and its answer dropped, so a slow answer can
 * never replace a newer one. `debounceMs` waits that long before asking again, so a slider drag (a new request on every
 * `input` event) sends the last value rather than every one; the first question of a screen is never held back.
 */
export function useRankedSetlist(engine: SetlistEngine, request: SetlistRequest | null, debounceMs = 0): RankedSetlist {
  const [state, setState] = useState<RankedSetlist>(NOTHING);
  const answered = useRef(false);
  // The request by value: a new object with the same numbers is not a new question.
  const key = request ? JSON.stringify(request) : null;

  useEffect(() => {
    if (key === null) {
      answered.current = false;
      setState(NOTHING);
      return;
    }
    const asked = JSON.parse(key) as SetlistRequest;
    const controller = new AbortController();
    let stale = false;
    const ask = () => {
      // An engine that throws before it returns a promise has failed like any other: that must not be an error that
      // takes the screen down.
      let answer: Promise<SetlistResponse>;
      try {
        answer = engine.rank(asked, controller.signal);
      } catch (err) {
        answer = Promise.reject(err);
      }
      answer.then(
        (result) => {
          if (stale) return;
          answered.current = true;
          setState({ result, failed: false });
        },
        () => !stale && setState((s) => ({ result: s.result, failed: true })),
      );
    };
    const wait = answered.current ? debounceMs : 0;
    const timer = wait > 0 ? setTimeout(ask, wait) : undefined;
    if (timer === undefined) ask();
    return () => {
      stale = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [engine, key, debounceMs]);

  // With no request nothing is shown, even for the one render before the effect above clears what was kept.
  return key === null ? NOTHING : state;
}
