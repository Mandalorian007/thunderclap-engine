import { defineConfig } from 'vitest/config';

// Unit tests: the renderer host against a fake bridge (happy-dom, opted in per file) and the
// main process's pure policy and switch functions. The real shell is covered by e2e/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
