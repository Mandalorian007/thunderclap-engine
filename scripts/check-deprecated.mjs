#!/usr/bin/env node
// Deprecated-name lint for the copyable code (ws/templates-v1, E-036). `pnpm check:deprecated`
// runs it (part of `pnpm check`).
//
// It emits the engine's declarations with the repo's `tsc` (as `api-surface.mjs` does), deletes
// every declaration whose JSDoc says `@deprecated` (exports, interface and class members,
// overloads, options fields, export specifiers, and the barrel re-exports of what was deleted),
// then typechecks `demos/**` and each `templates/*` against that stripped engine. A use of a
// deprecated engine name is then a type error: an import of a removed alias, a read of a removed
// member, a call that only the deprecated overload accepted, an object literal that sets a
// deprecated field. When v1 removes the aliases, nothing the check passes breaks.
//
//   node scripts/check-deprecated.mjs        exit 1 and print the errors on any use
//   --keep                                   keep the stripped declarations (prints the path)
//
// Node built-ins only, plus the `typescript` package this repo already depends on.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Stripping one .d.ts

const DECL_NAME =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const\s+)?(?:const|let|var|function|type|interface|class|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const BLOCK_HEAD =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const\s+)?(?:class|interface|enum|namespace|module)\b/;

/** Index just past a string literal starting at `i` (template literals without nesting). */
function skipString(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === q) return j + 1;
  }
  return text.length;
}

/**
 * End of the declaration starting at `start`: past its `;` or `,` at depth 0, past the closing
 * `}` of a class / interface / enum / namespace, or just before the `}` closing the scope it
 * sits in. Comments and strings are skipped.
 */
function declarationEnd(text, start) {
  const block = BLOCK_HEAD.test(text.slice(start, start + 80));
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? text.length : e;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i) - 1;
      continue;
    }
    // In a declaration file `<` and `>` only bracket type arguments; `=>` is not a bracket.
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && text[i - 1] !== '=')) {
      depth--;
      if (depth < 0) return i;
      if (depth === 0 && c === '}' && block) return i + 1;
    } else if (depth === 0 && (c === ';' || c === ',')) return i + 1;
  }
  return text.length;
}

/** The name an export specifier (`type A as B`) exports, and the name it takes. */
function specifier(s) {
  const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(s);
  return m ? { from: m[1], as: m[2] ?? m[1] } : null;
}

/**
 * Delete every declaration whose JSDoc carries `@deprecated`. Returns the new text and the
 * top-level names it removed (declarations and export specifiers) and how many declarations
 * (of any depth) it deleted.
 */
export function stripDeprecated(text) {
  let out = '';
  let deleted = 0;
  const removed = new Set();
  // A stack of open brackets; for `{` it records whether it is an export specifier list.
  const stack = [];
  let stmtStart = 0; // index in `out` where the current top-level statement began
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '*') {
      let end = text.indexOf('*/', i + 2);
      end = end < 0 ? text.length : end + 2;
      const comment = text.slice(i, end);
      if (!/@deprecated\b/.test(comment)) {
        out += comment;
        i = end - 1;
        continue;
      }
      let s = end;
      while (s < text.length && /\s/.test(text[s])) s++;
      const e = declarationEnd(text, s);
      const decl = text.slice(s, e);
      deleted++;
      const top = stack.length === 0;
      const inExports = stack.length === 1 && stack[0] === 'exports';
      if (top) {
        const m = DECL_NAME.exec(decl);
        if (m) removed.add(m[1]);
      } else if (inExports) {
        const sp = specifier(decl.replace(/,\s*$/, ''));
        if (sp) removed.add(sp.as);
      }
      i = e - 1;
      continue;
    }
    if (c === '/' && n === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? text.length : e;
      out += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const e = skipString(text, i);
      out += text.slice(i, e);
      i = e - 1;
      continue;
    }
    if (c === '{') {
      const head = out.slice(stmtStart).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      stack.push(stack.length === 0 && /^\s*export\s+(?:type\s+)?$/.test(head) ? 'exports' : '{');
    } else if (c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') stack.pop();
    out += c;
    if (stack.length === 0 && (c === ';' || c === '}')) stmtStart = out.length;
  }
  return { text: out, removed, deleted };
}

