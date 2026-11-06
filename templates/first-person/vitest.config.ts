import { defineConfig } from 'vitest/config';

// Product tests only: the pure terrain generator and the mesher. The engine verifies the platform.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
