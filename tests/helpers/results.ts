// Props for rendering <Results> on its own in screen tests.
import type { Match, VocalRange } from '../../src/lib/contracts';
import { DEFAULT_VIEW } from '../../src/lib/songs/browse';

const noop = () => {};

export function resultsProps(range: VocalRange, matches: Match[]) {
  return {
    range,
    matches,
    mode: 'library' as const,
    view: DEFAULT_VIEW,
    shown: 10,
    loading: false,
    error: false,
    onSelect: noop,
    onMore: noop,
    onRetry: noop,
    onRedo: noop,
    onRedoEnd: noop,
    onSort: noop,
    onDecade: noop,
    onMood: noop,
    onDuets: noop,
    onClear: noop,
    onConnect: noop,
  };
}