const EXPORT_LIST = /export\s+(type\s+)?\{([^}]*)\}(\s*from\s*(['"])([^'"]+)\4)?\s*;?/g;

/**
 * Drop from `export { … } [from '…']` lists every name that `removedIn(spec)` says the source no
 * longer has (`spec` is null for a local list). Returns the text and the exported names dropped.
 */
export function pruneExportLists(text, localRemoved, removedIn) {
  const dropped = new Set();
  const next = text.replace(EXPORT_LIST, (all, typeKw, body, fromPart, _q, spec) => {
    const gone = spec ? removedIn(spec) : localRemoved;
    if (!gone || gone.size === 0) return all;
    const parts = body.split(',');
    const keep = [];
    for (const p of parts) {
      const sp = specifier(p);
      if (sp && gone.has(sp.from)) dropped.add(sp.as);
      else if (p.trim()) keep.push(p.trim());
    }
    if (keep.length === parts.filter((p) => p.trim()).length) return all;
    return `export ${typeKw ?? ''}{ ${keep.join(', ')} }${fromPart ?? ''};`;
  });
  return { text: next, dropped };
}

// ---------------------------------------------------------------------------------------------
// Stripping the emitted engine

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function resolveDts(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec.replace(/\.(m?js|ts)$/, ''));
  for (const p of [`${base}.d.ts`, join(base, 'index.d.ts')]) if (existsSync(p)) return p;
  return null;
}

/** Strip every .d.ts under `dir` in place; returns how many declarations went. */
export function stripTree(dir) {
  const files = walk(dir);
  const texts = new Map();
  const removed = new Map();
  let count = 0;
  for (const f of files) {
    const r = stripDeprecated(readFileSync(f, 'utf8'));
    texts.set(f, r.text);
    removed.set(f, r.removed);
    count += r.deleted;
  }
  // Re-exports of a removed name go too, through barrels of barrels: repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of files) {
      const r = pruneExportLists(texts.get(f), removed.get(f), (spec) => {
        const target = resolveDts(f, spec);
        return target ? removed.get(target) : null;
      });
      if (r.text !== texts.get(f)) {
        texts.set(f, r.text);
        for (const name of r.dropped) removed.get(f).add(name);
        changed = true;
      }
    }
  }
  for (const f of files) writeFileSync(f, texts.get(f));
  return count;
}

// ---------------------------------------------------------------------------------------------
// Emit, strip, typecheck

const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');

function run(configPath) {
  return spawnSync(process.execPath, [tsc, '-p', configPath, '--pretty', 'false'], {
    encoding: 'utf8',
  });
}

function emitDeclarations(cache) {
  const out = join(cache, 'd');
  const config = {
    extends: join(repoRoot, 'tsconfig.json'),
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      removeComments: false,
      noUnusedLocals: false,
      noUnusedParameters: false,
      rootDir: join(repoRoot, 'src'),
      outDir: out,
    },
    include: [join(repoRoot, 'src')],
    exclude: [join(repoRoot, 'src/**/*.test.ts')],
  };
  const configPath = join(cache, 'emit.tsconfig.json');
  writeFileSync(configPath, JSON.stringify(config));
  const r = run(configPath);
  if (r.status !== 0) {
    console.error(`check-deprecated: tsc declaration emit failed\n${r.stdout}${r.stderr}`);
    process.exit(2);
  }
  return out;
}

/** The projects that hold copyable code: demos (root tsconfig) and each template. */
function projects() {
  const list = [{ name: 'demos', dir: repoRoot, tsconfig: 'tsconfig.json', include: ['demos'] }];
  const tdir = join(repoRoot, 'templates');
  for (const name of readdirSync(tdir).sort()) {
    const dir = join(tdir, name);
    if (existsSync(join(dir, 'tsconfig.json'))) {
      list.push({ name: `templates/${name}`, dir, tsconfig: 'tsconfig.json', include: null });
    }
  }
  return list;
}

function checkProject(p, dts, cache) {
  const base = join(p.dir, p.tsconfig);
  const own = JSON.parse(readFileSync(base, 'utf8'));
  const include = (p.include ?? own.include ?? ['src']).map((s) => join(p.dir, s));
  const config = {
    extends: base,
    compilerOptions: {
      paths: {
        '@thunderclap/engine': [join(dts, 'index.d.ts')],
        '@thunderclap/engine/*': [join(dts, '*', 'index.d.ts')],
      },
      // `types` resolve from the project, whose node_modules this config cannot see from the
      // cache directory.
      typeRoots: [join(p.dir, 'node_modules', '@types'), join(p.dir, 'node_modules')],
    },
    include,
    exclude: [join(p.dir, '**/node_modules'), join(p.dir, '**/dist')],
  };
  const configPath = join(cache, `${p.name.replace(/\W/g, '-')}.tsconfig.json`);
  writeFileSync(configPath, JSON.stringify(config));
  const r = run(configPath);
  const text = `${r.stdout}${r.stderr}`
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (l.startsWith('/') ? relative(repoRoot, l) : l));
  return { ok: r.status === 0, lines: text };
}

function main() {
  const keep = process.argv.includes('--keep');
  const cacheRoot = join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheRoot, { recursive: true });
  const cache = mkdtempSync(join(cacheRoot, 'check-deprecated-'));
  let failed = 0;
  try {
    const dts = emitDeclarations(cache);
    const count = stripTree(dts);
    for (const p of projects()) {
      const r = checkProject(p, dts, cache);
      if (r.ok) continue;
      failed++;
      console.error(`check-deprecated: ${p.name} uses deprecated engine names:`);
      for (const l of r.lines) console.error(`  ${l}`);
    }
    if (failed === 0) {
      console.log(
        `check-deprecated: demos and ${projects().length - 1} templates use none of the ${count} deprecated engine declarations`,
      );
    }
  } finally {
    if (keep) console.log(`check-deprecated: stripped declarations kept in ${cache}`);
    else rmSync(cache, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
