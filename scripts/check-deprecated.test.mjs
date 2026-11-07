// Tests for the declaration stripper behind `pnpm check:deprecated`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findDeprecatedUses,
  inRepoSource,
  isExempt,
  pruneExportLists,
  stripDeprecated,
  stripTree,
} from './check-deprecated.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const squash = (s) => s.replace(/\s+/g, ' ').trim();

test('drops a deprecated top-level alias and reports its name', () => {
  const r = stripDeprecated(
    '/** New. */\nexport type NavCell = { x: number };\n/** @deprecated Use `NavCell`. */\nexport type Cell = NavCell;\nexport declare const keep: number;\n',
  );
  assert.deepEqual([...r.removed], ['Cell']);
  assert.equal(r.deleted, 1);
  assert.match(r.text, /NavCell/);
  assert.match(r.text, /keep/);
  assert.doesNotMatch(r.text, /Cell = NavCell/);
});

test('drops a deprecated member, keeps its neighbours, and survives generics with commas', () => {
  const r = stripDeprecated(
    [
      'export declare class Stack<A, B> {',
      '    get scenes(): readonly Scene<A, B>[];',
      '    /** @deprecated Read `scenes`. */',
      '    list(): readonly Scene<A, B>[];',
      '    push(s: Scene<A, B>): Promise<void>;',
      '    on(fn: (a: A, b: B) => void): () => void;',
      '}',
      '',
    ].join('\n'),
  );
  assert.equal(r.removed.size, 0, 'a member is not a top-level name');
  assert.equal(r.deleted, 1);
  assert.doesNotMatch(r.text, /list\(\)/);
  assert.match(r.text, /push\(s: Scene<A, B>\): Promise<void>;/);
  assert.match(r.text, /on\(fn: \(a: A, b: B\) => void\): \(\) => void;/);
  assert.match(r.text, /\}\n$/);
});

test('drops a deprecated overload and a deprecated last member before the closing brace', () => {
  const r = stripDeprecated(
    [
      'export interface R {',
      '    make(opts: { texture: T; label?: string }): M;',
      '    /** @deprecated Pass an options object. */',
      '    make(texture: T, label?: string, opts?: { blend?: B }): M;',
      '    /** @deprecated Use `direction`. */',
      '    dir: number[]',
      '}',
    ].join('\n'),
  );
  assert.equal(r.deleted, 2);
  assert.equal(
    squash(r.text),
    'export interface R { make(opts: { texture: T; label?: string }): M; }',
  );
});

test('drops a deprecated whole interface, and a deprecated specifier inside an export list', () => {
  const r = stripDeprecated(
    '/** @deprecated */\nexport interface Old {\n  a: { b: number };\n}\nexport { New, /** @deprecated */ type Gone as Alias, Other } from "./x";\n',
  );
  assert.deepEqual([...r.removed].sort(), ['Alias', 'Old']);
  assert.equal(squash(r.text), 'export { New, Other } from "./x";');
});

test('a string holding a brace or a comment opener does not confuse it', () => {
  const r = stripDeprecated(
    'export declare const A: "{ /*";\n/** @deprecated */\nexport declare const B: "}";\nexport declare const C = 1;\n',
  );
  assert.deepEqual([...r.removed], ['B']);
  assert.match(r.text, /A: "\{ \/\*";/);
  assert.match(r.text, /C = 1/);
});

test('pruneExportLists drops re-exports of removed names and keeps the rest', () => {
  const gone = new Set(['Hit']);
  const r = pruneExportLists(
    "export { type Hit, type PickHit as PH, ray } from './rays';\nexport { other } from './other';\n",
    new Set(),
    (spec) => (spec === './rays' ? gone : null),
  );
  assert.deepEqual([...r.dropped], ['Hit']);
  assert.match(r.text, /export \{ type PickHit as PH, ray \} from '\.\/rays';/);
  assert.match(r.text, /export \{ other \} from '\.\/other';/);
});

test('stripTree follows barrels of barrels, per source file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-deprecated-test-'));
  try {
    mkdirSync(join(dir, 'input'));
    mkdirSync(join(dir, 'ui'));
    writeFileSync(
      join(dir, 'input', 'magnify.d.ts'),
      'export interface SnapGrid { s: number }\n/** @deprecated */\nexport type Grid = SnapGrid;\n',
    );
    writeFileSync(
      join(dir, 'input', 'index.d.ts'),
      "export { type Grid, type SnapGrid } from './magnify';\n",
    );
    writeFileSync(join(dir, 'ui', 'grid.d.ts'), 'export interface Grid { cells: number }\n');
    writeFileSync(join(dir, 'ui', 'index.d.ts'), "export { type Grid } from './grid';\n");
    writeFileSync(
      join(dir, 'index.d.ts'),
      "export { type Grid as InputGrid, type SnapGrid } from './input';\nexport { type Grid } from './ui';\n",
    );
    assert.equal(stripTree(dir), 1);
    assert.equal(
      squash(readFileSync(join(dir, 'input', 'index.d.ts'), 'utf8')),
      "export { type SnapGrid } from './magnify';",
    );
    assert.equal(
      squash(readFileSync(join(dir, 'ui', 'index.d.ts'), 'utf8')),
      "export { type Grid } from './grid';",
    );
    const root = squash(readFileSync(join(dir, 'index.d.ts'), 'utf8'));
    assert.equal(
      root,
      "export { type SnapGrid } from './input'; export { type Grid } from './ui';",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isExempt takes the marker on the line or alone on the line above, test or impl', () => {
  const lines = [
    'a.dir = 1; // deprecated-alias test',
    '// deprecated-alias impl',
    'b.dir = 2;',
    'c.dir = 3; // deprecated alias',
    'x(); // deprecated-alias test',
    'd.dir = 4;',
  ];
  assert.equal(isExempt(lines, 1), true);
  assert.equal(isExempt(lines, 3), true);
  assert.equal(isExempt(lines, 4), false);
  // A trailing marker on the line above covers that line only.
  assert.equal(isExempt(lines, 6), false);
});

test('inRepoSource keeps repo files and drops libs and dependencies', () => {
  assert.equal(inRepoSource(join(repoRoot, 'src/render/lights.ts')), true);
  assert.equal(inRepoSource(join(repoRoot, 'src/render/lights.ts').toLowerCase()), true);
  assert.equal(inRepoSource(join(repoRoot, 'node_modules/typescript/lib/lib.dom.d.ts')), false);
  assert.equal(inRepoSource('/elsewhere/lib.d.ts'), false);
});

test('findDeprecatedUses keeps engine names only and skips exempt lines when asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-deprecated-find-'));
  try {
    const file = join(dir, 'a.ts');
    writeFileSync(
      file,
      [
        "import type { Rect } from '@thunderclap/engine/platform';",
        'export type R = Rect;',
        'export type S = Rect; // deprecated-alias test',
        "document.execCommand('copy');",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'es2022',
          lib: ['es2022', 'dom'],
          noEmit: true,
          types: [],
          paths: { '@thunderclap/engine/platform': [join(repoRoot, 'src/platform/index.ts')] },
        },
        files: [file],
      }),
    );
    const config = join(dir, 'tsconfig.json');
    assert.deepEqual(
      findDeprecatedUses(config).map((u) => u.line),
      [1, 2, 3, 4],
    );
    const engine = findDeprecatedUses(config, undefined, {
      declaredIn: inRepoSource,
      exempt: true,
    });
    assert.deepEqual(
      engine.map((u) => u.line),
      [1, 2],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
