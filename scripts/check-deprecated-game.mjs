#!/usr/bin/env node
// Find a game's uses of old engine names (ws/testing-2): the migration guide's find-your-uses
// command, run from the game's folder against its installed engine.
//
//   node node_modules/@thunderclap/engine/scripts/check-deprecated-game.mjs [tsconfig.json ...]
//
// Two passes over the root files of each tsconfig (default `tsconfig.json` in the working
// directory). The output lists engine names only: a deprecated platform name such as the DOM's
// `document.execCommand`, and the game's own deprecations and type errors, are left out.
//
// 1. Deprecated. Uses of an `@deprecated` declaration (TS6385, TS6387) that is declared in the
//    engine, via `findDeprecatedUses` with a `declaredIn` filter. This finds the aliases of an
//    engine that still has them (0.x).
// 2. Removed. Since 1.0.0 the aliases are gone, so a game still on 0.x names gets type errors
//    instead of suggestions. Each error that names a row of the migration guide's table
//    (docs/guide/migrating-to-v1.md) is reported with that row's replacement: a missing export
//    (TS2305, TS2724, TS2614, TS2694), a missing member or options field (TS2339, TS2551,
//    TS2353, TS2561) on the row's type, or a call to a removed overload (TS2345, TS2554,
//    TS2769) by method name.
//
// Exit 1 when anything is found, 0 when the game uses no old engine name.
// Node built-ins only, plus the engine's own `typescript`.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { findDeprecatedUses } from './check-deprecated.mjs';

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The rows of the migration table (`| module | 0.x name | replacement |`), as
 * [{ module, name, type, member, signature, replacement }]. `name` is the 0.x cell without
 * backticks or call arguments (`SceneStack.list`); `type` and `member` split a dotted name
 * (null `type` for a top-level export); `signature` is true when the cell lists parameters, so
 * the row is a removed overload (`Renderer.createSpriteMaterial(texture, label?, opts?)`).
 */
