import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled at /opt/pw-browsers in the cloud sandbox; elsewhere Playwright finds its own.
const executablePath = process.env.PW_CHROMIUM_PATH;
// E2E_PORT lets parallel checkouts run their own server without reusing another's. A second server,
// with duets and moods off as they ship (QWW-43), takes the next port; tests/e2e/duets-moods-off.spec.ts reads it.
const port = Number(process.env.E2E_PORT ?? 3000);
const offPort = port + 1;

const appEnv = {
  KARAOKE_STORE: 'memory',
  SPOTIFY_MOCK: '1',
  SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret!!',
  ADMIN_TOKEN: 'e2e-admin',
  // The demo's placeholder mood labels listed, and the event log on, so e2e covers both.
  MOODS_SHIPPED: 'upbeat,heartfelt',
  EVENTS: 'on',
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
      // Duets and moods on, so the e2e that covers their chips and part lines keeps running.
      command: `npm run build && npm run start -- -p ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: { ...appEnv, DUETS_AND_MOODS: 'on' },
    },
    {
      // The same build, as it ships: the switch is empty (not just left out, so a shell that has it on
      // cannot leak in) while both moods stay listed in MOODS_SHIPPED, which shows the switch is what hides
      // them. Playwright sets its servers up one after the other, so the build above is done by now.
      command: `npm run start -- -p ${offPort}`,
      url: `http://127.0.0.1:${offPort}`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { ...appEnv, DUETS_AND_MOODS: '' },
    },
  ],
});
