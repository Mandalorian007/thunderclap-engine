#!/usr/bin/env node
// check:wgsl (D2 §2 R6, ws/rails): no WGSL the engine ships declares an `override`. iPad WebKit
// refuses to compile a module that declares one (Forge Wilds hit it; its test/shaders.test.ts holds
// the same rule), so a constant is baked into the source instead.
//
// The engine's WGSL lives in string and template literals in src/**/*.ts (and any *.wgsl file), and
// generated shaders are built from those literals, so the check lexes every shipped source file
// (tests excluded), takes the text of each literal, and looks for an override declaration:
// `override name`, optionally after an `@id(n)`, followed by `:`, `=` or `;`. A plain string
// 'override' (an anim blend mode) is not a declaration. It also counts the literals that hold
// WGSL (an entry point or a `fn`), and fails if it finds none, so a broken lexer cannot pass.
// In WGSL text it also fails on a reserved word (the spec's list) or keyword used as a name: a
// struct field, parameter or typed binding (`meta: u32`), or a let/var/const/fn/struct name.
//
//   node scripts/check-wgsl.mjs          scan src/
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A WGSL `override` declaration (`override x: f32 = 1.0;`, `@id(0) override x;`). */
const OVERRIDE = /(?:^|[^A-Za-z0-9_.'"])override\s+[A-Za-z_][A-Za-z0-9_]*\s*[:=;]/;
/** Text that is WGSL: an entry-point attribute, or a `fn name(`. */
const WGSL = /@(?:vertex|fragment|compute)\b|\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/;

/**
 * WGSL's reserved words (WGSL spec, "Reserved Words"): not keywords today, but no identifier may
 * be one. A struct field named `meta` compiles in the fake GPU and fails on a real one.
 */
export const RESERVED = new Set(
  `NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become
  cast catch class co_await co_return co_yield coherent column_major common compile
  compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete
  demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough
  filter final finally friend from fxgroup get goto groupshared highp impl implements import
  inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut
  mutable namespace new nil noexcept noinline nointerpolation non_coherent noncoherent
  noperspective null nullptr of operator package packoffset partition pass patch pixelfragment
  precise precision premerge priv protected pub public readonly ref regardless register
  reinterpret_cast require resource restrict self set shared sizeof smooth snorm static
  static_assert static_cast std subroutine super target template this thread_local throw trait
  try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying
  virtual volatile wgsl where with writeonly yield`.split(/\s+/),
);
/** WGSL keywords, which may not be identifiers either (checked only after a declaring keyword). */
const KEYWORDS = new Set(
  `alias break case const const_assert continue continuing default diagnostic discard else enable
  false fn for if let loop override requires return struct switch true var while`.split(/\s+/),
);
/** A name being declared: after let/var/const/override/fn/struct/alias. */
const DECLARED =
  /\b(?:let|var(?:<[^>]*>)?|const|override|fn|struct|alias)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
/** A name before a type annotation: a struct field, a parameter, a typed let/var. */
const TYPED = /(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)/g;
/** Text that reads as WGSL for the reserved-word check (a struct or binding alone counts). */
const WGSL_ISH = /\bstruct\s+[A-Za-z_]\w*\s*\{|@(?:group|binding|location|builtin)\s*\(/;

/** WGSL text without its comments. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/** Reserved words or keywords used as identifiers in WGSL `text`, as "word (line)" strings. */
export function findReserved(text) {
  const out = [];
  for (const line of stripComments(text).split('\n')) {
    for (const m of line.matchAll(DECLARED)) {
      if (RESERVED.has(m[1]) || KEYWORDS.has(m[1])) out.push(`${m[1]} (${line.trim()})`);
    }
    for (const m of line.matchAll(TYPED)) {
      if (RESERVED.has(m[1])) out.push(`${m[1]} (${line.trim()})`);
    }
  }
  return [...new Set(out)];
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);
const REGEX_KEYWORDS = /^(?:return|typeof|case|do|else|in|of|void|yield|await)$/;

/**
 * The text of every string and template literal in a JS/TS source, with each `${...}` of a
 * template replaced by a space (its code is lexed for literals of its own). Comments and regex
 * literals are skipped.
 */
export function stringLiterals(src) {
  const out = [];
  /** Brace depth of each open `${`, innermost last. */
  const holes = [];
  let i = 0;
  let last = '';
  let lastWord = '';
  const n = src.length;
  // Reads a template body from i (just after the backtick or the `}` closing a hole) to the next
  // backtick or `${`; appends its text to `buf`. Returns true at the closing backtick.
  const templateBody = (buf) => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        buf.push(src.slice(i, i + 2));
        i += 2;
      } else if (c === '`') {
        i++;
        return true;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        return false;
      } else {
        buf.push(c);
        i++;
      }
    }
    return true;
  };
  /** Text of the templates whose holes are open, innermost last. */
  const open = [];
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          text += src.slice(j, j + 2);
          j += 2;
        } else text += src[j++];
      }
      out.push(text);
      i = j + 1;
      last = c;
      continue;
    }
    if (c === '`') {
      i++;
      const buf = [];
      if (templateBody(buf)) out.push(buf.join(''));
      else {
        open.push(buf);
        holes.push(0);
      }
      last = '`';
      continue;
    }
    if (c === '{' && holes.length) holes[holes.length - 1]++;
    if (c === '}' && holes.length) {
      if (holes[holes.length - 1] === 0) {
        holes.pop();
        i++;
        const buf = open.pop();
        buf.push(' ');
        if (templateBody(buf)) out.push(buf.join(''));
        else {
          open.push(buf);
          holes.push(0);
        }
        last = '`';
        continue;
      }
      holes[holes.length - 1]--;
    }
    if (c === '/' && (REGEX_AFTER.has(last) || (last === 'x' && REGEX_KEYWORDS.test(lastWord)))) {
      // A regex literal: skip to its closing slash (classes may hold a slash).
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else {
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
      }
      i = j + 1;
      while (i < n && /[a-z]/.test(src[i])) i++;
      last = 'x';
      lastWord = '';
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      lastWord = /[A-Za-z0-9_$]/.test(src[i - 1] ?? '') ? lastWord + c : c;
      last = 'x';
    } else if (!/\s/.test(c)) {
      lastWord = '';
      last = c === ')' || c === ']' ? ')' : c;
    }
    i++;
  }
  return out;
}

