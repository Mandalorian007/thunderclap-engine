import { defineConfig } from 'vitest/config';

// Unit tests: the host against fake plugins, in Node with happy-dom opted in per file. The
// Capacitor packages themselves are never loaded.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
