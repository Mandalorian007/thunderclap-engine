import { defineConfig } from 'vite';
import { pwaPlugin } from '../src/vite.ts';

// The harness build: `vite build harness` writes harness/dist (gitignored), which `vite preview`
// serves for e2e/pwa.spec.ts. `data/` is the runtime-cache prefix the smoke exercises.
export default defineConfig({
  base: '/',
  build: { target: 'es2022' },
  plugins: [
    pwaPlugin({
      manifest: {
        name: 'ThunderClap PWA harness',
        short_name: 'ThunderClap',
        theme_color: '#0b0d14',
        background_color: '#0b0d14',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b0d14"/><path d="M36 6 14 38h16l-4 20 24-32H34z" fill="#ffd166"/></svg>',
      },
      runtimeCache: ['data/'],
      maxRuntimeEntries: 4,
    }),
  ],
});
