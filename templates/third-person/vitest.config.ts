import { defineConfig } from 'vitest/config';

// Product tests only: the character generator, the cosmetics table and the controller's walk
// over the heightfield. The engine verifies the platform (WebGPU, skinning, input) itself.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
