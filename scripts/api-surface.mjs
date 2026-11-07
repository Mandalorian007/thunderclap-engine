#!/usr/bin/env node
// API surface snapshot (ARCHITECTURE.md, "API surface"). `pnpm check:api` runs it in check mode
// (part of `pnpm check`); `pnpm api:update` rewrites the snapshots.
//
// For each package.json "exports" entry that points at a .ts file under src/, it emits the
// entry's declarations with the repo's `tsc` (declaration emit only, tests excluded) and writes
// api/<entry>.api.txt: every name the entry exports, sorted, each followed by its declared
// signature (comments, private members and inline `import("…")` qualifiers stripped, so a doc
// edit or a file move is not an API change). The "." entry is api/index.api.txt.
//
//   node scripts/api-surface.mjs            check: exit 1 and print a diff on any difference
//   node scripts/api-surface.mjs --update   rewrite api/*.api.txt (and delete stale ones)
//   --root <dir>                            the package to snapshot (default: this repo; tests)
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const update = args.includes('--update');
const rootArg = args.indexOf('--root');
const root = rootArg >= 0 ? resolve(args[rootArg + 1]) : repoRoot;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const apiDir = join(root, 'api');

// ---------------------------------------------------------------------------------------------
// Declaration emit

function emitDeclarations() {
  // The temp config lives under the package so `types` in its tsconfig resolve from its
  // node_modules (a config in os.tmpdir() cannot see them).
  const cache = join(root, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const out = mkdtempSync(join(cache, 'api-surface-'));
  const base = join(root, 'tsconfig.json');
  const config = {
    ...(existsSync(base) ? { extends: base } : {}),
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      rootDir: join(root, 'src'),
      outDir: join(out, 'd'),
    },
    include: [join(root, 'src')],
    exclude: [join(root, 'src/**/*.test.ts')],
  };
  const configPath = join(out, 'tsconfig.json');
  writeFileSync(configPath, JSON.stringify(config));
  const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', configPath], { encoding: 'utf8' });
  if (r.status !== 0) {
    rmSync(out, { recursive: true, force: true });
    console.error(`api-surface: tsc declaration emit failed\n${r.stdout}${r.stderr}`);
    process.exit(2);
  }
  return { dir: join(out, 'd'), cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------------------------
// A small .d.ts reader: top-level statements, comments removed.

/** Split a .d.ts into top-level statements with comments stripped. */
function statements(text) {
  const out = [];
  let cur = '';
  let depth = 0;
  const flush = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = '';
  };
  const blockHead =
    /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(const\s+)?(class|interface|enum|namespace|module|global)\b/;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      let end = text.indexOf('*/', i + 2);
      if (end < 0) end = text.length;
      // A deprecation is part of the surface; every other comment is not.
      if (text.slice(i, end).includes('@deprecated')) cur += '@deprecated\n';
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    cur += c;
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0 && c === '}' && blockHead.test(cur.trim().replace(DEPRECATED, ''))) {
        let j = i + 1;
        while (text[j] === ' ' || text[j] === '\t') j++;
        if (j >= text.length || text[j] === '\n' || text[j] === '\r') flush();
      }
    } else if (c === ';' && depth === 0) flush();
  }
  flush();
  return out;
}

/** Parse `a, type b as c, d` into [{ name, local, typeOnly }]. */
function specifiers(list, allTypeOnly) {
  return list
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const typeOnly = allTypeOnly || /^type\s+/.test(p);
      const [local, name] = p.replace(/^type\s+/, '').split(/\s+as\s+/);
      return { local: local.trim(), name: (name ?? local).trim(), typeOnly };
    });
}

const DEPRECATED = /^@deprecated\s+/;

