// The published build's shader trim (scripts/wgsl-trim.mjs, ws/size-pass): a `/* wgsl */` literal
// loses its comments and the spaces around its lines, keeps every line and every `${…}`, and a
// comment that runs into a `${…}` stays whole; other code is untouched. Every shader module in src/
// trims to the same lines.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the cases are module sources whose `${…}` holes are text
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { trimWgsl } from './wgsl-trim.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

test('a wgsl literal loses its comments and the spaces around its lines, and keeps its lines', () => {
  const code = [
    "const a = 1; // the module's own comment",
    'export const s = /* wgsl */ `',
    '  // a whole-line comment',
    '  fn f(x: f32) -> f32 {   ',
    '    return x * 2.0; // a trailing one',
    '  }',
    '`;',
  ].join('\n');
  assert.equal(
    trimWgsl(code),
    [
      "const a = 1; // the module's own comment",
      'export const s = /* wgsl */ `',
      '',
      'fn f(x: f32) -> f32 {',
      'return x * 2.0;',
      '}',
      '`;',
    ].join('\n'),
  );
});

test('a ${…} is kept as written, and the text after it continues its line', () => {
  const code =
    'const s = /* wgsl */ `\n  let n = ${count} ;  // n\n  ${`  nested // kept`}\n  done();\n`;';
  assert.equal(
    trimWgsl(code),
    'const s = /* wgsl */ `\nlet n = ${count} ;\n${`  nested // kept`}\ndone();\n`;',
  );
});

test('a comment that runs into a ${…} stays whole', () => {
  const code = 'const s = /* wgsl */ `\n  x = 1; // about ${name} here\n  y = 2;\n`;';
  assert.equal(trimWgsl(code), 'const s = /* wgsl */ `\nx = 1; // about ${name} here\ny = 2;\n`;');
});

test("an escaped backtick doesn't end the literal; code outside a wgsl literal is untouched", () => {
  const code = 'const s = /* wgsl */ `\n  // see \\`foo\\`\n  a();\n`;\nconst t = `\n  // kept\n`;';
  assert.equal(trimWgsl(code), 'const s = /* wgsl */ `\n\na();\n`;\nconst t = `\n  // kept\n`;');
  assert.equal(trimWgsl('const x = `  // no mark`;'), 'const x = `  // no mark`;');
});

test('every shader module in src/ trims to as many lines and holes, and no larger', () => {
  const files = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  let seen = 0;
  let smaller = 0;
  for (const file of files(SRC)) {
    if (file.endsWith('.test.ts')) continue;
    const code = readFileSync(file, 'utf8');
    if (!code.includes('/* wgsl */')) continue;
    seen++;
    const out = trimWgsl(code);
    assert.equal(out.split('\n').length, code.split('\n').length, file);
    assert.equal(out.split('${').length, code.split('${').length, file);
    assert.ok(out.length <= code.length, file);
    if (out.length < code.length) smaller++;
  }
  assert.ok(seen > 20, `only ${seen} shader modules`);
  assert.ok(smaller > 20, `only ${smaller} shader modules shrink`);
});
