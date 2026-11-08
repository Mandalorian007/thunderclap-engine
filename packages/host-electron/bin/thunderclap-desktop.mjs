#!/usr/bin/env node
// `thunderclap-desktop`: a game's desktop dev loop and packaging, from the installed
// @thunderclap-engine/host-electron alone (#2). Run it in the game's folder. Electron, Vite and
// electron-builder are the game's own dev dependencies, resolved from that folder, so this
// package keeps no runtime dependencies. See HELP below and the package README.
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builderConfig, kebab, readDesktopConfig } from './desktop-config.mjs';

const HELP = `thunderclap-desktop: run and package a game in the ThunderClap desktop shell

Usage (in the game's folder):
  thunderclap-desktop dev [--url <url> | --port <n> | --dist [dir]]
      Opens the game in Electron. By default starts the game's Vite dev server
      (its own vite.config) on 127.0.0.1 with hot reload in the window.
        --url <url>   use a dev server you already run (on this machine)
        --port <n>    port for the Vite dev server (default 5198)
        --dist [dir]  serve a built web app instead (default: the renderer, dist/)

  thunderclap-desktop package [--mac] [--win] [--linux] [--dir] [--renderer <dir>]
                              [--out <dir>] [--dry-run]
      Stages the built web app (run the game's build first) with the shell and runs
      electron-builder. Unsigned. Default target: this OS.
        --dir             unpacked app only, no installers
        --renderer <dir>  the built web app (default: thunderclap.desktop.renderer or dist)
        --out <dir>       where artefacts go (default: thunderclap.desktop.output or dist/desktop)
        --dry-run         stage the app, print what would be packaged, and stop

The game names itself in package.json:
  "thunderclap": { "desktop": { "productName": "My Game", "appId": "com.example.mygame",
                                "icon": "build/icon.png" } }
Optional keys: version (default: package.json version), executableName, renderer, output.

Dev dependencies the game installs: electron (dev, package), vite (dev),
electron-builder (package).
`;

/** This package's folder: Electron's app path when run unpackaged (package.json main = out/main.mjs). */
const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const gameDir = process.cwd();
const requireFromGame = createRequire(join(gameDir, 'package.json'));

const [command, ...args] = process.argv.slice(2);
const flag = (/** @type {string} */ f) => args.includes(f);
/** The value after `f`, or undefined when the flag is absent or has no value. */
const value = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
};

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`thunderclap-desktop: ${msg}`);
  process.exit(1);
}

