import { defineConfig } from 'vitest/config';

// Product tests only: the pure rules and the save schema. The engine verifies the platform.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
