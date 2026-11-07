// Tests for scripts/api-surface.mjs on a throwaway package. Run by `pnpm check:api`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  announces,
  apiModule,
  entries,
  FROZEN_HEADER,
  unannounced,
  unreleasedSection,
} from './api-changelog.mjs';

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

function setExports(map, version) {
  write(
    'package.json',
    JSON.stringify({ name: '@fixture/pkg', version, type: 'module', exports: map }, null, 2),
  );
}

/** Runs the version-control CLI in the fixture package (a throwaway repo, never this one). */
function vcs(...args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
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
  assert.match(foo.split('\n')[2], new RegExp(`^// ${FROZEN_HEADER}: `));
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

// The freeze rule (ws/v1-cut): after a release, an api/ diff needs its CHANGELOG line.

const LOG = (unreleased) =>
  `# Changelog\n\n## Unreleased\n\n${unreleased}\n## 1.0.0 (2026-11-07)\n\n- foo: *Added* old.\n`;

test('unreleasedSection reads `## Unreleased` (or the older `(unreleased)` heading) to the next heading', () => {
  assert.equal(unreleasedSection(LOG('- a\n')).trim(), '- a');
  assert.equal(unreleasedSection('# C\n\n## Next (unreleased)\n\n- b\n\n## 0.1.0\n').trim(), '- b');
  assert.equal(unreleasedSection('# C\n\n## 1.0.0 (2026-11-07)\n\n- c\n'), null);
  assert.deepEqual(entries('- one\n  wrapped\n\n- two\n'), ['- one\n  wrapped', '- two']);
});

test('an entry announces a module when it names it and says *Breaking* or *Added*', () => {
  assert.equal(announces('- render (ws/x). *Added:* `foo()`.', 'render'), true);
  assert.equal(announces('- *Breaking:* `@thunderclap/engine/ui` drops `x`.', 'ui'), true);
  assert.equal(announces('- render (ws/x). *Fixed:* a leak.', 'render'), false);
  assert.equal(announces('- *Added:* `renderer.x` in render-graph.', 'render'), false);
  assert.equal(announces('- *Added:* nav things.', 'render'), false);
  assert.equal(announces('- *Added:* `@thunderclap/engine` re-exports `x`.', '.'), true);
  assert.equal(announces('- *Added:* `@thunderclap/engine/ui` only.', '.'), false);
  assert.deepEqual(unannounced(['render', 'ui'], LOG('- render. *Added:* x.\n')), ['ui']);
  // The released section never counts: only `## Unreleased` does.
  assert.deepEqual(unannounced(['foo'], LOG('')), ['foo']);
  assert.deepEqual(unannounced(['render'], '# no sections\n'), ['render']);
  assert.equal(apiModule('api/index.api.txt'), '.');
  assert.equal(apiModule('api/render.api.txt'), 'render');
});

test('after a release, an api/ diff fails until CHANGELOG `## Unreleased` names its module', () => {
  setExports({ '.': './src/index.ts', './foo': './src/foo/index.ts' }, '1.0.0');
  write('CHANGELOG.md', LOG(''));
  assert.equal(run('--update').code, 0);
  // Not a repository yet: no release to compare with, so only the surface diff counts.
  assert.match(run().out, /freeze rule skipped/);
  vcs('init', '-q');
  vcs('add', '-A');
  vcs('commit', '-q', '-m', 'release: 1.0.0');
  assert.equal(run().code, 0);

  write('src/foo/later.ts', 'export const LATER = 4;\n');
  write(
    'src/foo/index.ts',
    "export { add as plus, Box } from './math';\nexport type { Opts } from './math';\nexport { EXTRA } from './extra';\nexport { LATER } from './later';\n",
  );
  assert.equal(run('--update').code, 0);
  let r = run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /api\/ differs from the 1\.0\.0 version commit \w+ for `foo`/);
  // A line that names the module but is not *Breaking* or *Added* is not enough.
  write('CHANGELOG.md', LOG('- foo: *Fixed:* `LATER`.\n'));
  assert.equal(run().code, 1);
  write('CHANGELOG.md', LOG('- foo: *Added:* `LATER`.\n'));
  r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /differs from .* for foo; each is announced/);
  // Committed or not, the diff is against the release.
  vcs('add', '-A');
  vcs('commit', '-q', '-m', 'foo: LATER');
  assert.equal(run().code, 0);
  write('CHANGELOG.md', LOG(''));
  assert.equal(run().code, 1);
  // A tag for the version wins over the version commit: tagging here freezes the new surface.
  vcs('tag', 'v1.0.0');
  assert.equal(run().code, 0);
});
