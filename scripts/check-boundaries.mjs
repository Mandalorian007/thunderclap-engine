#!/usr/bin/env node
// Import-boundary check (ARCHITECTURE.md, "Package shape"). Run by `pnpm check`. Node built-ins only.
//
//   1. Nothing under src/ imports from outside src/ (no ../harness, ../e2e, a game, a host package).
//   2. harness/, e2e/, examples/ and templates/ (if present) reach the engine only through the
//      public exports map: `@thunderclap/engine` or `@thunderclap/engine/<subpath>` for a key of
//      package.json "exports". Never a relative path into src/, never a subpath outside the map.
//   3. Files in src/<module>/ import other modules by relative path, never through the package
//      name (no self-import).
//
// Exit 1 and print every violation as `file:line  'specifier'  reason`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const PKG = '@thunderclap/engine';

const exportsMap = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports ?? {};
const allowed = new Set(
  Object.keys(exportsMap).map((k) => (k === '.' ? PKG : `${PKG}/${k.replace(/^\.\//, '')}`)),
);

const CODE = /\.(m?[jt]s|tsx?|html)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.claude',
  'test-results',
  'playwright-report',
  'out',
]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && CODE.test(e.name)) out.push(p);
  }
  return out;
}

// `from 'x'`, `import 'x'`, `import('x')`, `export … from 'x'`, `<script src="x">`.
const SPEC =
  /\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(?\s*['"]([^'"\n]+)['"]|<script[^>]*\bsrc\s*=\s*['"]([^'"\n]+)['"]/g;

/** @param {string} text @returns {{ spec: string; line: number }[]} */
function importsOf(text) {
  /** @type {{ spec: string; line: number }[]} */
  const out = [];
  for (const m of text.matchAll(SPEC)) {
    const spec = m[1] ?? m[2] ?? m[3];
    out.push({ spec, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Absolute target of a relative or root-relative specifier, else null. */
function target(file, spec) {
  const bare = spec.split('?')[0];
  if (bare.startsWith('.')) return resolve(dirname(file), bare);
  if (bare.startsWith('/')) return join(root, bare);
  return null;
}

const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

/** @type {string[]} */
const problems = [];
const report = (file, line, spec, why) =>
  problems.push(`${relative(root, file)}:${line}  '${spec}'  ${why}`);

// 1 + 3: everything under src/.
const srcFiles = walk(srcDir);
for (const file of srcFiles) {
  for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
    const bare = spec.split('?')[0];
    if (bare === PKG || bare.startsWith(`${PKG}/`)) {
      report(file, line, spec, 'src/ imports other modules by relative path, not by package name');
      continue;
    }
    if (bare.startsWith('@thunderclap/')) {
      report(file, line, spec, 'the engine must never import a host or another package');
      continue;
    }
    const t = target(file, spec);
    if (t && !inside(t, srcDir)) report(file, line, spec, 'leaves src/');
  }
}

// 2: consumers of the engine inside this repo.
const consumerDirs = ['harness', 'e2e', 'examples', 'templates'];
const consumerFiles = consumerDirs.flatMap((d) => walk(join(root, d)));
for (const file of consumerFiles) {
  for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
    const bare = spec.split('?')[0];
    if (bare === PKG || bare.startsWith(`${PKG}/`)) {
      if (!allowed.has(bare)) {
        report(file, line, spec, `not in the exports map (${[...allowed].join(', ')})`);
      }
      continue;
    }
    const t = target(file, spec);
    if (t && inside(t, srcDir)) {
      report(file, line, spec, `reaches into src/; import from '${PKG}' or '${PKG}/<module>'`);
    }
  }
}

if (problems.length) {
  console.error(`check-boundaries: ${problems.length} violation(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `check-boundaries: ok (${srcFiles.length} src files, ${consumerFiles.length} harness/e2e/examples files, ${allowed.size} public entries)`,
);
