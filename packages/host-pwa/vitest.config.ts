import { defineConfig } from 'vitest/config';

// Unit tests: the worker's routing and trimming as pure functions, the manifest and HTML
// injection on fakes, and `createPwaHost` against a fake `navigator.serviceWorker` (happy-dom,
// opted in per file). The built worker is covered by e2e/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
