// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Results } from '../../src/components/Results';
import { DEFAULT_VIEW } from '../../src/lib/songs/browse';
import { HIGHEST_LIKELY, LOWEST_LIKELY, plausibleNote } from '../../src/lib/client/rangeCheck';
import type { VocalRange } from '../../src/lib/contracts';

const r = (low: number, high: number): VocalRange => ({ low, high, source: 'test' });

describe('plausibleNote', () => {
  it('lifts a growled low note to E2 and lowers a whistled high note to C6', () => {
    expect(LOWEST_LIKELY).toBe(40); // E2
    expect(HIGHEST_LIKELY).toBe(84); // C6
    expect(plausibleNote(38)).toBe(40); // D2
    expect(plausibleNote(28)).toBe(40);
    expect(plausibleNote(86)).toBe(84); // D6
    expect(plausibleNote(96)).toBe(84);
  });

  it('leaves every note from E2 to C6 alone', () => {
    for (let midi = LOWEST_LIKELY; midi <= HIGHEST_LIKELY; midi++) expect(plausibleNote(midi)).toBe(midi);
  });
});

describe('the results screen', () => {
  afterEach(cleanup);
  const noop = () => {};
  const base = {
    matches: [],
    mode: 'library' as const,
    view: DEFAULT_VIEW,
    leadSlider: null,
    shown: 5,
    loading: false,
    error: false,
    onSelect: noop,
    onMore: noop,
    onRetry: noop,
    onRedo: noop,
    onSlider: noop,
    onSliderDone: noop,
    onResetSliders: noop,
    onDecade: noop,
    onMood: noop,
    onDuets: noop,
    onClear: noop,
    onConnect: noop,
    displayName: 'Test Singer',
    onLogout: async () => {},
  };

  // Each of these used to bring up a card with Redo low note, Redo high note and Keep it.
  it.each([
    [38, 63], // D2 to D#4: a low note under E2
    [55, 86], // G3 to D6: a high note over C6
    [40, 71], // E2 to B4: wider than two and a half octaves
  ])('asks nothing about a range of MIDI %i to %i', (low, high) => {
    render(<Results {...base} range={r(low, high)} onRedoEnd={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Redo (low|high) note$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
    expect(screen.queryByText(/growl|vocal fry|whistle|squeak|wider than/i)).toBeNull();
  });

  it('keeps the range notes as the quiet way to redo one end', () => {
    const onRedoEnd = vi.fn();
    render(<Results {...base} range={r(38, 72)} onRedoEnd={onRedoEnd} />);
    fireEvent.click(screen.getByRole('button', { name: 'Redo your high note, C5' }));
    expect(onRedoEnd).toHaveBeenLastCalledWith('high');
    fireEvent.click(screen.getByRole('button', { name: 'Redo your low note, D2' }));
    expect(onRedoEnd).toHaveBeenLastCalledWith('low');
  });
});
