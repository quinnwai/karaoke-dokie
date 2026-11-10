// Shared by the flow, funnel and app tests: the mic step (QWW-50) walked the usual way.

import type { BrowserInfo } from '../../src/lib/client/browser';
import type { FlowEvent } from '../../src/lib/client/flow';

export const IOS_SAFARI: BrowserInfo = { os: 'ios', browser: 'safari', inApp: null };
export const ANDROID_CHROME: BrowserInfo = { os: 'android', browser: 'chrome', inApp: null };
export const INSTAGRAM: BrowserInfo = { os: 'ios', browser: 'other', inApp: 'instagram' };

/** The mic step the usual way: the browser is not asked yet, the singer taps, it says yes, and the note follows. */
export const micOn: FlowEvent[] = [
  { type: 'micChecked', env: IOS_SAFARI, permission: 'prompt' },
  { type: 'micAsk' },
  { type: 'micGranted' },
];
