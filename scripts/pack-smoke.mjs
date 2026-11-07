#!/usr/bin/env node
// `pnpm check:pack`: proves the four npm packages work as a stranger would install them (E-037).
//
//   1. `pnpm build`, then `pnpm pack` each package (pnpm swaps in `publishConfig` and rewrites
//      `workspace:` ranges, exactly as a publish of that tarball would).
//   2. Inspects every tarball: each file must fall under the manifest's `files` (plus the
//      package.json npm always adds), nothing from src/, no tests, no TypeScript source, every
//      `exports` target present, no `workspace:` range, no `private`.
//   3. Installs the tarballs with npm into a fresh project in the OS temp folder, outside the
//      workspace, then typechecks (Bundler and NodeNext resolution, skipLibCheck off) and
//      Vite-builds a page that imports the root, /render, /input, /ui, /voxel and each host's
//      create function. Node also loads `@thunderclap/host-pwa/vite` natively, as a vite.config does.
//
// The tooling (typescript, vite, @webgpu/types) is linked in from this repo's node_modules, so
// the check needs no network.
//   --keep   leave the temp folder for inspection
import { execFileSync } from 'node:child_process';
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const packages = [
  { dir: '.', name: '@thunderclap/engine' },
  { dir: 'packages/host-capacitor', name: '@thunderclap/host-capacitor' },
  { dir: 'packages/host-electron', name: '@thunderclap/host-electron' },
  { dir: 'packages/host-pwa', name: '@thunderclap/host-pwa' },
];

const NODE_CHECK = `import { pwaPlugin } from '@thunderclap/host-pwa/vite'; console.log(typeof pwaPlugin);`;

const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8" /><title>pack smoke</title></head>
<body><canvas id="c"></canvas><script type="module" src="./main.ts"></script></body></html>
`;

const MAIN_TS = `import { createGame } from '@thunderclap/engine';
import { Camera } from '@thunderclap/engine/render';
import { Input } from '@thunderclap/engine/input';
import { createMeter } from '@thunderclap/engine/ui';
import { createVoxelGrid } from '@thunderclap/engine/voxel';
import { createCapacitorHost } from '@thunderclap/host-capacitor';
import { createElectronHost } from '@thunderclap/host-electron';
import { createPwaHost } from '@thunderclap/host-pwa';

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
  step('building');
  execFileSync('node', [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });

  // 1-2. Pack and inspect.
  for (const p of packages) {
    const before = new Set(readdirSync(tarballs));
    run('pnpm', ['pack', '--pack-destination', tarballs], join(root, p.dir));
    const file = readdirSync(tarballs).find((f) => f.endsWith('.tgz') && !before.has(f));
    if (!file) throw new Error(`${p.name}: pnpm pack wrote no tarball`);
    p.tarball = join(tarballs, file);
    inspect(p);
  }
  if (problems.length) throw new Error(`tarball problems:\n  ${problems.join('\n  ')}`);

  // 3. A fresh consumer.
  step(`installing the tarballs into ${app}`);
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify({ name: 'pack-smoke', private: true, type: 'module' }, null, 2)}\n`,
  );
  run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...packages.map((p) => p.tarball)],
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

  step('node loads @thunderclap/host-pwa/vite');
  const out = run('node', ['--input-type=module', '-e', NODE_CHECK], app).trim();
  if (out !== 'function') throw new Error(`pwaPlugin is ${out}, not a function`);

  step('ok');
} catch (e) {
  console.error(`check:pack: FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (keep) step(`kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

/** Lists a tarball and checks it against its own packed manifest. */
function inspect(p) {
  const list = run('tar', ['-tzf', p.tarball])
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ''));
  const manifest = JSON.parse(run('tar', ['-xzOf', p.tarball, 'package/package.json']));
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
    p.name !== '@thunderclap/engine' &&
    manifest.peerDependencies?.['@thunderclap/engine'] !== '^1.0.0'
  ) {
    fail('@thunderclap/engine must be a ^1.0.0 peer');
  }
  const kb = (readFileSync(p.tarball).length / 1024).toFixed(1);
  step(`${p.name}@${manifest.version}: ${list.length} files, ${kb} kB packed`);
}
