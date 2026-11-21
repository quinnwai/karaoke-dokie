import { defineConfig, devices } from '@playwright/test';

// The @live suite (QWW-93): the same scenarios against a deployed Vercel preview, in the browsers Quinn-Wai tests with.
// No web server and no mocks: PREVIEW_URL is the deployment, the data is whatever it reads (production's Neon today, so the
// suite only reads; tests/live/helpers.ts keeps the event log and PostHog out of it). A protected preview needs
// VERCEL_AUTOMATION_BYPASS_SECRET, sent to the preview's own origin only.
const baseURL = (process.env.PREVIEW_URL ?? '').replace(/\/$/, '');
if (!baseURL) throw new Error('Set PREVIEW_URL to the deployment to test (npm run e2e:preview -- <url> does it).');

export default defineConfig({
  testDir: 'tests/live',
  outputDir: 'test-results/live',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/live' }]] : 'list',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // WebKit as an iPhone: touch, no hover, 390x844 (what Quinn-Wai holds). Emulated, not a real phone.
    {
      name: 'iphone-webkit',
      use: { ...devices['iPhone 13'], browserName: 'webkit', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
});