/** The game's package.json, parsed. */
function gamePackage() {
  const file = join(gameDir, 'package.json');
  if (!existsSync(file)) fail(`no package.json in ${gameDir}; run this in the game's folder`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Resolves a dev dependency from the game's folder, with a pointer to install it. */
function fromGame(/** @type {string} */ name, /** @type {string} */ why) {
  try {
    return requireFromGame.resolve(name);
  } catch {
    return fail(`${why} needs "${name}": install it in the game (npm i -D ${name})`);
  }
}

async function dev() {
  let config;
  try {
    config = readDesktopConfig(gamePackage());
  } catch (e) {
    return fail(/** @type {Error} */ (e).message);
  }
  const electronBin = /** @type {string} */ (requireFromGame(fromGame('electron', 'dev')));
  const env = { ...process.env };
  /** @type {import('vite').ViteDevServer | null} */
  let server = null;
  let url = value('--url');
  if (flag('--dist')) {
    const dir = resolve(gameDir, value('--dist') ?? config.renderer);
    if (!existsSync(join(dir, 'index.html')))
      fail(`${dir} has no index.html; build the game first`);
    env.TC_RENDERER_DIR = dir;
    console.log(`thunderclap-desktop dev: ${dir}`);
  } else {
    if (!url) {
      const port = Number(value('--port') ?? 5198);
      if (!Number.isInteger(port) || port <= 0) fail('--port takes a port number');
      /** @type {typeof import('vite')} */
      const vite = await import(pathToFileURL(fromGame('vite', 'dev')).href);
      server = await vite.createServer({
        root: gameDir,
        clearScreen: false,
        server: { host: '127.0.0.1', port },
      });
      await server.listen();
      url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`;
    }
    env.TC_RENDERER_URL = url;
    console.log(`thunderclap-desktop dev: ${url}`);
  }
  const child = spawn(electronBin, [hostDir], { stdio: 'inherit', env });
  const stop = async (/** @type {number | null} */ code) => {
    await server?.close();
    process.exit(code ?? 0);
  };
  child.on('exit', (code) => void stop(code));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

/**
 * Builds the app folder electron-builder packages: the shell's out/main.mjs and out/preload.cjs,
 * the game's built web app as out/renderer/, and a package.json with no dependencies.
 * @param {Record<string, unknown>} pkg @param {import('./desktop-config.mjs').DesktopConfig} config
 * @param {string} renderer @param {string} output @param {string} stage
 */
function stageApp(pkg, config, renderer, output, stage) {
  mkdirSync(join(stage, 'out'), { recursive: true });
  for (const f of ['main.mjs', 'preload.cjs']) {
    const src = join(hostDir, 'out', f);
    if (!existsSync(src)) fail(`${src} is missing; reinstall @thunderclap-engine/host-electron`);
    cpSync(src, join(stage, 'out', f));
  }
  cpSync(renderer, join(stage, 'out/renderer'), {
    recursive: true,
    // The renderer folder may also hold earlier desktop builds (dist/desktop/): never package those.
    filter: (src) => {
      const p = resolve(src);
      return p !== output && !p.startsWith(`${output}${sep}`);
    },
  });
  /** @type {Record<string, unknown>} */
  const manifest = {
    name: kebab(config.productName),
    productName: config.productName,
    version: config.version,
    description: typeof pkg.description === 'string' ? pkg.description : config.productName,
    type: 'module',
    main: 'out/main.mjs',
  };
  for (const k of ['author', 'license', 'homepage']) if (pkg[k]) manifest[k] = pkg[k];
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function packageApp() {
  const pkg = gamePackage();
  let config;
  try {
    config = readDesktopConfig(pkg, { requireIdentity: true });
  } catch (e) {
    return fail(/** @type {Error} */ (e).message);
  }
  const renderer = resolve(gameDir, value('--renderer') ?? config.renderer);
  const output = resolve(gameDir, value('--out') ?? config.output);
  if (!existsSync(join(renderer, 'index.html'))) {
    fail(`${renderer} has no index.html; build the game first`);
  }
  const icon = config.icon ? resolve(gameDir, config.icon) : undefined;
  if (icon && !existsSync(icon)) fail(`icon ${icon} does not exist`);
  const dryRun = flag('--dry-run');

  // Outside the game's folder, so electron-builder finds no node_modules to collect.
  const stage = mkdtempSync(join(tmpdir(), 'thunderclap-desktop-'));
  try {
    stageApp(pkg, config, renderer, output, stage);
    const opts = {
      productName: config.productName,
      appId: config.appId,
      version: config.version,
      icon,
      executableName: config.executableName,
      output,
    };
    if (dryRun) {
      const files = listFiles(stage);
      console.log(
        `thunderclap-desktop package --dry-run: would package ${files.length} file(s) as ${config.productName} ${config.version} (${config.appId}) into ${output}\n  ${files.join('\n  ')}`,
      );
      console.log(JSON.stringify(builderConfig(opts), null, 2));
      return;
    }
    const electronPkg = JSON.parse(
      readFileSync(fromGame('electron/package.json', 'package'), 'utf8'),
    );
    /** @type {typeof import('electron-builder')} */
    const eb = await import(pathToFileURL(fromGame('electron-builder', 'package')).href);
    const ebConfig = builderConfig({ ...opts, electronVersion: electronPkg.version });

    // Never sign with a certificate: one in the local keychain is not picked up.
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    const platforms = [
      flag('--mac') && eb.Platform.MAC,
      flag('--win') && eb.Platform.WINDOWS,
      flag('--linux') && eb.Platform.LINUX,
    ].filter((p) => !!p);
    if (!platforms.length) platforms.push(eb.Platform.current());
    const targets = new Map();
    for (const p of platforms) {
      for (const [k, v] of p.createTarget(flag('--dir') ? 'dir' : undefined)) targets.set(k, v);
    }
    const files = await eb.build({
      projectDir: stage,
      config: ebConfig,
      targets,
      publish: 'never',
    });
    const out = files.filter((f) => !f.endsWith('.blockmap'));
    console.log(
      out.length
        ? `thunderclap-desktop package: ${out.length} artefact(s)\n  ${out.join('\n  ')}`
        : `thunderclap-desktop package: unpacked app in ${output}`,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Every file under `dir`, relative to it, sorted, with forward slashes. */
function listFiles(/** @type {string} */ dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

const wantsHelp = !command || ['--help', '-h', 'help'].includes(command) || flag('--help');
if (wantsHelp) console.log(HELP);
else if (command === 'dev') await dev();
else if (command === 'package') await packageApp();
else {
  console.error(`thunderclap-desktop: unknown command "${command}"\n`);
  console.error(HELP);
  process.exit(1);
}
