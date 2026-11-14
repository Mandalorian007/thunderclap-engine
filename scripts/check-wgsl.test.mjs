// Tests for scripts/check-wgsl.mjs (run by `pnpm check:wgsl`): the lexer finds WGSL in strings and
// templates (holes included), skips comments and regex literals, and an override declaration is
// caught while a plain 'override' string is not.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findOverride, findReserved, isWgsl, scan, stringLiterals } from './check-wgsl.mjs';

test('stringLiterals reads quotes and templates, holes as a space, and nested templates', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test holds a template.
  const src = "const a = 'x'; const b = \"y\"; const c = `p${q ? `in${r}ner` : 's'}t`;";
  assert.deepEqual(stringLiterals(src), ['x', 'y', 'in ner', 's', 'p t']);
});

test('stringLiterals skips comments and regex literals', () => {
  const src = [
    "// 'not a string'",
    '/* `nor this` */',
    "const re = /['`]/g;",
    'const n = a / b / c;',
    'if (x) return /"/.test(y);',
    "const s = 'kept';",
  ].join('\n');
  assert.deepEqual(stringLiterals(src), ['kept']);
});

test('findOverride catches declarations, not the word', () => {
  assert.ok(findOverride('override gain: f32 = 1.0;'));
  assert.ok(findOverride('@id(0) override steps: u32;'));
  assert.ok(findOverride('const k = 1;\noverride scale = 2.0;'));
  assert.equal(findOverride('override'), null);
  assert.equal(findOverride("blend: 'override' | 'additive'"), null);
  assert.equal(findOverride('// an override of the default'), null);
});

test('findReserved catches reserved words and keywords as names, not elsewhere', () => {
  assert.match(findReserved('struct P { meta: u32, pos: vec3f }')[0], /^meta /);
  assert.match(findReserved('fn f(target: vec4f) -> f32 { return 1.0; }')[0], /^target /);
  assert.match(findReserved('let filter = 1.0;')[0], /^filter /);
  assert.match(findReserved('var<private> loop: f32;')[0], /^loop /);
  assert.deepEqual(findReserved('struct S { a: f32 }\nlet t = s.a; // meta: not code'), []);
  assert.deepEqual(findReserved('/* type: x */ switch (i) { default: { } }'), []);
});

test('isWgsl knows an entry point and a fn', () => {
  assert.ok(isWgsl('@fragment fn fs(){}'));
  assert.ok(isWgsl('fn helper(x: f32) -> f32 { return x; }'));
  assert.ok(!isWgsl('hello'));
});

test('scan flags an override in a shipped file and ignores tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-check-wgsl-'));
  try {
    mkdirSync(join(root, 'src', 'm'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'm', 'ok.ts'),
      'export const W = /* wgsl */ `@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }`;\n',
    );
    writeFileSync(
      join(root, 'src', 'm', 'x.test.ts'),
      'const t = `override bad: f32 = 1.0; fn f() {}`;\n',
    );
    let r = scan(root);
    assert.equal(r.wgsl, 1);
    assert.deepEqual(r.problems, []);
    writeFileSync(
      join(root, 'src', 'm', 'bad.ts'),
      'export const B = `override gain: f32 = 1.0;\n@fragment fn fs() {}`;\n',
    );
    writeFileSync(join(root, 'src', 'm', 'raw.wgsl'), '@id(1) override n: u32;\n');
    writeFileSync(
      join(root, 'src', 'm', 'meta.ts'),
      'export const M = `struct I { meta: u32 }`;\n',
    );
    writeFileSync(join(root, 'src', 'm', 'js.ts'), "export const J = { type: 'from: x' };\n");
    r = scan(root);
    assert.equal(r.problems.length, 3, r.problems.join('\n'));
    assert.match(r.problems.join('\n'), /meta\.ts: WGSL reserved word as an identifier: meta/);
    assert.match(r.problems.join('\n'), /bad\.ts: WGSL override declaration: override gain/);
    assert.match(r.problems.join('\n'), /raw\.wgsl/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
