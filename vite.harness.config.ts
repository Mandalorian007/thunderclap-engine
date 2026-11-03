import { defineConfig } from 'vite';

// Serves the noun-free engine harness page (harness/) to the engine e2e specs (e2e/).
export default defineConfig({
  root: 'harness',
  clearScreen: false,
});
