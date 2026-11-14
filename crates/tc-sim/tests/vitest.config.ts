import { defineConfig } from 'vitest/config';

// tc-sim's TypeScript interop test only: run by `cargo test -p tc-sim
// --test net`, which starts the server and sets TC_SIM_INTEROP_URL.
export default defineConfig({
  test: {
    include: ['crates/tc-sim/tests/*.test.ts'],
    testTimeout: 30_000,
  },
});
