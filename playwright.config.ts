import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled at /opt/pw-browsers in the cloud sandbox; elsewhere Playwright finds its own.
const executablePath = process.env.PW_CHROMIUM_PATH;
// E2E_PORT lets parallel checkouts run their own server without reusing another's. A second server,
// with duets and moods off as they ship (QWW-43), takes E2E_OFF_PORT (default: the next port);
// tests/e2e/duets-moods-off.spec.ts reads both. Parallel checkouts set both.
const port = Number(process.env.E2E_PORT ?? 3000);
const offPort = Number(process.env.E2E_OFF_PORT ?? port + 1);

const appEnv = {
  KARAOKE_STORE: 'memory',
  SPOTIFY_MOCK: '1',
  SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret!!',
  ADMIN_TOKEN: 'e2e-admin',
  // The demo's placeholder mood labels listed, and the event log on, so e2e covers both.
  MOODS_SHIPPED: 'upbeat,heartfelt',
  EVENTS: 'on',
  // Builds `window.setlist`, the Setlist tuner's test hook (spec §9). Only this build has it; production does not.
  NEXT_PUBLIC_SETLIST_TEST_HOOK: '1',
};

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['iPhone 13'],
    browserName: 'chromium',
    screenshot: 'on',
    // No page may play out of the speakers of the machine running the tests: Chromium is kept off them here and in every other launch below
    // (tests/e2e/fakeMic.ts, tests/e2e/screen.spec.ts), and what a page plays is silent (tests/helpers/silentWav.ts), since WebKit has no such switch.
    launchOptions: { executablePath, args: ['--disable-audio-output'] },
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
  ],
});
