// Asks the ranking engine for the list that goes with what the singer has set, and keeps the answer.
// The screen never ranks: it sends the request and draws what comes back.

import { useEffect, useState } from 'react';
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
 * (its songs arrived) or the request does; an answer that arrives after a newer request was sent is dropped, so a
 * slow answer can never replace a newer one.
 */
export function useRankedSetlist(engine: SetlistEngine, request: SetlistRequest | null): RankedSetlist {
  const [state, setState] = useState<RankedSetlist>(NOTHING);
  // The request by value: a new object with the same numbers is not a new question.
  const key = request ? JSON.stringify(request) : null;

  useEffect(() => {
    if (key === null) {
      setState(NOTHING);
      return;
    }
    const asked = JSON.parse(key) as SetlistRequest;
    let stale = false;
    engine.rank(asked).then(
      (result) => !stale && setState({ result, failed: false }),
      () => !stale && setState((s) => ({ result: s.result, failed: true })),
    );
    return () => {
      stale = true;
    };
  }, [engine, key]);

  // With no request nothing is shown, even for the one render before the effect above clears what was kept.
  return key === null ? NOTHING : state;
}
