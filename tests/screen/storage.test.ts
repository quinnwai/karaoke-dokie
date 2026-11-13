// @vitest-environment jsdom
// QWW-66: the range kept on the device, and the test in flight, carry the time the range was sung.
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSavedRange, loadProgress, loadSavedRange, saveProgress, saveRangeOnDevice } from '../../src/lib/client/storage';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('the range kept on this device', () => {
  it('keeps the time the range was sung, and gives it back', () => {
    saveRangeOnDevice({ low: 42, high: 72, measuredAt: 1_700_000_000_000 });
    expect(JSON.parse(localStorage.getItem('kd.range')!)).toEqual({ low: 42, high: 72, measuredAt: 1_700_000_000_000 });
    expect(loadSavedRange()).toEqual({ low: 42, high: 72, measuredAt: 1_700_000_000_000 });
  });

  it('keeps a range with no time as it was kept before times were recorded: no time key at all', () => {
    saveRangeOnDevice({ low: 45, high: 72 });
    expect(localStorage.getItem('kd.range')).toBe(JSON.stringify({ low: 45, high: 72 }));
    expect(loadSavedRange()).toEqual({ low: 45, high: 72 });
  });

  it('reads a range kept by an earlier version (low and high only)', () => {
    localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72 }));
    expect(loadSavedRange()).toEqual({ low: 45, high: 72 });
  });

  it('drops a time that is not a time, and keeps the range', () => {
    for (const measuredAt of ['yesterday', null, -5, 0, 1.5, Infinity, {}]) {
      localStorage.setItem('kd.range', JSON.stringify({ low: 45, high: 72, measuredAt }));
      expect(loadSavedRange(), String(measuredAt)).toEqual({ low: 45, high: 72 });
    }
  });

  it('is cleared, and a broken value is nothing', () => {
    saveRangeOnDevice({ low: 42, high: 72, measuredAt: 1_700_000_000_000 });
    clearSavedRange();
    expect(loadSavedRange()).toBeNull();
    localStorage.setItem('kd.range', '{nope');
    expect(loadSavedRange()).toBeNull();
    localStorage.setItem('kd.range', JSON.stringify({ low: 72, high: 42 }));
    expect(loadSavedRange()).toBeNull();
  });
});

describe('the test in flight', () => {
  it('carries the time a finished test was sung, across the Spotify round trip', () => {
    saveProgress({ low: 42, high: 72, measuredAt: 1_700_000_000_000 });
    expect(loadProgress()).toEqual({ low: 42, high: 72, measuredAt: 1_700_000_000_000 });
  });

  it('is as before without one: just the notes', () => {
    saveProgress({ low: 42, high: null });
    expect(sessionStorage.getItem('kd.test')).toBe(JSON.stringify({ low: 42, high: null }));
    expect(loadProgress()).toEqual({ low: 42, high: null });
  });

  it('drops a time that is not a time', () => {
    sessionStorage.setItem('kd.test', JSON.stringify({ low: 42, high: 72, measuredAt: 'later' }));
    expect(loadProgress()).toEqual({ low: 42, high: 72 });
  });

  it('is nothing once both notes are empty', () => {
    saveProgress({ low: 42, high: 72, measuredAt: 1_700_000_000_000 });
    saveProgress({ low: null, high: null });
    expect(loadProgress()).toBeNull();
  });
});
