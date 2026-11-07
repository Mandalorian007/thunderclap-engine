// Tests for the game-side old-name finder (ws/testing-2). Fixtures in
// scripts/fixtures/deprecated-game: each game is copied to a temp folder whose
// `node_modules/@thunderclap/engine` links to an engine, as an installed game has it.
//   game-1x: a game still on 0.x names, against this engine (1.0.0, aliases removed); its
//   src/reads.ts holds the errors that do not print the engine type (ws/testing-3), and
//   src/wrapped.ts the same on receivers wrapped in parentheses or assertions (ws/testing-4).
//   game-0x + engine-0x: a game on a 0.x engine that still has a `@deprecated` alias.
// Both use the DOM's deprecated `document.execCommand`, which must not be reported.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  calleeAt,
  findGameDeprecations,
  inEngine,
  migrationTable,
  removedRowsFor,
} from './check-deprecated-game.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fixtures = join(repoRoot, 'scripts/fixtures/deprecated-game');

/** Copy `game` to a temp folder with `node_modules/@thunderclap/engine` → `engine`. */
function install(game, engine, t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'check-deprecated-game-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(fixtures, game), dir, { recursive: true });
  mkdirSync(join(dir, 'node_modules/@thunderclap'), { recursive: true });
  symlinkSync(engine, join(dir, 'node_modules/@thunderclap/engine'), 'dir');
  mkdirSync(join(dir, 'node_modules/@webgpu'), { recursive: true });
  symlinkSync(
    join(repoRoot, 'node_modules/@webgpu/types'),
    join(dir, 'node_modules/@webgpu/types'),
    'dir',
  );
  return dir;
}

const lines = (uses) => uses.map((u) => `${u.line}:${u.kind}:${u.rows.map((r) => r.name)}`);
const inFile = (uses, name) => uses.filter((u) => basename(u.file) === name);

test('migrationTable reads every row of the guide, with dotted names and signatures split', () => {
  const rows = migrationTable(
    [
      '| Module | 0.x name | v1 replacement |',
      '| --- | --- | --- |',
      '| `anim` | `BlendMode` | `AnimBlendMode` |',
      '| `core` | `SceneStack.list()` | the `scenes` getter |',
      '| `render` | `Renderer.createSpriteMaterial(texture, label?)` | an options object |',
      '',
      '| Module | 0.x call | v1 read |',
      '| assets | `AssetCache.stats()` | the `stats` getter |',
    ].join('\n'),
  );
  assert.deepEqual(
    rows.map((r) => [r.module, r.name, r.type, r.member, r.signature]),
    [
      ['anim', 'BlendMode', null, 'BlendMode', false],
      ['core', 'SceneStack.list', 'SceneStack', 'list', false],
      ['render', 'Renderer.createSpriteMaterial', 'Renderer', 'createSpriteMaterial', true],
      ['assets', 'AssetCache.stats', 'AssetCache', 'stats', false],
    ],
  );
  assert.equal(rows[0].replacement, '`AnimBlendMode`');
});

test('calleeAt finds the method whose argument list holds a position', () => {
  const src = "r.createSpriteMaterial(tex, 'hero')";
  assert.equal(calleeAt(src, src.indexOf("'hero'")), 'createSpriteMaterial');
  assert.equal(calleeAt('f(a, g(b), c)', 'f(a, g(b), c)'.indexOf('c')), 'f');
  assert.equal(calleeAt('x = 1', 4), null);
});

test('inEngine keeps the engine source and drops its dependencies and other paths', () => {
  const ours = inEngine(repoRoot);
  assert.equal(ours(join(repoRoot, 'src/input/index.ts')), true);
  assert.equal(ours(join(repoRoot, 'node_modules/typescript/lib/lib.dom.d.ts')), false);
  assert.equal(ours('/elsewhere/game/src/game.ts'), false);
});

test('a game on 0.x names against engine 1.0.0: each removed name with its replacement', (t) => {
  const game = install('game-1x', repoRoot, t);
  const uses = inFile(findGameDeprecations(join(game, 'tsconfig.json')), 'game.ts');
  assert.deepEqual(lines(uses), [
    '4:removed:Hit,Hit', // the root barrel: geom's and input's
    '5:removed:BlendMode',
    '8:removed:defaultPostSettings',
    '30:removed:SceneStack.list',
    '31:removed:Input.getBindings',
    '32:removed:SunLight.dir',
    '33:removed:PostSettings.fog',
    '34:removed:LoadTextureArrayOptions.mipFilter',
    '35:removed:Renderer.createSpriteMaterial',
  ]);
  // A root-barrel import names every module's row; a module import only its own.
  assert.deepEqual(
    uses[0].rows.map((r) => r.module),
    ['geom', 'input'],
  );
  assert.deepEqual(
    uses[1].rows.map((r) => r.module),
    ['anim'],
  );
  // Not reported: line 36 (DOM `execCommand`), 37 (the game's own type error) and 38's
  // `own.missing` (a property missing from the game's own type).
  assert.ok(uses.every((u) => u.line < 36));
});

