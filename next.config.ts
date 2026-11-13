import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Setlist tuner's test hook (`window.setlist`, QWW-46) is built only when this is '1', which is the e2e build
  // (playwright.config.ts). Next inlines a NEXT_PUBLIC_ variable only if it is defined when the app is built, so it is
  // always defined here, empty when unset: a normal build then sees a constant and drops the hook's code.
  env: { NEXT_PUBLIC_SETLIST_TEST_HOOK: process.env.NEXT_PUBLIC_SETLIST_TEST_HOOK ?? '' },
};

export default nextConfig;
