import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PostHog's requests end in a slash (/e/, /s/, /flags/) and go to app/roadie as they are (QWW-63). The default redirect
  // that strips a trailing slash would answer each with a 308 first.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
