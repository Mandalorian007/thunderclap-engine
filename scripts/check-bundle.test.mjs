// Tests for scripts/check-bundle.mjs's pure parts (run by `pnpm check:bundle`): the entry list,
// the entry source, which folders a build pulled in, and the verdict on a row.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetFor, entries, entrySource, foldersIn, verdict } from './check-bundle.mjs';

const pkg = {
  exports: {
    '.': './src/index.ts',
    './render': './src/render/index.ts',
    './input': './src/input/index.ts',
    './voxel': './src/voxel/index.ts',
    './package.json': './package.json',
  },
};

test('entries: one per TS subpath, then the named sets', () => {
  const e = entries(pkg);
  const names = e.map((x) => x.name);
  assert.deepEqual(names.slice(0, 4), ['.', './render', './input', './voxel']);
  assert.ok(!names.includes('./package.json'));
  assert.deepEqual(e.find((x) => x.name === './render').excludes, ['ui', 'audio', 'voxel']);
  assert.deepEqual(e.find((x) => x.name === './input').excludes, ['render']);
  const rv = e.find((x) => x.name.startsWith('render + voxel'));
  assert.deepEqual(
    rv.imports.map((i) => i.from),
    ['./render', './voxel', './voxel'],
  );
});

test('entrySource re-exports a whole subpath or the named imports', () => {
  const [root, all] = [entries(pkg)[0], entries(pkg).find((x) => x.name === 'render { Renderer }')];
  assert.equal(entrySource(root, pkg, '/r'), 'export * from "/r/src/index.ts";\n');
  assert.equal(
    entrySource(all, pkg, '/r'),
    'export { Renderer as e0 } from "/r/src/render/index.ts";\n',
  );
});

test('foldersIn counts only modules that rendered code', () => {
  const f = foldersIn(
    {
      '/r/src/render/a.ts': { renderedLength: 10 },
      '/r/src/ui/b.ts': { renderedLength: 0 },
      '/r/src/audio/c.ts': { renderedLength: 3 },
      '/r/node_modules/x.js': { renderedLength: 9 },
    },
    '/r',
  );
  assert.deepEqual([...f].sort(), ['audio', 'render']);
});

test('verdict: missing budget, over budget and a leak each fail', () => {
  const ok = { name: 'x', gzip: 100, leaked: [], leakedFrom: {} };
  assert.deepEqual(verdict(ok, 100), []);
  assert.match(verdict(ok, undefined)[0], /no budget/);
  assert.match(verdict(ok, 99)[0], /over its budget/);
  assert.match(
    verdict({ ...ok, leaked: ['ui'], leakedFrom: { ui: 'src/ui/a.ts' } }, 200)[0],
    /pulls code from src\/ui\//,
  );
});

test('budgetFor adds 5% and rounds up to 100 B', () => {
  assert.equal(budgetFor(1000), 1100);
  assert.equal(budgetFor(10_000), 10_500);
});
