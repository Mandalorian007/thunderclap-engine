// Tests for scripts/api-surface.mjs on a throwaway package. Run by `pnpm check:api`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'api-surface.mjs');
let dir;

function run(...args) {
  const r = spawnSync(process.execPath, [script, '--root', dir, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

function write(rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function setExports(map) {
  write('package.json', JSON.stringify({ name: '@fixture/pkg', type: 'module', exports: map }));
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'api-surface-test-'));
  setExports({
    '.': './src/index.ts',
    './foo': './src/foo/index.ts',
    './package.json': './package.json',
  });
  write('src/index.ts', "export { add } from './foo/math';\n");
  write(
    'src/foo/math.ts',
    [
      '/** Adds. */',
      'export function add(a: number, b: number): number { return a + b; }',
      'export interface Opts { scale?: number }',
      'export class Box { private secret = 1; readonly size: number; constructor(size: number) { this.size = size + this.secret; } }',
      '',
    ].join('\n'),
  );
  write(
    'src/foo/index.ts',
    "export { add as plus, Box } from './math';\nexport type { Opts } from './math';\n",
  );
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('update writes one sorted file per exports entry and check then passes', () => {
  assert.equal(run('--update').code, 0);
  const foo = readFileSync(join(dir, 'api/foo.api.txt'), 'utf8');
  const names = [...foo.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(names, ['Box', 'Opts', 'plus']);
  assert.match(foo, /## plus {2}\(alias of add\)\nfunction add\(a: number, b: number\): number;/);
  assert.match(foo, /## Opts {2}\(type-only\)/);
  assert.doesNotMatch(foo, /secret|Adds\./);
  assert.match(readFileSync(join(dir, 'api/index.api.txt'), 'utf8'), /^## add$/m);
  assert.equal(run().code, 0);
});

test('adding an export fails the check with a diff; api:update makes it pass', () => {
  write('src/foo/extra.ts', 'export const EXTRA = 3;\n');
  write(
    'src/foo/index.ts',
    "export { add as plus, Box } from './math';\nexport type { Opts } from './math';\nexport { EXTRA } from './extra';\n",
  );
  const r = run();
  assert.equal(r.code, 1);
  assert.match(r.out, /--- api\/foo\.api\.txt/);
  assert.match(r.out, /^\+## EXTRA$/m);
  assert.match(r.out, /^\+const EXTRA = 3;$/m);
  assert.equal(run('--update').code, 0);
  assert.equal(run().code, 0);
});

test('a signature change fails; a comment-only change does not', () => {
  const math = readFileSync(join(dir, 'src/foo/math.ts'), 'utf8');
  write('src/foo/math.ts', math.replace('/** Adds. */', '/** Adds two numbers. */'));
  assert.equal(run().code, 0);
  write('src/foo/math.ts', math.replace('b: number)', 'b = 0)'));
  const r = run();
  assert.equal(r.code, 1);
  assert.match(r.out, /^-function add\(a: number, b: number\): number;$/m);
  assert.match(r.out, /^\+function add\(a: number, b\?: number\): number;$/m);
  write('src/foo/math.ts', math);
  assert.equal(run().code, 0);
});

test('a deprecation is part of the surface', () => {
  const math = readFileSync(join(dir, 'src/foo/math.ts'), 'utf8');
  write('src/foo/math.ts', math.replace('/** Adds. */', '/** @deprecated Use `sum`. */'));
  const r = run();
  assert.equal(r.code, 1);
  assert.match(r.out, /^\+@deprecated$/m);
  write('src/foo/math.ts', math);
  assert.equal(run().code, 0);
});

test('a removed exports entry leaves a stale file the check reports and update deletes', () => {
  setExports({ '.': './src/index.ts' });
  const r = run();
  assert.equal(r.code, 1);
  assert.match(r.out, /api\/foo\.api\.txt: stale/);
  assert.match(run('--update').out, /removed stale api\/foo\.api\.txt/);
  assert.equal(run().code, 0);
});
