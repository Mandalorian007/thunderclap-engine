import { defineConfig } from '@playwright/test';

// The Electron smoke (e2e/shell.spec.ts): Playwright's Electron driver launches the built shell
// (out/, from `pnpm build`) on the desktop harness page. Run with `pnpm test:e2e` here or
// `pnpm test:e2e:desktop` from the repo root. One worker: each test starts its own app.
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
