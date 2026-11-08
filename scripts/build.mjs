#!/usr/bin/env node
// `pnpm build`: the published form of @thunderclap-engine/engine and its three host packages (E-037).
//
//   dist/                         the engine: ESM JavaScript and .d.ts for every subpath in `exports`
//   packages/host-*/dist/         each host the same way
//   packages/host-electron/out/   the shell's main process and preload (main.mjs, preload.cjs)
//
// The workspace keeps exporting ./src/*.ts; the published manifests point here through
// `publishConfig` (pnpm swaps those fields in at pack time). `tsc` does the compiling, then one
// pass makes the output plain ESM that runs without a bundler:
//   - relative specifiers get their file extension (`./a` -> `./a.js`, `./dir` -> `./dir/index.js`,
//     `./a.ts` -> `./a.js`), in .js and .d.ts alike, so Node, browsers and NodeNext resolution load it;
//   - JSON imports get `with { type: 'json' }`, which native ESM requires.
// Every relative specifier must resolve to an emitted file, and no .d.ts may carry a
// `/// <reference path>` (the packages declare no globals, E-039), or the build fails.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', '.bin', 'tsc');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

/** Each build: the folder holding tsconfig.build.json, relative to the repo root. */
const builds = ['.', 'packages/host-capacitor', 'packages/host-electron', 'packages/host-pwa'];

for (const dir of builds) {
  const abs = join(root, dir);
  rmSync(join(abs, 'dist'), { recursive: true, force: true });
  // The engine goes first: the hosts compile against its dist/*.d.ts (their tsconfig `paths`).
  run(tsc, ['-p', join(abs, 'tsconfig.build.json')]);
  const n = fixSpecifiers(abs);
  console.log(`build: ${dir === '.' ? '@thunderclap-engine/engine' : dir} -> dist/ (${n} files)`);
}
run('node', [join(root, 'packages/host-electron/scripts/build.mjs'), '--no-renderer']);

/** Rewrites relative specifiers in every .js and .d.ts under `<pkg>/dist`. Returns the file count. */
function fixSpecifiers(pkg) {
  const dist = join(pkg, 'dist');
  const files = walk(dist).filter((f) => f.endsWith('.js') || f.endsWith('.d.ts'));
  const bad = [];
  // `from '…'`, `import '…'`, `import('…')`, `export … from '…'`
  const re = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2(\s*\))?/g;
  for (const file of files) {
    const dts = file.endsWith('.d.ts');
    const src = readFileSync(file, 'utf8');
    // The packages ship no ambient declarations (E-039), so a game can install @types/webxr or
    // any other global typings beside them; a triple-slash path reference would pull globals in.
    if (dts && /^\/\/\/ <reference path=/m.test(src)) {
      bad.push(`${relative(root, file)}: /// <reference path> (types must be module exports)`);
    }
    const out = src.replace(re, (whole, lead, q, spec, close, at, str) => {
      // Examples in doc comments (`import('./ru.json')`) are prose, not imports.
      const line = str.slice(str.lastIndexOf('\n', at) + 1, at).trimStart();
      if (/^(?:\*|\/\*|\/\/)/.test(line)) return whole;
      close ??= '';
      const resolved = resolveSpec(dirname(file), spec, dts);
      if (resolved === null) {
        bad.push(`${relative(root, file)}: '${spec}'`);
        return whole;
      }
      const json = resolved.endsWith('.json') && !dts;
      const attr = json && !lead.includes('(') ? ` with { type: 'json' }` : '';
      const dynAttr = json && lead.includes('(') ? `, { with: { type: 'json' } }` : '';
      return `${lead}${q}${resolved}${q}${dynAttr}${close}${attr}`;
    });
    if (out !== src) writeFileSync(file, out);
  }
  if (bad.length) {
    console.error(`build: unresolved relative imports:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  return files.length;
}

/** The specifier with its emitted extension, or null if nothing emitted matches. */
function resolveSpec(from, spec, dts) {
  const ext = dts ? '.d.ts' : '.js';
  const base = spec.replace(/\.(?:ts|js)$/, '');
  if (spec.endsWith('.json')) return existsSync(join(from, spec)) ? spec : null;
  if (spec !== '.' && spec !== '..' && !spec.endsWith('/') && existsSync(join(from, base + ext))) {
    return `${base}.js`;
  }
  const dir = join(from, base);
  if (existsSync(dir) && statSync(dir).isDirectory() && existsSync(join(dir, `index${ext}`))) {
    return `${base.replace(/\/$/, '')}/index.js`;
  }
  return null;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}
