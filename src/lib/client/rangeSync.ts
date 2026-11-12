// Which range the singer sang last (QWW-66). A range lives in two places: on the device (`kd.range`, what the signed-out
// list uses) and on the account (what the signed-in list used to use alone), and they drifted apart: the account held
// F2 to C4 while the device and its header said F#2 to C5, so the same singer got two lists. The range sung last wins in
// both places, so each range carries the time it was sung (`VocalRange.measuredAt`).

import type { VocalRange } from '../contracts';

type Timed = Pick<VocalRange, 'measuredAt'>;

/**
 * `a` was sung after `b`. A range with no time was kept before times were recorded, so any range with one is after it,
 * and two ranges with no time are not after each other.
 */
export const sungAfter = (a: Timed, b: Timed): boolean => a.measuredAt != null && (b.measuredAt == null || a.measuredAt > b.measuredAt);

/**
 * Whether the device's range goes to the account when the singer signs in with both. The range sung last wins. An account
 * range with no time was saved before times were recorded, so nothing says it is newer: the device's wins, since the
 * singer is on it now. The same time on both is the same measurement, with nothing to save.
 */
export const deviceRangeWins = (device: Timed, account: Timed): boolean => account.measuredAt == null || sungAfter(device, account);

/**
 * The range this device holds, for two candidates: the finished test left in session storage (the one in flight, across
 * the Spotify round trip or a reload) and the range kept in local storage. The test in flight wins unless the kept
 * range was sung after it.
 */
export function newestOnDevice(finishedTest: VocalRange | null, kept: VocalRange | null): VocalRange | null {
  if (!finishedTest) return kept;
  if (!kept) return finishedTest;
  return sungAfter(kept, finishedTest) ? kept : finishedTest;
}
