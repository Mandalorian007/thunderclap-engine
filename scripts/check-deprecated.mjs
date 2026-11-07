#!/usr/bin/env node
// The deprecated-name check (E-036): one module for every place the repo writes engine code.
// ws/templates-v1 wrote the strip pass, ws/docs-v1 the suggestion pass, and ws/src-v1 merged
// them. `pnpm check:deprecated` runs both passes (part of `pnpm check`); `pnpm check:snippets`
// runs the suggestion pass on the README and guide snippets through `findDeprecatedUses`.
//
// 1. Suggestion pass (`findDeprecatedUses`). The type checker reports each use of an
//    `@deprecated` declaration as a suggestion (TS6385 a name, TS6387 a signature), which the tsc
//    CLI never prints, so the pass asks TypeScript's API (`typescript/unstable/sync`, the bundled
//    tsgo) for them. Run over the root project (`src`, `harness`, `examples`, `demos`), the e2e
//    project, every `packages/*` and `templates/*` tsconfig. Only engine declarations count: a
//    deprecated DOM name (`document.execCommand`) is the platform's, not ours.
// 2. Strip pass. It emits the engine's declarations with the repo's `tsc` (as `api-surface.mjs`
//    does), deletes every declaration whose JSDoc says `@deprecated` (exports, interface and class
//    members, overloads, options fields, export specifiers, and the barrel re-exports of what was
//    deleted), then typechecks every project that imports the engine by package name (`demos`,
//    `harness` and `e2e`, `packages/*`, `templates/*`) against that stripped engine. A use is then
//    a type error, including what pass 1 cannot see: a key of a deprecated field in a mapped-type
//    patch (`post.set({ fog: … })`). `src` imports itself by relative path, so only pass 1 covers
//    it. When v1 removes the aliases, nothing the check passes breaks.
//
// A test that exists only to cover a deprecated alias keeps its use: the line ends with
// `// deprecated-alias test` (or the comment sits alone on the line above). The alias's own
// implementation, reading the deprecated field it still honours, says `// deprecated-alias impl`.
// Both passes skip those lines.
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
import { API, SymbolFlags } from 'typescript/unstable/sync';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Exemptions

/** The comment that keeps a deprecated use: an alias test, or the alias's own implementation. */
export const EXEMPT = /\/\/\s*deprecated-alias (?:test|impl)\b/;

/** True when 1-based `line` of `lines` carries the marker, or the line above is only the marker. */
export function isExempt(lines, line) {
  if (EXEMPT.test(lines[line - 1] ?? '')) return true;
  const above = (lines[line - 2] ?? '').trim();
  return above.startsWith('//') && EXEMPT.test(above);
}

const fileLines = new Map();
function linesOf(file) {
  if (!fileLines.has(file)) fileLines.set(file, readFileSync(file, 'utf8').split('\n'));
  return fileLines.get(file);
}

// ---------------------------------------------------------------------------------------------
// Pass 1: the type checker's deprecation suggestions

/** TypeScript's "is deprecated" suggestion codes: a name (6385) and a signature (6387). */
export const DEPRECATED_CODES = new Set([6385, 6387]);

/** A declaration in this repo's own source (not a lib, not a dependency). */
export function inRepoSource(path) {
  const p = path.toLowerCase();
  return p.startsWith(`${repoRoot.toLowerCase()}/`) && !p.includes('/node_modules/');
}

/**
 * Every use of an `@deprecated` declaration in the root files of the project at `tsconfig` (or
 * of each project, given an array), or only in `files` (absolute paths among them), from the
 * type checker's suggestion diagnostics. Returns [{ file, line, col, code, text }], 1-based line
 * and column, sorted by file and position, one entry per position.
 *
 * `declaredIn(path)` keeps only uses whose deprecated symbol is declared in a file it accepts
 * (`inRepoSource` keeps the engine's and drops the DOM's); `exempt` drops `deprecated-alias`
 * lines. By default both are off and every deprecated name is listed.
 */