/** The line of `text` holding an override declaration, or null. */
export function findOverride(text) {
  for (const line of text.split('\n')) if (OVERRIDE.test(line)) return line.trim();
  return null;
}

/** Whether `text` reads as WGSL. */
export function isWgsl(text) {
  return WGSL.test(text);
}

/** Shipped sources under `dir`: .ts (not tests, not .d.ts) and .wgsl. */
function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.wgsl$/.test(e.name)) out.push(p);
    else if (/\.ts$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Scans `root`/src; returns { files, wgsl, problems }. */
export function scan(root) {
  const problems = [];
  let wgsl = 0;
  const files = sources(join(root, 'src'));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const texts = file.endsWith('.wgsl') ? [src] : stringLiterals(src);
    for (const t of texts) {
      const isW = isWgsl(t);
      if (isW) wgsl++;
      const hit = findOverride(t);
      if (hit) problems.push(`${relative(root, file)}: WGSL override declaration: ${hit}`);
      if (isW || WGSL_ISH.test(t) || file.endsWith('.wgsl')) {
        for (const r of findReserved(t)) {
          problems.push(`${relative(root, file)}: WGSL reserved word as an identifier: ${r}`);
        }
      }
    }
  }
  return { files: files.length, wgsl, problems };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { files, wgsl, problems } = scan(root);
  if (wgsl === 0) {
    console.error('check:wgsl: found no WGSL in src/; the scanner is broken');
    process.exit(1);
  }
  if (problems.length) {
    for (const p of problems) console.error(`check:wgsl: ${p}`);
    console.error(
      'check:wgsl: iPad WebKit refuses WGSL `override` (bake the constant in instead); a reserved word cannot name anything (rename it).',
    );
    process.exit(1);
  }
  console.log(
    `check:wgsl: ${wgsl} WGSL sources in ${files} files, no override declarations or reserved-word identifiers`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