const DECL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const\s+enum|function\*?|class|interface|type|enum|namespace|module|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Module info for one .d.ts: local declarations, imports, exports. */
function readModule(file) {
  const mod = {
    file,
    decls: new Map(), // name -> [statement text]
    imports: new Map(), // local -> { from, imported }
    exports: [], // { name, local, from?, typeOnly }
    stars: [], // from
  };
  for (const raw of statements(readFileSync(file, 'utf8'))) {
    const deprecated = DEPRECATED.test(raw);
    const s = raw.replace(DEPRECATED, '');
    let m = s.match(/^import\s+(type\s+)?\{([\s\S]*)\}\s*from\s*['"]([^'"]+)['"]/);
    if (m) {
      for (const sp of specifiers(m[2], !!m[1]))
        mod.imports.set(sp.name, { from: m[3], imported: sp.local });
      continue;
    }
    m = s.match(/^import\s+(?:type\s+)?\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/);
    if (m) {
      mod.imports.set(m[1], { from: m[2], imported: '*' });
      continue;
    }
    if (/^import\b/.test(s)) continue;
    m = s.match(/^export\s+(type\s+)?\{([\s\S]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/);
    if (m) {
      for (const sp of specifiers(m[2], !!m[1])) mod.exports.push({ ...sp, from: m[3] });
      continue;
    }
    m = s.match(/^export\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/);
    if (m) {
      mod.exports.push({ name: m[1], local: '*', from: m[2], typeOnly: false });
      continue;
    }
    m = s.match(/^export\s+\*\s+from\s*['"]([^'"]+)['"]/);
    if (m) {
      mod.stars.push(m[1]);
      continue;
    }
    m = s.match(DECL);
    if (m) {
      const list = mod.decls.get(m[2]) ?? [];
      list.push(deprecated ? `@deprecated\n${s}` : s);
      mod.decls.set(m[2], list);
      if (/^export\s/.test(s) && !mod.exports.some((e) => e.name === m[2] && !e.from)) {
        mod.exports.push({ name: m[2], local: m[2], typeOnly: false });
      }
    }
  }
  return mod;
}

const modules = new Map();
function moduleAt(file) {
  if (!modules.has(file)) modules.set(file, readModule(file));
  return modules.get(file);
}

/** Resolve a relative specifier from a .d.ts to another .d.ts, or null for a package. */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.(m?[jt]s|tsx?)$/, '');
  for (const c of [`${base}.d.ts`, join(base, 'index.d.ts')]) if (existsSync(c)) return c;
  throw new Error(`api-surface: cannot resolve '${spec}' from ${fromFile}`);
}

/** Canonical declaration text of `local` in `mod` (following imports and re-exports). */
function declarationOf(mod, local, seen = new Set()) {
  const key = `${mod.file}#${local}`;
  if (seen.has(key)) return [`/* circular: ${local} */`];
  seen.add(key);
  const decls = mod.decls.get(local);
  if (decls) return decls;
  const imp = mod.imports.get(local);
  if (imp) return declarationFrom(mod.file, imp.from, imp.imported, seen);
  const re = mod.exports.find((e) => e.name === local && e.from);
  if (re) return declarationFrom(mod.file, re.from, re.local, seen);
  for (const star of mod.stars) {
    const target = resolveSpec(mod.file, star);
    if (target && exportsOf(moduleAt(target)).has(local))
      return declarationFrom(mod.file, star, local, seen);
  }
  throw new Error(`api-surface: no declaration for '${local}' in ${mod.file}`);
}

function declarationFrom(fromFile, spec, name, seen) {
  const target = resolveSpec(fromFile, spec);
  if (!target) return [`export { ${name} } from '${spec}'`];
  const mod = moduleAt(target);
  if (name === '*') return [`namespace (every export of ${spec.replace(/^.*\//, '')})`];
  const e = exportsOf(mod).get(name);
  if (!e) throw new Error(`api-surface: '${name}' is not exported by ${target}`);
  return e.resolve(seen);
}

/** name -> { typeOnly, original, resolve(seen) } for everything `mod` exports. */
function exportsOf(mod) {
  if (mod.exportMap) return mod.exportMap;
  const map = new Map();
  for (const star of mod.stars) {
    const target = resolveSpec(mod.file, star);
    if (!target) continue;
    for (const [name, e] of exportsOf(moduleAt(target))) if (name !== 'default') map.set(name, e);
  }
  for (const e of mod.exports) {
    map.set(e.name, {
      typeOnly: e.typeOnly,
      original: e.local,
      resolve: (seen = new Set()) =>
        e.from
          ? declarationFrom(mod.file, e.from, e.local, seen)
          : declarationOf(mod, e.local, seen),
    });
  }
  mod.exportMap = map;
  return map;
}

