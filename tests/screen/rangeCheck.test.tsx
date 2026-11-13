// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import type { VocalRange } from '../../src/lib/contracts';
import { setlistProps } from '../helpers/setlist';

const r = (low: number, high: number): VocalRange => ({ low, high, source: 'test' });

describe('the Setlist screen and the singer’s range', () => {
  afterEach(cleanup);

  // Each of these used to bring up a card with Redo low note, Redo high note and Keep it.
  it.each([
    [38, 63], // D2 to D#4: a low note under E2
    [55, 86], // G3 to D6: a high note over C6
    [40, 71], // E2 to B4: wider than two and a half octaves
  ])('asks nothing about a range of MIDI %i to %i', (low, high) => {
    render(<SetlistScreen {...setlistProps(r(low, high), [], { onRedoEnd: () => {} })} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Redo (low|high) note$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
    expect(screen.queryByText(/growl|vocal fry|whistle|squeak|wider than/i)).toBeNull();
  });

  it('shows the range as a chip, whatever it is', () => {
    render(<SetlistScreen {...setlistProps(r(38, 72), [])} />);
    expect(screen.getByLabelText('Your range D2 to C5')).toBeTruthy();
  });

  it('keeps the range notes as the quiet way to redo one end', () => {
    const onRedoEnd = vi.fn();
    render(<SetlistScreen {...setlistProps(r(38, 72), [], { onRedoEnd })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Redo your high note, C5' }));
    expect(onRedoEnd).toHaveBeenLastCalledWith('high');
    fireEvent.click(screen.getByRole('button', { name: 'Redo your low note, D2' }));
    expect(onRedoEnd).toHaveBeenLastCalledWith('low');
    expect(onRedoEnd).toHaveBeenCalledTimes(2);
  });

  it('has a redo button for the whole singing test, apart from the two notes', () => {
    const onRedo = vi.fn();
    const onRedoEnd = vi.fn();
    render(<SetlistScreen {...setlistProps(r(45, 72), [], { onRedo, onRedoEnd })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Redo the range test' }));
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(onRedoEnd).not.toHaveBeenCalled();
  });
});
