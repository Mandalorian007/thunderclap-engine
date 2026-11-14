import { defineConfig } from 'vitest/config';

// The client's rules twin and its schema hash, against shared/. The server tests itself (cargo).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
