// PostHog's traffic, passed on from our own origin (QWW-63). The folder's name is POSTHOG_PROXY_PATH; a test keeps the two
// together. Read per request, like the rest of PostHog's settings; with PostHog off there is nothing to forward to, so 404.
import { postHogUpstream } from '../../../src/lib/server/config';
import { proxyToPostHog } from '../../../src/lib/server/postHogProxy';

export const dynamic = 'force-dynamic';

async function forward(req: Request): Promise<Response> {
  const upstream = postHogUpstream(process.env);
  return upstream ? proxyToPostHog(req, upstream) : new Response(null, { status: 404 });
}

export { forward as GET, forward as POST };
