#!/usr/bin/env node
// `pnpm check:pack`: proves the four npm packages work as a stranger would install them (E-037).
//
//   1. `pnpm build`, then `pnpm pack` each package (pnpm swaps in `publishConfig` and rewrites
//      `workspace:` ranges, exactly as a publish of that tarball would).
//   2. Inspects every tarball: each file must fall under the manifest's `files` (plus the
//      package.json npm always adds), nothing from src/, no tests, no TypeScript source, every
//      `exports` target present, no `workspace:` range, no `private`.
//   3. Proves the publish guard (ws/publish-2): `npm publish --dry-run` in each package folder
//      fails with the message from scripts/refuse-publish.mjs, and `npm publish --dry-run` of
//      each tarball succeeds. Both point npm at a dead local registry, so nothing leaves the
//      machine. Also checks CHANGELOG.md has a section for the root version, which publish.yml
//      turns into the GitHub Release (scripts/publish-notes.mjs).
//   4. Installs the tarballs with npm into a fresh project in the OS temp folder, outside the
//      workspace, then typechecks (Bundler and NodeNext resolution, skipLibCheck off) and
//      Vite-builds a page that imports the root, /render, /input, /ui, /voxel and each host's
//      create function. Node also loads `@thunderclap-engine/host-pwa/vite` natively, as a vite.config does.
//   5. Runs host-electron's bin (#2) through npm's `.bin` link: `thunderclap-desktop --help`, then
//      `thunderclap-desktop package --dry-run`, which stages the Vite build with the shell under
//      the consumer's `thunderclap.desktop` identity (no Electron or electron-builder needed).
//   6. Typechecks the consumer again with @types/webxr installed beside the engine (skipLibCheck
//      off, E-039), passing @types/webxr's own `XRSession`, `XRFrame` and `XRReferenceSpace` to
//      `createXrHost`, `XrSurface`, `XrPointerSource` and `createGame({ xr })`. The engine's XR
//      types are module exports and a structural subset of @types/webxr's, so nothing clashes.
//
// The tooling (typescript, vite) is linked in from this repo's node_modules, and @types/webxr
// comes from a pinned tarball in scripts/fixtures/ (WEBXR_TARBALL), so the check needs no network.
//   --keep            leave the temp folder for inspection
//   --from-npm        skip steps 1-3 and install each package at its package.json version from
//                     the npm registry instead of from tarballs (publish.yml, after publishing)
//   --wait <seconds>  with --from-npm, first poll the registry until every version is listed,
//                     failing after that long (default 0: no polling)
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distTag } from './release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const fromNpm = argv.includes('--from-npm');
/** @types/webxr, vendored (`npm pack @types/webxr@0.5.24`) so step 6 runs offline. */
const WEBXR_TARBALL = join(root, 'scripts', 'fixtures', 'types-webxr-0.5.24.tgz');
const waitAt = argv.indexOf('--wait');
const waitSeconds = waitAt === -1 ? 0 : Number(argv[waitAt + 1]);
if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
  console.error('check:pack: --wait takes a number of seconds');
  process.exit(1);
}
// Nothing listens here, so a dry-run publish cannot reach a real registry.
const DEAD_REGISTRY = 'http://127.0.0.1:9';
// A host's engine peer: 1.x, and the 2.0 prereleases (semver ranges skip a prerelease unless the
// range names one; docs/releasing.md, "Prereleases").
const ENGINE_PEER = '^1.0.0 || >=2.0.0-next.0 <3';
const packages = [
  { dir: '.', name: '@thunderclap-engine/engine' },
  { dir: 'packages/host-capacitor', name: '@thunderclap-engine/host-capacitor' },
  { dir: 'packages/host-electron', name: '@thunderclap-engine/host-electron' },
  { dir: 'packages/host-pwa', name: '@thunderclap-engine/host-pwa' },
];

const NODE_CHECK = `import { pwaPlugin } from '@thunderclap-engine/host-pwa/vite'; console.log(typeof pwaPlugin);`;

