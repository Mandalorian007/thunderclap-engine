// electron-builder config for this repo's `pnpm desktop:build` (scripts/dist.mjs): the harness
// shell, or another built web app with --renderer. The rules (unsigned, asar, no node_modules,
// per-OS targets) live in bin/desktop-config.mjs and are the same ones the published
// `thunderclap-desktop package` uses for a game.
//
// The identity is a noun-free default; set TC_APP_ID, TC_PRODUCT_NAME, TC_APP_VERSION and TC_ICON
// (an absolute path to a PNG of at least 512x512) to override it here. A game uses the package's
// bin and its own package.json `thunderclap.desktop` field instead (README.md, Packaging a game).
// Output: dist/desktop/ at the repo root.
import { builderConfig } from './bin/desktop-config.mjs';

export default builderConfig({
  productName: process.env.TC_PRODUCT_NAME || 'ThunderClap',
  appId: process.env.TC_APP_ID || 'dev.thunderclap.shell',
  version: process.env.TC_APP_VERSION || undefined,
  icon: process.env.TC_ICON || undefined,
  output: '../../dist/desktop',
});
