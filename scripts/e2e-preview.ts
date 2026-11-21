// The @live suite against one deployment (QWW-93): the same command CI runs on every PR's preview, so an agent runs exactly
// what Quinn-Wai is shown before handing off.
// Usage: npm run e2e:preview -- <preview url> [playwright args, e.g. --project=iphone-webkit]
// A protected preview needs VERCEL_AUTOMATION_BYPASS_SECRET (the project's "Protection Bypass for Automation" secret).
import { spawnSync } from 'node:child_process';

const [url, ...rest] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) {
  console.error('Usage: npm run e2e:preview -- <preview url> [playwright args]');
  process.exit(2);
}
const r = spawnSync('npx', ['playwright', 'test', '-c', 'playwright.live.config.ts', ...rest], {
  stdio: 'inherit',
  env: { ...process.env, PREVIEW_URL: url },
});
process.exit(r.status ?? 1);