const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8" /><title>pack smoke</title></head>
<body><canvas id="c"></canvas><script type="module" src="./main.ts"></script></body></html>
`;

const MAIN_TS = `import { createGame } from '@thunderclap-engine/engine';
import { Camera } from '@thunderclap-engine/engine/render';
import { Input } from '@thunderclap-engine/engine/input';
import { createMeter } from '@thunderclap-engine/engine/ui';
import { createVoxelGrid } from '@thunderclap-engine/engine/voxel';
import { createCapacitorHost } from '@thunderclap-engine/host-capacitor';
import { createElectronHost } from '@thunderclap-engine/host-electron';
import { createPwaHost } from '@thunderclap-engine/host-pwa';

const used: unknown[] = [
  createGame,
  Camera,
  Input,
  createMeter,
  createVoxelGrid,
  createCapacitorHost,
  createElectronHost,
  createPwaHost,
];
const device: GPUDevice | null = null;
console.log(used.length, device);
`;

// Step 6: @types/webxr's globals beside the engine, and its values into every XR entry point.
const XR_TS = `import { createGame } from '@thunderclap-engine/engine';
import { createXrHost, defaultHost } from '@thunderclap-engine/engine/host';
import { XrPointerSource } from '@thunderclap-engine/engine/input';
import { XrSurface } from '@thunderclap-engine/engine/platform';

