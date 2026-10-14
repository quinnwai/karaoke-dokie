import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled at /opt/pw-browsers in the cloud sandbox; elsewhere Playwright finds its own.
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    ...devices['iPhone 13'],
    browserName: 'chromium',
    screenshot: 'on',
    launchOptions: { executablePath },
  },
  webServer: {
    command: 'npm run build && npm run start -- -p 3000',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 180_000,
    env: { KARAOKE_STORE: 'memory', SPOTIFY_MOCK: '1', SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret!!' },
  },
});
