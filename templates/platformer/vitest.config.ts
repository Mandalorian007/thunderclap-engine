import { defineConfig } from 'vitest/config';

// Product tests only: the level parser, the physics, the camera and the save schema. The engine
// verifies the platform.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
