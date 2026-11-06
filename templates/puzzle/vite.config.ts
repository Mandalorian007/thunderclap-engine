import { defineConfig } from 'vite';
// import { pwaPlugin } from '@thunderclap/host-pwa/vite';

// Vite's defaults are the game's build. To ship it as an installable, offline-capable app, see
// "Installable" in CLAUDE.md: it is the plugin line below, one import and one host.
export default defineConfig({
  plugins: [
    // pwaPlugin({ manifest: { name: 'Pairs', theme_color: '#0b0d14', background_color: '#0b0d14', svg: ICON_SVG } }),
  ],
});
