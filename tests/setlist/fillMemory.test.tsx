// @vitest-environment jsdom
// The memory of a visit to the list (QWW-57, R12): which titles have filled. KaraokeApp keeps it, so it outlives the list (an
// emptied list, a song page and Back); a visit lasts until the singer's range changes. useFillMemory is what decides that.

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFillMemory } from '../../src/components/setlist/useFillIn';

describe('useFillMemory', () => {
  it('is one Map for as long as the visit stays the same, whatever else the app redraws', () => {
    const { result, rerender } = renderHook(({ visit }) => useFillMemory(visit), { initialProps: { visit: '45-72' } });
    const first = result.current;
    first.set('t0', 0);
    rerender({ visit: '45-72' });
    rerender({ visit: '45-72' });
    expect(result.current).toBe(first);
    expect(result.current.get('t0')).toBe(0);
  });

  it('is a new, empty Map when the visit changes (a new range), and that one is kept from then on', () => {
    const { result, rerender } = renderHook(({ visit }) => useFillMemory(visit), { initialProps: { visit: '45-72' } });
    const first = result.current;
    first.set('t0', 0);
    first.set('t1', 60);
    rerender({ visit: '40-77' });
    const second = result.current;
    expect(second).not.toBe(first);
    expect(second.size).toBe(0);
    second.set('t2', 0);
    rerender({ visit: '40-77' });
    expect(result.current).toBe(second);
    // The old visit's Map is not touched: nothing that still holds it sees it change.
    expect(first.size).toBe(2);
  });

  it('starts a new visit when the range goes away (redo starts the test again) and when it comes back', () => {
    const { result, rerender } = renderHook(({ visit }) => useFillMemory(visit), { initialProps: { visit: '45-72' } });
    result.current.set('t0', 0);
    rerender({ visit: '' });
    expect(result.current.size).toBe(0);
    result.current.set('t0', 0);
    rerender({ visit: '45-72' });
    expect(result.current.size).toBe(0);
  });
});
