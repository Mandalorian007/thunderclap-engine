import { defineConfig } from 'vitest/config';

// Engine unit tests only. DOM tests opt in per file with `// @vitest-environment happy-dom`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
