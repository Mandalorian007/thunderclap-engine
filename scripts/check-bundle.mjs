#!/usr/bin/env node
// check:bundle (D2 §2 R4 and R5, ws/rails): what a game pays, in gzip bytes, for each part of the
// engine, and proof that the subpaths shake apart.
//
// Each entry below is built alone with Vite (minified, ES2022, the repo's own Vite; nothing is
// written to disk): every `exports` subpath of package.json as `export * from` it, plus a few named
// import sets a game really makes (Renderer alone, Renderer + Camera + Transform, render with
// voxel, createGame). The gzip size of all the JS it emits is held against
// scripts/bundle-budgets.json. Raising a budget is a deliberate line in a PR, with the reason.
//
// Tree shaking: an entry may name `excludes`, engine folders none of whose code may reach its
// output (a module counts when it renders any bytes). A consumer of render pulls no ui, audio or
// voxel; a consumer of input pulls no renderer.
//
//   node scripts/check-bundle.mjs          print the table, fail on a breach
//   node scripts/check-bundle.mjs --add    also write a budget (size + 5%) for entries without one
//   node scripts/check-bundle.mjs --reset  rewrite every budget to size + 5% (a deliberate raise)
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Headroom a new or reset budget gets over today's size. */
export const HEADROOM = 1.05;

/**
 * Named import sets: `from` is an `exports` key, `names` what is imported (`*` for everything).
 * `excludes` are src/ folders that must contribute no code.
 */
export const NAMED = [
  {
    name: 'render { Renderer }',
    from: './render',
    names: ['Renderer'],
    excludes: ['ui', 'audio', 'voxel', 'post', 'assets'],
  },
  {
    name: 'render { Renderer, Camera, Transform }',
    from: './render',
    names: ['Renderer', 'Camera', 'Transform'],
    excludes: ['ui', 'audio', 'voxel', 'post', 'assets'],
  },
  {
    name: 'render + voxel { Renderer, createVoxelGrid, createVoxelChunks }',
    from: ['./render', './voxel', './voxel'],
    names: ['Renderer', 'createVoxelGrid', 'createVoxelChunks'],
    excludes: ['ui', 'audio'],
  },
  // createGame pulls the whole engine today (ui, audio, fx, post); D2 R5 wants a feature-off
  // createGame free of ui and audio. `todo` folders are reported, not failed, until A3 (ws/kit)
  // splits it; then they move to `excludes`.
  {
    name: '. { createGame }',
    from: '.',
    names: ['createGame'],
    excludes: [],
    todo: ['ui', 'audio'],
  },
];

/** Folders a whole-subpath entry may not pull in. */
export const SUBPATH_EXCLUDES = {
  './render': ['ui', 'audio', 'voxel'],
  './input': ['render'],
};

/** Every entry to build: one per `exports` subpath, then the named sets. */
export function entries(pkg) {
  const out = [];
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (typeof target !== 'string' || !target.endsWith('.ts')) continue;
    out.push({
      name: key,
      imports: [{ from: key, names: ['*'] }],
      excludes: SUBPATH_EXCLUDES[key] ?? [],
      todo: [],
    });
  }
  for (const n of NAMED) {
    const froms = Array.isArray(n.from) ? n.from : n.names.map(() => n.from);
    out.push({
      name: n.name,
      imports: n.names.map((name, i) => ({ from: froms[i], names: [name] })),
      excludes: n.excludes,
      todo: n.todo ?? [],
    });
  }
  return out;
}

/** The entry module's source: re-export what the consumer imports, so nothing is dropped. */
export function entrySource(entry, pkg, root) {
  const lines = [];
  entry.imports.forEach((imp, i) => {
    const file = join(root, pkg.exports[imp.from]);
    if (imp.names[0] === '*') lines.push(`export * from ${JSON.stringify(file)};`);
    else lines.push(`export { ${imp.names.join(', ')} as e${i} } from ${JSON.stringify(file)};`);
  });
  return `${lines.join('\n')}\n`;
}

/** src/ folders whose modules rendered code into `modules` (id -> { renderedLength }). */
export function foldersIn(modules, root) {
  const src = `${join(root, 'src')}/`;
  const out = new Set();
  for (const [id, m] of Object.entries(modules)) {
    if (!id.startsWith(src) || m.renderedLength <= 0) continue;
    out.add(id.slice(src.length).split('/')[0]);
  }
  return out;
}