export function enterVr(
  session: XRSession,
  frame: XRFrame,
  space: XRReferenceSpace,
  device: GPUDevice,
): unknown[] {
  const host = createXrHost(session, defaultHost());
  const surface = new XrSurface(session, device, { referenceSpace: space });
  const eyes = surface.views(frame);
  const pointers = new XrPointerSource(session, space, () => frame);
  const sys: XRSystem | undefined = navigator.xr;
  const game = createGame({
    input: { bindings: { select: [{ xr: 'trigger' }] } },
    xr: {
      referenceSpace: 'local-floor',
      onEnter(s: XRSession) {
        console.log(s.visibilityState);
      },
    },
  });
  return [host.frame, eyes.length, pointers, sys, game];
}
`;

const problems = [];
// pnpm's own npm_config_* variables make npm warn; the consumer gets a plain environment.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_config_')),
);
/** Runs a command and returns its stdout; on failure the error message carries that stdout. */
const run = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
  } catch (e) {
    throw new Error(`${cmd} ${args.join(' ')}\n${e.stdout ?? ''}`);
  }
};
const step = (msg) => console.log(`check:pack: ${msg}`);

const tmp = mkdtempSync(join(tmpdir(), 'thunderclap-pack-'));
const tarballs = join(tmp, 'tarballs');
const app = join(tmp, 'app');
mkdirSync(tarballs);
mkdirSync(app);

try {
  if (fromNpm) {
    for (const p of packages) {
      const { version } = JSON.parse(readFileSync(join(root, p.dir, 'package.json'), 'utf8'));
      p.version = version;
      p.spec = `${p.name}@${version}`;
    }
    if (waitSeconds > 0) await waitForRegistry(waitSeconds);
  } else {
    step('building');
    execFileSync('node', [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });

    // 1-2. Pack and inspect.
    for (const p of packages) {
      const before = new Set(readdirSync(tarballs));
      run('pnpm', ['pack', '--pack-destination', tarballs], join(root, p.dir));
      const file = readdirSync(tarballs).find((f) => f.endsWith('.tgz') && !before.has(f));
      if (!file) throw new Error(`${p.name}: pnpm pack wrote no tarball`);
      p.spec = join(tarballs, file);
      inspect(p);
    }
    if (problems.length) throw new Error(`tarball problems:\n  ${problems.join('\n  ')}`);

    // 3. The publish guard, and the release notes publish.yml will need.
    for (const p of packages) checkPublishGuard(p);
    if (problems.length) throw new Error(`publish guard problems:\n  ${problems.join('\n  ')}`);
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    run('node', [join(root, 'scripts/publish-notes.mjs'), version], root);
    step(`CHANGELOG.md has a ${version} section`);
  }

  // 4. A fresh consumer.
  step(
    `installing ${fromNpm ? packages.map((p) => p.spec).join(' ') : 'the tarballs'} into ${app}`,
  );
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pack-smoke',
        version: '0.0.1',
        private: true,
        type: 'module',
        thunderclap: { desktop: { productName: 'Pack Smoke', appId: 'dev.thunderclap.packsmoke' } },
      },
      null,
      2,
    )}\n`,
  );
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      ...(fromNpm ? ['--prefer-online'] : []),
      ...packages.map((p) => p.spec),
      // In the same install: a second `npm install` would prune the tooling links below.
      WEBXR_TARBALL,
    ],
    app,
  );
  for (const dep of ['typescript', 'vite']) {
    const to = join(app, 'node_modules', dep);
    mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to)) symlinkSync(join(root, 'node_modules', dep), to, 'dir');
  }

  writeFileSync(join(app, 'main.ts'), MAIN_TS);
  writeFileSync(join(app, 'index.html'), INDEX_HTML);
  const tsconfig = (module, resolution) => ({
    compilerOptions: {
      target: 'ES2022',
      module,
      moduleResolution: resolution,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: [],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    files: ['main.ts'],
  });
  writeFileSync(join(app, 'tsconfig.json'), JSON.stringify(tsconfig('ESNext', 'Bundler')));
  writeFileSync(join(app, 'tsconfig.node.json'), JSON.stringify(tsconfig('NodeNext', 'NodeNext')));

  const tsc = join(app, 'node_modules', 'typescript', 'bin', 'tsc');
  step('typecheck (Bundler resolution)');
  run('node', [tsc, '-p', 'tsconfig.json'], app);
  step('typecheck (NodeNext resolution)');
  run('node', [tsc, '-p', 'tsconfig.node.json'], app);

  step('vite build');
  const vite = join(app, 'node_modules', 'vite', 'bin', 'vite.js');
  run('node', [vite, 'build', '--logLevel', 'warn', '--outDir', 'dist'], app);
  if (!readdirSync(join(app, 'dist', 'assets')).some((f) => f.endsWith('.js'))) {
    throw new Error('vite build wrote no script');
  }

  step('node loads @thunderclap-engine/host-pwa/vite');
  const out = run('node', ['--input-type=module', '-e', NODE_CHECK], app).trim();
  if (out !== 'function') throw new Error(`pwaPlugin is ${out}, not a function`);

  // The desktop entry points (#2), through the bin link npm made, as a game's script runs them.
  const desktop = join(app, 'node_modules', '.bin', 'thunderclap-desktop');
  step('thunderclap-desktop --help');
  const help = run(desktop, ['--help'], app);
  if (!help.includes('thunderclap-desktop dev') || !help.includes('thunderclap-desktop package')) {
    throw new Error(`thunderclap-desktop --help printed no usage:\n${help}`);
  }
  step('thunderclap-desktop package --dry-run (stages the vite build with the shell)');
  const staged = run(desktop, ['package', '--dry-run'], app);
  for (const f of ['out/main.mjs', 'out/preload.cjs', 'out/renderer/index.html', 'package.json']) {
    if (!staged.split('\n').some((l) => l.trim() === f)) {
      throw new Error(`thunderclap-desktop package --dry-run did not stage ${f}:\n${staged}`);
    }
  }
  if (!staged.includes('"appId": "dev.thunderclap.packsmoke"')) {
    throw new Error(
      `thunderclap-desktop package --dry-run ignored thunderclap.desktop:\n${staged}`,
    );
  }

  // 6. A consumer with @types/webxr and skipLibCheck off (E-039): the engine declares no WebXR
  // globals, and @types/webxr's values pass to its XR entry points.
  writeFileSync(join(app, 'xr.ts'), XR_TS);
  for (const [module, resolution] of [
    ['ESNext', 'Bundler'],
    ['NodeNext', 'NodeNext'],
  ]) {
    step(`typecheck with @types/webxr (${resolution} resolution)`);
    const c = tsconfig(module, resolution);
    c.compilerOptions.types = ['webxr'];
    c.files = ['main.ts', 'xr.ts'];
    writeFileSync(join(app, 'tsconfig.webxr.json'), JSON.stringify(c));
    run('node', [tsc, '-p', 'tsconfig.webxr.json'], app);
  }

  step('ok');
} catch (e) {
  console.error(`check:pack: FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (keep) step(`kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

/** Runs `npm publish --dry-run` against the dead registry; returns its status and all output. */
function dryPublish(args, cwd) {
  const r = spawnSync(
    'npm',
    ['publish', '--dry-run', '--ignore-scripts=false', '--registry', DEAD_REGISTRY, ...args],
    { cwd, env, encoding: 'utf8' },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A folder publish must be refused with a pointer at docs/releasing.md; the tarball's must not. */
function checkPublishGuard(p) {
  const before = problems.length;
  const folder = dryPublish([], join(root, p.dir));
  if (folder.status === 0) problems.push(`${p.name}: npm publish in ${p.dir} was not refused`);
  else if (!folder.out.includes('docs/releasing.md')) {
    problems.push(`${p.name}: npm publish in ${p.dir} failed without the refusal:\n${folder.out}`);
  }
  // The same dist-tag publish.yml passes: npm refuses a prerelease without an explicit --tag.
  const { version } = JSON.parse(readFileSync(join(root, p.dir, 'package.json'), 'utf8'));
  const tarball = dryPublish([p.spec, '--tag', distTag(version)], tmp);
  if (tarball.status !== 0) {
    problems.push(`${p.name}: npm publish of the packed tarball failed:\n${tarball.out}`);
  }
  if (problems.length === before) step(`${p.name}: folder publish refused, tarball accepted`);
}

/** Polls `npm view` until every package's version is on the registry; throws after `seconds`. */
async function waitForRegistry(seconds) {
  const deadline = Date.now() + seconds * 1000;
  let missing = packages;
  for (;;) {
    missing = missing.filter((p) => {
      const r = spawnSync('npm', ['view', p.spec, 'version', '--prefer-online'], {
        env,
        encoding: 'utf8',
      });
      return r.status !== 0 || r.stdout.trim() !== p.version;
    });
    if (!missing.length) return step('every version is on the registry');
    const names = missing.map((p) => p.spec).join(' ');
    if (Date.now() >= deadline) throw new Error(`not on the registry after ${seconds}s: ${names}`);
    step(`waiting for ${names}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** Lists a tarball and checks it against its own packed manifest. */
function inspect(p) {
  const list = run('tar', ['-tzf', p.spec])
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ''));
  const manifest = JSON.parse(run('tar', ['-xzOf', p.spec, 'package/package.json']));
  const files = manifest.files ?? [];
  const allowed = (f) =>
    f === 'package.json' || files.some((e) => f === e || f.startsWith(`${e.replace(/\/$/, '')}/`));
  const fail = (msg) => problems.push(`${p.name}: ${msg}`);

  for (const f of list) {
    if (!allowed(f)) fail(`${f} is outside "files"`);
    if (/(^|\/)src\//.test(f)) fail(`${f} is source`);
    if (/\.(test|spec)\.|test-util/.test(f)) fail(`${f} is a test file`);
    if (/\.(ts|tsx|mts|cts)$/.test(f) && !/\.d\.(ts|mts|cts)$/.test(f)) fail(`${f} is TypeScript`);
  }
  if (manifest.private) fail('manifest is private');
  if (JSON.stringify(manifest).includes('workspace:')) fail('manifest has a workspace: range');
  const targets = [];
  const walk = (v) => {
    if (typeof v === 'string') targets.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(manifest.exports);
  if (manifest.types) targets.push(manifest.types);
  for (const t of targets) {
    if (!list.includes(t.replace(/^\.\//, ''))) fail(`exports target ${t} is not in the tarball`);
  }
  if (
    p.name !== '@thunderclap-engine/engine' &&
    manifest.peerDependencies?.['@thunderclap-engine/engine'] !== ENGINE_PEER
  ) {
    fail(`@thunderclap-engine/engine must be a ${ENGINE_PEER} peer`);
  }
  const kb = (readFileSync(p.spec).length / 1024).toFixed(1);
  step(`${p.name}@${manifest.version}: ${list.length} files, ${kb} kB packed`);
}
