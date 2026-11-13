import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PostHog's requests end in a slash (/e/, /s/, /flags/) and go to app/roadie as they are (QWW-63). The default redirect
  // that strips a trailing slash would answer each with a 308 first.
  skipTrailingSlashRedirect: true,
  // The Setlist tuner's test hook (`window.setlist`, QWW-46) is built only when this is '1', which is the e2e build
  // (playwright.config.ts). Next inlines a NEXT_PUBLIC_ variable only if it is defined when the app is built, so it is
  // always defined here, empty when unset: a normal build then sees a constant and drops the hook's code.
  env: { NEXT_PUBLIC_SETLIST_TEST_HOOK: process.env.NEXT_PUBLIC_SETLIST_TEST_HOOK ?? '' },
};

export default nextConfig;
