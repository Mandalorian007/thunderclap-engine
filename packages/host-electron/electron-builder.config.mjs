// electron-builder config for the ThunderClap shell (D-041, Phase 4). Unsigned: no certificate,
// key or notarisation credential is used or read (code signing is an open question, README.md).
// macOS builds are ad-hoc signed ("-"), which needs no certificate and lets Apple silicon run
// the app after the quarantine prompt.
//
// The app identity is a noun-free default; a game sets its own through the environment when it
// packages its renderer (ws/last-rune-desktop): TC_APP_ID, TC_PRODUCT_NAME, TC_APP_VERSION and
// TC_ICON (an absolute path to a PNG of at least 512x512; electron-builder makes the .icns and
// .ico from it). Without TC_ICON the build uses Electron's default icon. Artefact file names
// start with the product name with spaces turned into dashes ("The-Last-Rune-1.0.0-mac-arm64.dmg").
// Output: dist/desktop/ at the repo root. Run through scripts/dist.mjs.

const productName = process.env.TC_PRODUCT_NAME || 'ThunderClap';
const version = process.env.TC_APP_VERSION;
const icon = process.env.TC_ICON || undefined;
const fileStem = productName.replace(/\s+/g, '-');

/** @type {import('electron-builder').Configuration} */
export default {
  appId: process.env.TC_APP_ID || 'dev.thunderclap.shell',
  productName,
  // Electron names the app (and its userData folder, where localStorage lives) from this.
  extraMetadata: { productName, ...(version ? { version } : {}) },
  ...(icon ? { icon } : {}),
  copyright: 'MIT License',
  directories: { output: '../../dist/desktop' },
  // Everything the app needs is bundled into out/ (main, preload, renderer); no node_modules.
  files: ['out/**/*', 'package.json'],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  publish: null,
  // The escaped \${…} are electron-builder's own macros, filled in at packaging time.
  artifactName: `${fileStem}-\${version}-\${os}-\${arch}.\${ext}`,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.games',
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: { writeUpdateInfo: false },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    signAndEditExecutable: true,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    differentialPackage: false,
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'tar.gz', arch: ['x64'] },
    ],
    category: 'Game',
    executableName: productName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  },
};
