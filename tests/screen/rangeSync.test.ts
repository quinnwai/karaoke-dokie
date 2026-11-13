// QWW-66: the range the singer sang last wins, on the device and on the account.
import { describe, expect, it } from 'vitest';
import { deviceRangeWins, fitsServer, newestOnDevice, sungAfter } from '../../src/lib/client/rangeSync';
import type { VocalRange } from '../../src/lib/contracts';

const range = (low: number, high: number, measuredAt?: number): VocalRange => ({ low, high, source: 'test', ...(measuredAt === undefined ? {} : { measuredAt }) });

describe('sungAfter', () => {
  it.each<[string, number | undefined, number | undefined, boolean]>([
    ['a later time is after an earlier one', 2000, 1000, true],
    ['an earlier time is not after a later one', 1000, 2000, false],
    ['the same time is not after itself', 1000, 1000, false],
    ['a range with a time is after one kept before times were', 1000, undefined, true],
    ['a range with no time is after nothing', undefined, 1000, false],
    ['two ranges with no time are not after each other', undefined, undefined, false],
  ])('%s', (_name, a, b, expected) => {
    expect(sungAfter({ measuredAt: a }, { measuredAt: b })).toBe(expected);
  });
});

describe('deviceRangeWins: signing in with a range on the device and one on the account', () => {
  it.each<[string, number | undefined, number | undefined, boolean]>([
    ['the device sang it after the account', 2000, 1000, true],
    ['the account sang it after the device: the older device range never overwrites it', 1000, 2000, false],
    ['the same time on both: nothing to save', 1000, 1000, false],
    ['the account range has no time: the device wins, whatever its own time', 1000, undefined, true],
    ['neither has a time: the device wins, as the singer is on it now', undefined, undefined, true],
    ['only the account has a time: the device range is older than that', undefined, 1000, false],
  ])('%s', (_name, device, account, expected) => {
    expect(deviceRangeWins({ measuredAt: device }, { measuredAt: account })).toBe(expected);
  });
});

describe('fitsServer: a range the account can store', () => {
  // The same limits as PUT /api/me/range: whole notes from MIDI 28 to 96, spanning 5 to 48 semitones.
  it.each<[string, number, number, boolean]>([
    ['an ordinary range', 41, 72, true],
    ['the widest the server takes', 28, 76, true],
    ['the top of the scale', 91, 96, true],
    ['the narrowest the server takes', 60, 65, true],
    ['one semitone too narrow', 60, 64, false],
    ['one semitone too wide', 28, 77, false],
    ['a note below MIDI 28', 27, 50, false],
    ['a note above MIDI 96', 80, 97, false],
    ['notes that are not whole', 41.5, 72, false],
    ['a low note at or above the high note', 72, 72, false],
  ])('%s', (_name, low, high, expected) => {
    expect(fitsServer({ low, high })).toBe(expected);
  });
});

describe('newestOnDevice: a finished test in storage against the range kept on the device', () => {
  const pair = range(45, 72, 2000);
  const kept = range(40, 60, 1000);

  it('is whichever there is when only one is', () => {
    expect(newestOnDevice(pair, null)).toBe(pair);
    expect(newestOnDevice(null, kept)).toBe(kept);
    expect(newestOnDevice(null, null)).toBeNull();
  });

  it('keeps the finished test, which is the one in flight, unless the kept range was sung after it', () => {
    expect(newestOnDevice(pair, kept)).toBe(pair);
    expect(newestOnDevice(range(45, 72, 1000), range(40, 60, 1000))).toMatchObject({ low: 45 });
    expect(newestOnDevice(range(45, 72), range(40, 60))).toMatchObject({ low: 45 });
    expect(newestOnDevice(range(45, 72, 1000), range(40, 60, 2000))).toMatchObject({ low: 40 });
    expect(newestOnDevice(range(45, 72), range(40, 60, 2000))).toMatchObject({ low: 40 });
  });
});
