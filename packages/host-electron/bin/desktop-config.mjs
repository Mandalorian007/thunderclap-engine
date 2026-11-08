// The desktop packaging rules shared by `thunderclap-desktop package` (bin/thunderclap-desktop.mjs)
// and this repo's own `pnpm desktop:build` (electron-builder.config.mjs). Pure functions: no file
// system, no electron-builder import, so the published bin needs neither to load.

/** The keys a game may set under `thunderclap.desktop` in its package.json. */
export const DESKTOP_KEYS = /** @type {const} */ ([
  'productName',
  'appId',
  'icon',
  'version',
  'executableName',
  'renderer',
  'output',
]);

/**
 * @typedef {object} DesktopConfig
 * @property {string} productName Names the app and its `userData` folder, where saves live: never change it after a release.
 * @property {string} appId Reverse-DNS bundle id, for example `com.example.mygame`.
 * @property {string} [icon] A PNG of at least 512x512, relative to the game's folder.
 * @property {string} version Defaults to the game's package.json `version`.
 * @property {string} [executableName] The Linux executable; defaults to the product name in kebab case.
 * @property {string} renderer The built web app to package, relative to the game's folder (default `dist`).
 * @property {string} output Where installers go, relative to the game's folder (default `dist/desktop`).
 */

/**
 * Reads and checks the `thunderclap.desktop` field of a game's package.json.
 * @param {Record<string, unknown>} pkg the parsed package.json
 * @param {{ requireIdentity?: boolean }} [opts] `requireIdentity`: productName and appId must be set (packaging)
 * @returns {DesktopConfig}
 */
export function readDesktopConfig(pkg, opts = {}) {
  const tc = /** @type {Record<string, unknown> | undefined} */ (pkg.thunderclap);
  const raw = /** @type {Record<string, unknown>} */ (tc?.desktop ?? {});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('package.json "thunderclap.desktop" must be an object');
  }
  for (const k of Object.keys(raw)) {
    if (!(/** @type {readonly string[]} */ (DESKTOP_KEYS).includes(k))) {
      throw new Error(
        `package.json "thunderclap.desktop" has an unknown key "${k}" (known: ${DESKTOP_KEYS.join(', ')})`,
      );
    }
    if (typeof raw[k] !== 'string' || raw[k] === '') {
      throw new Error(`package.json "thunderclap.desktop.${k}" must be a non-empty string`);
    }
  }
  const str = (/** @type {string} */ k) => /** @type {string | undefined} */ (raw[k]);
  if (opts.requireIdentity) {
    const missing = ['productName', 'appId'].filter((k) => !str(k));
    if (missing.length) {
      throw new Error(
        `package.json "thunderclap.desktop" needs ${missing.join(' and ')} to package the app`,
      );
    }
  }
  const version = str('version') ?? (typeof pkg.version === 'string' ? pkg.version : '0.0.0');
  return {
    productName: str('productName') ?? 'ThunderClap',
    appId: str('appId') ?? 'dev.thunderclap.shell',
    icon: str('icon'),
    version,
    executableName: str('executableName'),
    renderer: str('renderer') ?? 'dist',
    output: str('output') ?? 'dist/desktop',
  };
}

/** `The Last Rune` → `the-last-rune`: a Linux executable or package name. */
export function kebab(/** @type {string} */ s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'app'
  );
}

/**
 * The electron-builder configuration for an app folder holding `out/main.mjs`, `out/preload.cjs`,
 * `out/renderer/` and a package.json. Unsigned: no certificate, key or notarisation credential is
 * used or read. macOS builds are ad-hoc signed ("-"), which lets Apple silicon run them.
 * @param {{ productName: string, appId: string, output: string, version?: string, icon?: string,
 *   executableName?: string, electronVersion?: string }} o
 * @returns {import('electron-builder').Configuration}
 */
export function builderConfig(o) {
  const fileStem = o.productName.replace(/\s+/g, '-');
  return {
    appId: o.appId,
    productName: o.productName,
    ...(o.electronVersion ? { electronVersion: o.electronVersion } : {}),
    // Electron names the app (and its userData folder, where localStorage lives) from this.
    extraMetadata: { productName: o.productName, ...(o.version ? { version: o.version } : {}) },
    ...(o.icon ? { icon: o.icon } : {}),
    copyright: 'MIT License',
    directories: { output: o.output },
    // Everything the app needs is bundled into out/ (main, preload, renderer). electron-builder
    // still collects node_modules from the project and the folders above it (a workspace root),
    // so they are excluded explicitly.
    files: ['out/**/*', 'package.json', '!**/node_modules/**'],
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
      executableName: o.executableName ?? kebab(o.productName),
    },
  };
}
