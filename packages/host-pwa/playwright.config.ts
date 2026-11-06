import { defineConfig } from '@playwright/test';

// The PWA smoke (e2e/pwa.spec.ts): Chromium on the built harness (harness/dist, from
// `vite build harness`) served by `vite preview`. Run with `pnpm test:e2e` here or
// `pnpm test:e2e:pwa` from the repo root. Port 4551 stays clear of the engine matrix
// (4177/4178 plus E2E_PORT_OFFSET). One worker: the specs share one origin's worker registry.
const isCI = !!process.env.CI;
export const PORT = 4551;
export const URL = `http://127.0.0.1:${PORT}/`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `vite preview harness --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: URL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