export function migrationTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5 || cells[0] !== '') continue;
    const mod = /^`([^`]+)`$/.exec(cells[1]);
    const old = /^`([^`(]+)(\(([^)]*)\))?/.exec(cells[2]);
    if (!mod || !old) continue;
    const name = old[1].trim();
    const dot = name.lastIndexOf('.');
    rows.push({
      module: mod[1],
      name,
      type: dot < 0 ? null : name.slice(0, dot),
      member: dot < 0 ? name : name.slice(dot + 1),
      signature: Boolean(old[3]?.trim()),
      replacement: cells[3],
    });
  }
  return rows;
}

/** A path inside the engine at `root` (its source, not its own dependencies). */
export function inEngine(root = engineRoot) {
  let real = resolve(root);
  try {
    real = realpathSync(real);
  } catch {}
  const prefix = `${real.toLowerCase()}/`;
  return (path) => {
    let p = path;
    try {
      p = realpathSync(path);
    } catch {}
    p = p.toLowerCase();
    return p.startsWith(prefix) && !p.slice(prefix.length).includes('node_modules/');
  };
}

const EXPORT_CODES = new Set([2305, 2614, 2694, 2724]);
const MEMBER_CODES = new Set([2339, 2551, 2353, 2561]);
const CALL_CODES = new Set([2345, 2554, 2769]);

/** The identifiers in a type's printed text: `DeepPartial<PostSettings>` → both names. */
const typeNames = (t) => new Set(t.match(/[A-Za-z_$][\w$]*/g) ?? []);

/**
 * The method name of the call whose argument list holds `pos`: walk back to the unmatched `(`
 * and read the identifier before it (`renderer.createSpriteMaterial(tex, 'x')` →
 * `createSpriteMaterial`). Strings are not parsed; good enough for an argument list.
 */
export function calleeAt(text, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '[' || c === '{') depth--;
    else if (c === '(') {
      if (depth === 0) {
        const m = /([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/.exec(
          text.slice(Math.max(0, i - 200), i),
        );
        return m ? m[1] : null;
      }
      depth--;
    }
    if (depth < 0) return null;
  }
  return null;
}

/**
 * The migration rows a type error at `pos` of `text` names, or [] when it names none:
 * the error is the game's own, not an old engine name. `engineSpecifier` matches an import of
 * the engine and captures its module (none for the root barrel).
 */
export function removedRowsFor(d, text, rows, engineSpecifier) {
  const quoted = [...d.text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  if (EXPORT_CODES.has(d.code)) {
    // Module '"@thunderclap/engine/anim"' has no exported member 'BlendMode'.
    const spec = /^"(.*)"$/.exec(quoted[0] ?? '')?.[1];
    const m = spec === undefined ? null : engineSpecifier.exec(spec);
    if (!m) return [];
    const mod = m[1] ?? null;
    const name = quoted[1];
    return rows.filter((r) => r.type === null && r.member === name && (!mod || r.module === mod));
  }
  if (MEMBER_CODES.has(d.code)) {
    // Property 'list' does not exist on type 'SceneStack<…>'. / 'fog' does not exist in type '…'.
    const [member, type] = quoted;
    if (!member || !type) return [];
    const names = typeNames(type);
    return rows.filter((r) => r.type !== null && r.member === member && names.has(r.type));
  }
  if (CALL_CODES.has(d.code)) {
    const callee = calleeAt(text, d.pos);
    return callee ? rows.filter((r) => r.signature && r.member === callee) : [];
  }
  return [];
}

/**
 * Every old engine name the root files of `tsconfig` (or of each, given an array) use. Returns
 * [{ file, line, col, code, text, kind, rows }] sorted by file and position: `kind` is
 * `'deprecated'` (pass 1; `rows` empty) or `'removed'` (pass 2; `rows` are the migration rows
 * the error names, more than one when a root-barrel import matches several modules).
 *
 * Options: `engine` (the engine's root; default the one this script is in), `guide` (the
 * migration guide's path; default the engine's), `engineSpecifier` (a RegExp matching an import
 * of the engine and capturing its module; default `@thunderclap/engine[/<module>]`).
 */
export function findGameDeprecations(
  tsconfig,
  {
    engine = engineRoot,
    guide = join(engine, 'docs/guide/migrating-to-v1.md'),
    engineSpecifier = /^@thunderclap\/engine(?:\/([\w-]+))?$/,
  } = {},
) {
  const configs = (Array.isArray(tsconfig) ? tsconfig : [tsconfig]).map((c) => resolve(c));
  const out = findDeprecatedUses(configs, undefined, { declaredIn: inEngine(engine) }).map((u) => ({
    ...u,
    kind: 'deprecated',
    rows: [],
  }));
  let rows = [];
  try {
    rows = migrationTable(readFileSync(guide, 'utf8'));
  } catch {
    // An engine without the guide has nothing removed to map; pass 1 still ran.
  }
  if (rows.length > 0) {
    const api = new API({ cwd: dirname(configs[0]) });
    try {
      const seen = new Set();
      for (const project of api.updateSnapshot({ openProjects: configs }).getProjects()) {
        for (const file of project.rootFiles) {
          if (!project.program.getSourceFile(file)) continue;
          const text = readFileSync(file, 'utf8');
          for (const d of project.program.getSemanticDiagnostics(file)) {
            const hit = removedRowsFor(d, text, rows, engineSpecifier);
            if (hit.length === 0) continue;
            const before = text.slice(0, d.pos).split('\n');
            const use = {
              file,
              line: before.length,
              col: before[before.length - 1].length + 1,
              code: d.code,
              text: d.text,
              kind: 'removed',
              rows: hit,
            };
            const key = `${file}:${use.line}:${use.col}:${d.code}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(use);
          }
        }
      }
    } finally {
      api.close();
    }
  }
  return out.sort((a, b) =>
    a.file === b.file ? a.line - b.line || a.col - b.col : a.file < b.file ? -1 : 1,
  );
}

/** One line per use: `file:line:col  TS<code> <text>`, then `→ <module>: <replacement>` lines. */
export function formatUse(u, cwd = process.cwd()) {
  const head = `${relative(cwd, u.file)}:${u.line}:${u.col}  TS${u.code}: ${u.text}`;
  return [head, ...u.rows.map((r) => `    ${r.module} ${r.name} → ${r.replacement}`)].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const uses = findGameDeprecations(args.length > 0 ? args : 'tsconfig.json');
  for (const u of uses) console.log(formatUse(u));
  if (uses.length === 0) console.log('check-deprecated-game: no old engine names');
  else console.log(`check-deprecated-game: ${uses.length} uses of old engine names`);
  process.exit(uses.length > 0 ? 1 : 0);
}

// Run as a script, also through a symlinked `node_modules` (Node resolves the module's real path).
const isMain = () => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (process.argv[1] && isMain()) main();