/** The budget for a measured size. */
export function budgetFor(gzip) {
  return Math.ceil((gzip * HEADROOM) / 100) * 100;
}

/** One row's verdict: problems for a missing or broken budget and for leaked folders. */
export function verdict(row, budget) {
  const problems = [];
  if (budget === undefined)
    problems.push(`${row.name}: no budget in scripts/bundle-budgets.json (run with --add)`);
  else if (row.gzip > budget)
    problems.push(`${row.name}: ${row.gzip} B gzip is over its budget of ${budget} B`);
  for (const f of row.leaked)
    problems.push(`${row.name}: pulls code from src/${f}/ (${row.leakedFrom[f]})`);
  return problems;
}

async function measure(entry, pkg, root, dir, build) {
  const file = join(dir, `${entry.name.replace(/[^A-Za-z0-9]+/g, '_') || 'root'}.js`);
  writeFileSync(file, entrySource(entry, pkg, root));
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: { input: { e: file }, preserveEntrySignatures: 'exports-only' },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  let raw = 0;
  let gzip = 0;
  const modules = {};
  for (const o of outputs) {
    if (o.type !== 'chunk') continue;
    raw += Buffer.byteLength(o.code);
    gzip += gzipSync(o.code).length;
    Object.assign(modules, o.modules);
  }
  const folders = foldersIn(modules, root);
  const leaked = entry.excludes.filter((f) => folders.has(f));
  const pending = entry.todo.filter((f) => folders.has(f));
  const leakedFrom = {};
  for (const f of [...leaked, ...pending]) {
    const prefix = `${join(root, 'src', f)}/`;
    leakedFrom[f] = Object.keys(modules)
      .filter((id) => id.startsWith(prefix) && modules[id].renderedLength > 0)
      .map((id) => relative(root, id))
      .slice(0, 3)
      .join(', ');
  }
  return { name: entry.name, raw, gzip, leaked, pending, leakedFrom };
}

const kb = (b) => (b / 1024).toFixed(1);

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const budgetsPath = join(root, 'scripts', 'bundle-budgets.json');
  const args = process.argv.slice(2);
  const add = args.includes('--add');
  const reset = args.includes('--reset');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  const { build } = await import('vite');

  const dir = mkdtempSync(join(tmpdir(), 'tc-check-bundle-'));
  const rows = [];
  try {
    for (const entry of entries(pkg)) rows.push(await measure(entry, pkg, root, dir, build));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  let wrote = false;
  for (const row of rows) {
    if (reset || (add && budgets.limits[row.name] === undefined)) {
      budgets.limits[row.name] = budgetFor(row.gzip);
      wrote = true;
    }
  }
  if (wrote) writeFileSync(budgetsPath, `${JSON.stringify(budgets, null, 2)}\n`);

  const problems = [];
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(
    `${'entry'.padEnd(w)}  ${'min kB'.padStart(7)}  ${'gzip kB'.padStart(7)}  ${'budget'.padStart(7)}  used`,
  );
  for (const row of rows) {
    const budget = budgets.limits[row.name];
    const p = verdict(row, budget);
    problems.push(...p);
    const used = budget ? `${Math.round((row.gzip / budget) * 100)}%` : '-';
    console.log(
      `${row.name.padEnd(w)}  ${kb(row.raw).padStart(7)}  ${kb(row.gzip).padStart(7)}  ${(budget ? kb(budget) : '-').padStart(7)}  ${used}${p.length ? '  FAIL' : ''}`,
    );
  }
  for (const row of rows) {
    for (const f of row.pending) {
      console.log(
        `check:bundle: (todo, not failed) ${row.name} pulls src/${f}/ (${row.leakedFrom[f]})`,
      );
    }
  }
  for (const name of Object.keys(budgets.limits)) {
    if (!rows.some((r) => r.name === name))
      problems.push(`${name}: a budget for an entry that no longer exists`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`check:bundle: ${p}`);
    process.exit(1);
  }
  console.log(`check:bundle: ${rows.length} entries within budget; render and input shake clean`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
