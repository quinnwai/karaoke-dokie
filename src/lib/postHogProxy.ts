// PostHog's traffic goes through our own origin (QWW-63). Ad and privacy blockers refuse *.posthog.com (AdGuard's tracking
// list blocks the whole i.posthog.com host; EasyPrivacy blocks its retries and its replay), so a tester running one sent
// nothing to PostHog from production. The screen now sends to POSTHOG_PROXY_PATH on our own origin, and the route under
// app/roadie forwards it (src/lib/server/postHogProxy.ts). Shared by the screen and the server so they cannot drift apart.

/**
 * The path PostHog's traffic goes to on our own origin. It is also the folder under app/ that answers it (a test keeps
 * the two together). Not PostHog's suggested /ingest, which the block lists name (uBlock's privacy list and AdGuard both
 * match /ingest/...ip=): pick a name nothing else uses, and check it against the lists again before changing it.
 */
export const POSTHOG_PROXY_PATH = '/roadie';

/**
 * The session recorder's file, as PostHog serves it. EasyPrivacy and AdGuard's tracking list block this file name under
 * any path, ours included, so on our origin it goes by another name.
 */
const RECORDER_FILE = '/posthog-recorder.js';
const RECORDER_ALIAS = '/reel.js';

/** The path the screen asks our origin for: PostHog's own, with the recorder's file renamed. */
export function toProxyPath(pathname: string): string {
  return pathname.endsWith(RECORDER_FILE) ? pathname.slice(0, -RECORDER_FILE.length) + RECORDER_ALIAS : pathname;
}

/** The reverse of toProxyPath: the path as PostHog knows it. */
export function fromProxyPath(pathname: string): string {
  return pathname.endsWith(RECORDER_ALIAS) ? pathname.slice(0, -RECORDER_ALIAS.length) + RECORDER_FILE : pathname;
}
