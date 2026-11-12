import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled at /opt/pw-browsers in the cloud sandbox; elsewhere Playwright finds its own.
const executablePath = process.env.PW_CHROMIUM_PATH;
// E2E_PORT lets parallel checkouts run their own server without reusing another's. A second server,
// with duets and moods off as they ship (QWW-43), takes E2E_OFF_PORT (default: the next port);
// tests/e2e/duets-moods-off.spec.ts reads both. Parallel checkouts set both.
const port = Number(process.env.E2E_PORT ?? 3000);
const offPort = Number(process.env.E2E_OFF_PORT ?? port + 1);
// A third server from the same build, with PostHog on and forwarding to a stand-in for it (QWW-63);
// tests/e2e/posthog-proxy.spec.ts reads both ports. Parallel checkouts set these two as well.
const postHogPort = Number(process.env.E2E_POSTHOG_PORT ?? port + 2);
const postHogStubPort = Number(process.env.E2E_POSTHOG_STUB_PORT ?? port + 3);

const appEnv = {
  KARAOKE_STORE: 'memory',
  SPOTIFY_MOCK: '1',
  SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret!!',
  ADMIN_TOKEN: 'e2e-admin',
  // The demo's placeholder mood labels listed, and the event log on, so e2e covers both.
  MOODS_SHIPPED: 'upbeat,heartfelt',
  EVENTS: 'on',
  // PostHog off, set but empty so a shell (or a .env.local) that has the real key cannot turn it on and send test traffic
  // to the real project. Only the third server below has it, pointed at a stand-in.
  NEXT_PUBLIC_POSTHOG_KEY: '',
  NEXT_PUBLIC_POSTHOG_HOST: '',
};

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['iPhone 13'],
    browserName: 'chromium',
    screenshot: 'on',
    launchOptions: { executablePath },
  },
  webServer: [
    {
      // Duets and moods on, and the title screen's pick-songs link, so the e2e that covers their chips,
      // part lines and the pick flow keeps running.
      command: `npm run build && npm run start -- -p ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: { ...appEnv, DUETS_AND_MOODS: 'on', PICK_SONGS: 'on' },
    },
    {
      // The same build, as it ships: the switches are empty (not just left out, so a shell that has them on
      // cannot leak in) while both moods stay listed in MOODS_SHIPPED, which shows the switch is what hides
      // them. Playwright sets its servers up one after the other, so the build above is done by now.
      command: `npm run start -- -p ${offPort}`,
      url: `http://127.0.0.1:${offPort}`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { ...appEnv, DUETS_AND_MOODS: '', PICK_SONGS: '' },
    },
    {
      // The same build with PostHog on, forwarding to the stand-in below, so the whole path PostHog's traffic takes runs
      // offline: screen, our /roadie route, PostHog (tests/e2e/posthog-proxy.spec.ts). It has a store of its own, so the
      // event-log counts of the other two servers are not touched.
      command: `npm run start -- -p ${postHogPort}`,
      url: `http://127.0.0.1:${postHogPort}`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        ...appEnv,
        DUETS_AND_MOODS: '',
        PICK_SONGS: '',
        NEXT_PUBLIC_POSTHOG_KEY: 'phc_e2etestkey',
        NEXT_PUBLIC_POSTHOG_HOST: `http://127.0.0.1:${postHogStubPort}`,
      },
    },
    {
      // The stand-in for PostHog's cloud: answers as it does and writes every request down.
      command: 'npx tsx tests/e2e/posthogStub.ts',
      url: `http://127.0.0.1:${postHogStubPort}/__requests`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { E2E_POSTHOG_STUB_PORT: String(postHogStubPort) },
    },
  ],
});