export function findDeprecatedUses(tsconfig, files, { declaredIn, exempt = false } = {}) {
  const configs = (Array.isArray(tsconfig) ? tsconfig : [tsconfig]).map((c) => resolve(c));
  const api = new API({ cwd: repoRoot });
  try {
    const snapshot = api.updateSnapshot({ openProjects: configs });
    const projects = snapshot.getProjects();
    if (projects.length === 0) throw new Error(`findDeprecatedUses: no project for ${configs}`);
    const seen = new Set();
    const out = [];
    for (const project of projects) {
      for (const file of files ?? project.rootFiles) {
        if (!project.program.getSourceFile(file)) continue;
        const text = readFileSync(file, 'utf8');
        for (const d of project.program.getSuggestionDiagnostics(file)) {
          if (!DEPRECATED_CODES.has(d.code)) continue;
          const before = text.slice(0, d.pos).split('\n');
          const use = {
            file,
            line: before.length,
            col: before[before.length - 1].length + 1,
            code: d.code,
            text: d.text,
          };
          const key = `${file}:${use.line}:${use.col}:${d.code}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (exempt && isExempt(linesOf(file), use.line)) continue;
          if (declaredIn) {
            let sym = project.checker.getSymbolAtPosition(file, d.pos);
            // An imported name is an alias declared in the importing file: judge its target.
            if (sym && sym.flags & SymbolFlags.Alias) sym = project.checker.getAliasedSymbol(sym);
            const paths = sym?.declarations.map((h) => h.path) ?? [];
            if (paths.length > 0 && !paths.some(declaredIn)) continue;
          }
          out.push(use);
        }
      }
    }
    return out.sort((a, b) =>
      a.file === b.file ? a.line - b.line || a.col - b.col : a.file < b.file ? -1 : 1,
    );
  } finally {
    api.close();
  }
}

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

/** Each `packages/*` and `templates/*` directory holding `tsconfig*.json`, as [dir, file]. */
function nested(parent) {
  const out = [];
  const pdir = join(repoRoot, parent);
  for (const name of readdirSync(pdir).sort()) {
    const dir = join(pdir, name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      if (/^tsconfig(\.\w+)?\.json$/.test(file)) out.push([dir, file]);
    }
  }
  return out;
}

/** The tsconfigs pass 1 reads: every project in the repo that holds engine code or uses it. */
export function suggestionConfigs() {
  return [
    join(repoRoot, 'tsconfig.json'),
    join(repoRoot, 'tsconfig.e2e.json'),
    ...nested('packages').map(([d, f]) => join(d, f)),
    ...nested('templates').map(([d, f]) => join(d, f)),
  ];
}

/**
 * The projects pass 2 typechecks against the stripped engine: everything that imports it by
 * package name. `src` is not one (relative imports), so pass 1 alone covers it.
 */
function projects() {
  const list = [
    { name: 'demos', dir: repoRoot, tsconfig: 'tsconfig.json', include: ['demos'] },
    {
      name: 'harness+e2e',
      dir: repoRoot,
      tsconfig: 'tsconfig.e2e.json',
      include: ['harness', 'e2e'],
    },
  ];
  for (const parent of ['packages', 'templates']) {
    for (const [dir, file] of nested(parent)) {
      const name = `${relative(repoRoot, dir)}${file === 'tsconfig.json' ? '' : `/${file}`}`;
      list.push({ name, dir, tsconfig: file, include: null });
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
  if (r.status === 0) return { ok: true, lines: [] };
  // One error is a `file(line,col): error …` head and its indented continuation lines. Drop the
  // errors on a `deprecated-alias` line; any other error (deprecated or not) fails the project.
  const errors = [];
  for (const l of `${r.stdout}${r.stderr}`.split('\n')) {
    if (!l.trim()) continue;
    if (/^\s/.test(l) && errors.length) errors[errors.length - 1].push(l);
    else errors.push([l]);
  }
  const kept = errors.filter(([head]) => {
    const m = /^(.+?)\((\d+),\d+\): error/.exec(head);
    if (!m) return true;
    const file = resolve(p.dir, m[1]);
    return !(existsSync(file) && isExempt(linesOf(file), Number(m[2])));
  });
  const lines = kept.flat().map((l) => (l.startsWith('/') ? relative(repoRoot, l) : l));
  return { ok: kept.length === 0, lines };
}

/** Pass 1 over every project: the engine's deprecated names used anywhere but on exempt lines. */
export function suggestionPass() {
  return findDeprecatedUses(suggestionConfigs(), undefined, {
    declaredIn: inRepoSource,
    exempt: true,
  }).filter((u) => !u.file.includes('/node_modules/'));
}

function main() {
  const keep = process.argv.includes('--keep');
  let failed = 0;
  const uses = suggestionPass();
  if (uses.length > 0) {
    failed++;
    console.error(`check-deprecated: ${uses.length} uses of deprecated engine names:`);
    for (const u of uses) {
      console.error(`  ${relative(repoRoot, u.file)}:${u.line}:${u.col} TS${u.code} ${u.text}`);
    }
  }
  const cacheRoot = join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheRoot, { recursive: true });
  const cache = mkdtempSync(join(cacheRoot, 'check-deprecated-'));
  const list = projects();
  try {
    const dts = emitDeclarations(cache);
    const count = stripTree(dts);
    for (const p of list) {
      const r = checkProject(p, dts, cache);
      if (r.ok) continue;
      failed++;
      console.error(`check-deprecated: ${p.name} uses deprecated engine names:`);
      for (const l of r.lines) console.error(`  ${l}`);
    }
    if (failed === 0) {
      console.log(
        `check-deprecated: src, ${list.map((p) => p.name).join(', ')} use none of the ${count} deprecated engine declarations (exempt: \`// deprecated-alias test|impl\` lines)`,
      );
    }
  } finally {
    if (keep) console.log(`check-deprecated: stripped declarations kept in ${cache}`);
    else rmSync(cache, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