/** Normalise one declaration statement for the snapshot. */
function canonical(stmt) {
  const deprecated = DEPRECATED.test(stmt);
  const text = stmt
    .replace(DEPRECATED, '')
    .replace(/^export\s+(?:default\s+)?/, '')
    .replace(/^declare\s+/, '')
    .replace(/import\((["'])[^"']*\1\)\./g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .filter((l) => !/^\s*(?:private\s+(?!constructor\b)[^;]*;|#private;)$/.test(l))
    .join('\n');
  return deprecated ? `@deprecated\n${text}` : text;
}

function surface(entryKey, dtsFile) {
  const mod = moduleAt(dtsFile);
  const pkgName = pkg.name ?? 'package';
  const id = entryKey === '.' ? pkgName : `${pkgName}/${entryKey.replace(/^\.\//, '')}`;
  const lines = [
    `// ${id}: public API surface, generated by scripts/api-surface.mjs.`,
    '// Do not edit by hand. After an intended API change run `pnpm api:update` and commit this file.',
    '',
  ];
  const entries = [...exportsOf(mod)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, e] of entries) {
    const tags = [];
    if (e.original !== name && e.original !== '*') tags.push(`alias of ${e.original}`);
    if (e.typeOnly) tags.push('type-only');
    lines.push(`## ${name}${tags.length ? `  (${tags.join(', ')})` : ''}`);
    for (const d of e.resolve()) lines.push(canonical(d));
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Diff (prefix/suffix trim, then LCS on the middle), unified-ish with 2 lines of context.

function diff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const ops = [];
  if (n * m > 4e7) {
    for (const l of A) ops.push(['-', l]);
    for (const l of B) ops.push(['+', l]);
  } else {
    const w = m + 1;
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] =
          A[i] === B[j]
            ? t[(i + 1) * w + j + 1] + 1
            : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        ops.push([' ', A[i]]);
        i++;
        j++;
      } else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1]))
        ops.push(['-', A[i++]]);
      else ops.push(['+', B[j++]]);
    }
  }
  const all = [
    ...a.slice(Math.max(0, pre - 2), pre).map((l) => [' ', l]),
    ...ops,
    ...a.slice(a.length - suf, a.length - suf + 2).map((l) => [' ', l]),
  ];
  const out = [];
  const start = Math.max(0, pre - 2) + 1;
  out.push(`@@ line ${start} @@`);
  let lastShown = -10;
  all.forEach(([op, l], k) => {
    const near = all.slice(Math.max(0, k - 2), k + 3).some(([o]) => o !== ' ');
    if (!near) return;
    if (k - lastShown > 1 && out.length > 1) out.push('@@ … @@');
    out.push(`${op}${l}`);
    lastShown = k;
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------

const { dir, cleanup } = emitDeclarations();
const wanted = new Map();
try {
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string' || !target.startsWith('./src/') || !target.endsWith('.ts'))
      continue;
    const dts = join(dir, relative(join(root, 'src'), join(root, target))).replace(
      /\.ts$/,
      '.d.ts',
    );
    const file = key === '.' ? 'index' : key.replace(/^\.\//, '').replace(/\//g, '-');
    wanted.set(`${file}.api.txt`, surface(key, dts));
  }
} finally {
  cleanup();
}

const existing = existsSync(apiDir)
  ? readdirSync(apiDir).filter((f) => f.endsWith('.api.txt'))
  : [];

if (update) {
  mkdirSync(apiDir, { recursive: true });
  let changed = 0;
  for (const [file, text] of wanted) {
    const p = join(apiDir, file);
    if (existsSync(p) && readFileSync(p, 'utf8') === text) continue;
    writeFileSync(p, text);
    changed++;
    console.log(`api-surface: wrote api/${file}`);
  }
  for (const f of existing) {
    if (wanted.has(f)) continue;
    unlinkSync(join(apiDir, f));
    changed++;
    console.log(`api-surface: removed stale api/${f}`);
  }
  if (changed === 0) console.log('api-surface: up to date');
} else {
  let failures = 0;
  for (const [file, text] of wanted) {
    const p = join(apiDir, file);
    if (!existsSync(p)) {
      console.log(`api/${file}: missing (new entry)`);
      failures++;
      continue;
    }
    const old = readFileSync(p, 'utf8');
    if (old === text) continue;
    console.log(`--- api/${file} (committed)\n+++ api/${file} (emitted from src)`);
    console.log(diff(old.split('\n'), text.split('\n')));
    failures++;
  }
  for (const f of existing) {
    if (wanted.has(f)) continue;
    console.log(`api/${f}: stale (no matching package.json export)`);
    failures++;
  }
  if (failures > 0) {
    console.log(
      `check-api: ${failures} surface file(s) differ. If the change is intended, run \`pnpm api:update\` and commit api/.`,
    );
    process.exit(1);
  }
}
