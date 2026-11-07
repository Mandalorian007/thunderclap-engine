#!/usr/bin/env node
// Snippet check (ws/docs-guide). Run by `pnpm check:snippets`, which `pnpm check` runs.
//
//   node scripts/check-snippets.mjs            # the repo's docs
//   node scripts/check-snippets.mjs a.md b.md  # only these files, every ts block in them
//
// Every fenced `ts` block in docs/guide/**/*.md and the root README.md is typechecked against the
// engine's public entry points (package.json "exports", mapped onto src/ through tsconfig paths)
// and the workspace host packages' (packages/*/package.json "exports").
// In a module README (src/<module>/README.md) only a block whose previous non-blank line is
// `<!-- snippet:check -->` is checked. A block opts out with the info string `ts no-check`; the
// prose next to it says why (it is a fragment).
//
// Each block is its own module: it imports what it uses and may use top-level await. The blocks
// are written to node_modules/.cache/check-snippets/ and checked in one `tsc` run with the repo's
// compiler options (strict), minus the unused-name rules, which docs break on purpose. Errors are
// printed against the Markdown file and line. Exit 1 on any error, 0 (silent) when all pass.
// Node built-ins plus the repo's own tsc.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '<!-- snippet:check -->';

/**
 * The `ts` blocks of one Markdown text. `all` checks every block; otherwise only those right after
 * the marker. Returns { line, code } with `line` the 1-based line of the block's first code line.
 */
export function extractSnippets(text, all) {
  const lines = text.split('\n');
  const out = [];
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)\s*(.*)$/.exec(lines[i]);
    if (!open) {
      if (lines[i].trim() !== '') prev = lines[i].trim();
      continue;
    }
    const [, indent, fence, lang, rest] = open;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].trim().startsWith(fence)) end++;
    const isTs = lang === 'ts' || lang === 'typescript';
    const optOut = /\bno-check\b/.test(rest);
    if (isTs && !optOut && (all || prev === MARKER)) {
      const code = lines
        .slice(start, end)
        .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
        .join('\n');
      out.push({ line: start + 1, code });
    }
    prev = lines[i].trim();
    i = end;
  }
  return out;
}

/** The repo's default doc set: [file, all] pairs. */
export function defaultFiles() {
  const files = [[join(root, 'README.md'), true]];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) files.push([p, true]);
    }
  };
  walk(join(root, 'docs', 'guide'));
  for (const m of readdirSync(join(root, 'src')).sort()) {
    const readme = join(root, 'src', m, 'README.md');
    if (existsSync(readme)) files.push([readme, false]);
  }
  return files;
}

/**
 * tsconfig paths for every "exports" entry that points at a .ts file: the engine's, and those of
 * the workspace packages under packages/ (the hosts a game adds).
 */
function enginePaths() {
  const dirs = [root];
  const pkgs = join(root, 'packages');
  if (existsSync(pkgs)) for (const d of readdirSync(pkgs).sort()) dirs.push(join(pkgs, d));
  const paths = {};
  for (const dir of dirs) {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      if (typeof target !== 'string' || !target.endsWith('.ts')) continue;
      paths[key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`] = [join(dir, target)];
    }
  }
  return paths;
}

/** Check `files` ([path, all] pairs). Returns { count, errors: string[] }. */
export function checkSnippets(
  files,
  cacheDir = join(root, 'node_modules', '.cache', 'check-snippets'),
) {
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const origin = new Map(); // generated file name -> { md, line }
  for (const [md, all] of files) {
    const rel = relative(root, md).replace(/[^\w.-]+/g, '_');
    for (const s of extractSnippets(readFileSync(md, 'utf8'), all)) {
      const name = `${rel}__L${s.line}.ts`;
      writeFileSync(join(cacheDir, name), `${s.code}\nexport {};\n`);
      origin.set(name, { md, line: s.line });
    }
  }
  if (origin.size === 0) return { count: 0, errors: [] };
  const base = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')).compilerOptions;
  const tsconfig = {
    compilerOptions: {
      ...base,
      noUnusedLocals: false,
      noUnusedParameters: false,
      allowImportingTsExtensions: true,
      typeRoots: [join(root, 'node_modules', '@types'), join(root, 'node_modules')],
      paths: enginePaths(),
    },
    files: [...origin.keys()],
  };
  writeFileSync(join(cacheDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  const tsc = join(root, 'node_modules', '.bin', 'tsc');
  const run = spawnSync(tsc, ['-p', join(cacheDir, 'tsconfig.json'), '--pretty', 'false'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.error) throw run.error;
  const errors = [];
  for (const raw of `${run.stdout}${run.stderr}`.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = /^(.*?)\((\d+),(\d+)\): (.*)$/.exec(line);
    const at = m && origin.get(m[1].split(/[\\/]/).pop());
    if (at) {
      const where = at.md.startsWith(root) ? relative(root, at.md) : at.md;
      errors.push(`${where}:${at.line + Number(m[2]) - 1}:${m[3]}  ${m[4]}`);
    } else if (/error/i.test(line) || errors.length > 0) {
      errors.push(line);
    }
  }
  if (run.status !== 0 && errors.length === 0) errors.push(`tsc exited ${run.status}`);
  return { count: origin.size, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((f) => [resolve(f), true]) : defaultFiles();
  const { count, errors } = checkSnippets(files);
  if (errors.length > 0) {
    for (const e of errors) console.log(e);
    console.log(`check-snippets: ${errors.length} error(s) in ${count} snippet(s)`);
    process.exit(1);
  }
}
