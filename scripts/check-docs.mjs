#!/usr/bin/env node
// Doc-coverage check (docs/PM.md, "Docs"). Run by `pnpm check:docs`, which `pnpm check` runs.
//
// For every entry of package.json "exports" that points into src/, every name the entry file
// exports must appear (as a whole word) in that module's README: src/<module>/README.md, or the
// root README.md for the "." entry. A missing README counts every export as missing.
//
// On failure: exit 1 and print only the list (each subpath, its README and the names it does not
// mention, then a count). On success: print nothing. Node built-ins only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exportsMap = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports ?? {};

/** Names exported by a TypeScript entry file (named re-exports and local declarations). */
function exportedNames(file) {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim().replace(/^type\s+/, '');
      if (!spec) continue;
      const alias = spec.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0]).trim());
    }
  }
  const decl =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(decl)) names.add(m[1]);
  if (/export\s+\*/.test(text)) {
    console.warn(`${relative(root, file)}: 'export *' is not followed; list the names instead`);
  }
  return [...names].sort();
}

function escapeName(name) {
  return name.replace(/[$]/g, '\\$');
}

let failures = 0;
for (const [key, target] of Object.entries(exportsMap)) {
  if (typeof target !== 'string' || !target.startsWith('./src/') || !target.endsWith('.ts'))
    continue;
  const entry = join(root, target);
  const readme = key === '.' ? join(root, 'README.md') : join(dirname(entry), 'README.md');
  const doc = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
  const missing = exportedNames(entry).filter(
    (name) => !new RegExp(`(^|[^\\w$])${escapeName(name)}(?![\\w$])`).test(doc),
  );
  if (missing.length === 0) continue;
  failures += missing.length;
  const where = existsSync(readme) ? relative(root, readme) : `${relative(root, readme)} (missing)`;
  console.log(`${key}  ${where}  ${missing.length} missing: ${missing.join(', ')}`);
}

if (failures > 0) {
  console.log(`check-docs: ${failures} exported name(s) missing from module READMEs`);
  process.exit(1);
}