test('reads that became getters and members on a wrapped engine type map to their rows', (t) => {
  const game = install('game-1x', repoRoot, t);
  const uses = inFile(findGameDeprecations(join(game, 'tsconfig.json')), 'reads.ts');
  assert.deepEqual(
    uses.map((u) => `${u.line}:${u.code}:${u.rows.map((r) => `${r.module} ${r.name}`)}`),
    [
      '21:2349:assets AssetCache.stats', // `cache.stats()`
      '22:2349:host HostFullscreen.active', // `host.fullscreen.active()`
      '23:2349:host HostLifecycle.state', // through `?.` on `HostLifecycle | undefined`
      '24:2339:core SceneStack.list', // the error prints `Stack`, the game's alias
      '25:2349:assets AssetCache.stats', // on the game's own `Cache extends AssetCache`
    ],
  );
  // Not reported: `own.count()` (26, the game's own value) and `stack.nothing` (27, no row).
  assert.ok(uses.every((u) => u.kind === 'removed' && u.line < 26));
  assert.match(uses[0].rows[0].replacement, /`stats` getter/);
});

test('receivers wrapped in parentheses or assertions resolve to the engine type', (t) => {
  const game = install('game-1x', repoRoot, t);
  const uses = inFile(findGameDeprecations(join(game, 'tsconfig.json')), 'wrapped.ts');
  assert.deepEqual(
    uses.map((u) => `${u.line}:${u.code}:${u.rows.map((r) => `${r.module} ${r.name}`)}`),
    [
      '20:2339:core SceneStack.list', // `(value as Stack).list()`
      '21:2339:core SceneStack.list', // `(<Stack>value).list()`
      '22:2339:core SceneStack.list', // `maybe!.list()` on `Stack | undefined`
      '23:2339:core SceneStack.list', // `(maybe as Stack | undefined)!.list()`
      '24:2339:core SceneStack.list', // `(stack satisfies SceneStack).list()`
      '25:2349:host HostFullscreen.active', // nested assertions
      '26:2349:assets AssetCache.stats', // `(cache as AssetCache).stats()`
      '27:2349:host HostLifecycle.state', // `(… as Host['lifecycle'])?.state()`
    ],
  );
  // Not reported: `(own as { count: number }).count()` (28, the game's own value).
  assert.ok(uses.every((u) => u.kind === 'removed' && u.line < 28));
});

test('removedRowsFor maps TS2349 and a wrapped TS2339 only through engineTypesAt', () => {
  const rows = migrationTable(
    [
      '| core | `SceneStack.list()` | the `scenes` getter |',
      '| assets | `AssetCache.stats()` | the `stats` getter |',
    ].join('\n'),
  );
  const text = 'cache.stats(); stack.list(); stats();';
  const at = (s) => text.indexOf(s);
  const notCallable = { code: 2349, pos: at('stats('), text: 'This expression is not callable.' };
  const missing = {
    code: 2339,
    pos: at('list'),
    text: "Property 'list' does not exist on type 'Stack'.",
  };
  const spec = /^@thunderclap\/engine(?:\/([\w-]+))?$/;
  const names = (r) => r.map((x) => x.name);
  // Without a checker neither error prints an engine type.
  assert.deepEqual(removedRowsFor(notCallable, text, rows, spec), []);
  assert.deepEqual(removedRowsFor(missing, text, rows, spec), []);
  const types = { [at('stats(')]: ['AssetCache'], [at('list')]: ['SceneStack'] };
  const typesAt = (pos) => new Set(types[pos] ?? []);
  assert.deepEqual(names(removedRowsFor(notCallable, text, rows, spec, typesAt)), [
    'AssetCache.stats',
  ]);
  assert.deepEqual(names(removedRowsFor(missing, text, rows, spec, typesAt)), ['SceneStack.list']);
  // A bare call (no receiver) and a game type are not engine members.
  const bare = { ...notCallable, pos: text.lastIndexOf('stats') };
  assert.deepEqual(
    removedRowsFor(bare, text, rows, spec, () => new Set(['AssetCache'])),
    [],
  );
  assert.deepEqual(
    removedRowsFor(notCallable, text, rows, spec, () => new Set(['Own'])),
    [],
  );
});

test('a game on a 0.x engine: the engine alias, not the DOM or the game deprecations', (t) => {
  const engine = realpathSync(mkdtempSync(join(tmpdir(), 'check-deprecated-engine-')));
  t.after(() => rmSync(engine, { recursive: true, force: true }));
  cpSync(join(fixtures, 'engine-0x'), engine, { recursive: true });
  const game = install('game-0x', engine, t);
  const uses = findGameDeprecations(join(game, 'tsconfig.json'), { engine });
  // Line 4 imports `Hit`, line 9 uses it; `execCommand` (10) and `oldScore` (11) drop out.
  assert.deepEqual(lines(uses), ['4:deprecated:', '9:deprecated:']);
  assert.ok(uses.every((u) => u.code === 6385));
});

test('the CLI runs from the game folder through node_modules and exits 1 on a use', (t) => {
  const game = install('game-1x', repoRoot, t);
  const script = join(game, 'node_modules/@thunderclap/engine/scripts/check-deprecated-game.mjs');
  const r = spawnSync(process.execPath, [script], { cwd: game, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /src\/game\.ts:5:15 {2}TS2305: .*'BlendMode'/);
  assert.match(r.stdout, /anim BlendMode → `AnimBlendMode`/);
  assert.doesNotMatch(r.stdout, /execCommand/);
  assert.match(r.stdout, /src\/reads\.ts:21:\d+ {2}TS2349: /);
  assert.match(r.stdout, /assets AssetCache\.stats → the `stats` getter/);
  assert.match(r.stdout, /22 uses of old engine names/);
});
