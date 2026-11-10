// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Results } from '../../src/components/Results';
import { rangeWarning } from '../../src/lib/client/rangeCheck';
import type { VocalRange } from '../../src/lib/contracts';

const r = (low: number, high: number): VocalRange => ({ low, high, source: 'test' });

describe('rangeWarning', () => {
  it('flags a low note below E2, naming the low end', () => {
    expect(rangeWarning(r(38, 63))).toEqual({ end: 'low', message: 'D2 is lower than almost any pop song goes. Was that a growl or vocal fry?' });
  });

  it('flags a high note above C6', () => {
    expect(rangeWarning(r(55, 86))?.end).toBe('high');
  });

  it('flags a span over two and a half octaves without blaming one end', () => {
    expect(rangeWarning(r(40, 71))?.end).toBeNull();
  });

  it('accepts ordinary ranges, including exactly E2 to C6 limits', () => {
    expect(rangeWarning(r(45, 72))).toBeNull();
    expect(rangeWarning(r(40, 70))).toBeNull();
    expect(rangeWarning(r(54, 84))).toBeNull();
  });
});

describe('range warning on the results screen', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);
  const base = { matches: [], loading: false, error: false, hasMore: false, onSelect: () => {}, onMore: () => {}, onRedo: () => {} };

  it('offers to redo either end, and remembers "Keep it" for that range', () => {
    const onRedoEnd = vi.fn();
    render(<Results {...base} range={r(38, 63)} onRedoEnd={onRedoEnd} />);
    expect(screen.getByRole('status').textContent).toContain('growl or vocal fry');
    fireEvent.click(screen.getByRole('button', { name: 'Redo low note' }));
    expect(onRedoEnd).toHaveBeenCalledWith('low');
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    render(<Results {...base} range={r(38, 63)} onRedoEnd={onRedoEnd} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing for an ordinary range, and the range notes redo one end', () => {
    const onRedoEnd = vi.fn();
    render(<Results {...base} range={r(45, 72)} onRedoEnd={onRedoEnd} />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Redo your high note, C5' }));
    expect(onRedoEnd).toHaveBeenCalledWith('high');
  });
});
