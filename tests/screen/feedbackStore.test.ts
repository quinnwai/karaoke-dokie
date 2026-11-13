// @vitest-environment jsdom
// A like or dislike is kept on the device, one key for each song (R26, QWW-57): the store the song page reads when it opens.
// Nothing here is sent anywhere; the POST to /api/feedback and /api/catalogue/feedback are the app's, and tests/screen/songFeedback.test.tsx's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFeedback, saveFeedback } from '../../src/lib/client/storage';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the feedback store', () => {
  it('keeps a like and a dislike, for the song they were given to', () => {
    saveFeedback('t1', 'up');
    saveFeedback('t2', 'down');
    expect(loadFeedback('t1')).toBe('up');
    expect(loadFeedback('t2')).toBe('down');
    expect(loadFeedback('t3')).toBeUndefined();
  });

  it('is one key for each song, which is the device’s own storage: localStorage outlasts the tab', () => {
    saveFeedback('t1', 'up');
    expect(localStorage.getItem('kd.feedback:t1')).toBe('up');
    expect(sessionStorage.getItem('kd.feedback:t1')).toBeNull();
    expect(localStorage.length).toBe(1);
  });

  it('keys a catalogue song by its id, which has spaces, a bar and a colon in it, and does not mix it up with another', () => {
    const beatIt = 'cat:michael jackson|beat it';
    const billieJean = 'cat:michael jackson|billie jean';
    saveFeedback(beatIt, 'down');
    expect(loadFeedback(beatIt)).toBe('down');
    expect(loadFeedback(billieJean)).toBeUndefined();
    expect(loadFeedback('michael jackson|beat it')).toBeUndefined(); // the library has no such id, and a prefix is not a match
    expect(loadFeedback('cat:michael jackson|beat')).toBeUndefined();
    expect(localStorage.getItem('kd.feedback:cat:michael jackson|beat it')).toBe('down');
  });

  it.each(['', 'sideways', 'UP', 'Down', '1', 'true', '"up"', '{"thumbs":"up"}', 'null', 'undefined', ' up'])(
    'ignores a stored value that is not up or down (%j)',
    (stored) => {
      localStorage.setItem('kd.feedback:t1', stored);
      expect(loadFeedback('t1')).toBeUndefined();
    },
  );

  it('keeps the last thing saved for a song (the page is what stops a second tap; the store is not the one to refuse it)', () => {
    saveFeedback('t1', 'up');
    saveFeedback('t1', 'down');
    expect(loadFeedback('t1')).toBe('down');
  });

  it('does not touch the other things the device keeps: the range, the device id', () => {
    localStorage.setItem('kd.range', '{"low":45,"high":72}');
    localStorage.setItem('kd.anonId', 'device-1');
    saveFeedback('t1', 'up');
    expect(localStorage.getItem('kd.range')).toBe('{"low":45,"high":72}');
    expect(localStorage.getItem('kd.anonId')).toBe('device-1');
  });

  describe('where storage is blocked (a private window), it forgets and does not break', () => {
    it('when localStorage itself throws on access', () => {
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      expect(() => saveFeedback('t1', 'up')).not.toThrow();
      expect(loadFeedback('t1')).toBeUndefined();
    });

    it('when reading throws', () => {
      saveFeedback('t1', 'up');
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      expect(loadFeedback('t1')).toBeUndefined();
    });

    it('when writing throws (a full store, or Safari’s old private mode)', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
      expect(() => saveFeedback('t1', 'up')).not.toThrow();
      expect(loadFeedback('t1')).toBeUndefined();
    });
  });
});
