// Tests for the game-side old-name finder (ws/testing-2). Fixtures in
// scripts/fixtures/deprecated-game: each game is copied to a temp folder whose
// `node_modules/@thunderclap/engine` links to an engine, as an installed game has it.
//   game-1x: a game still on 0.x names, against this engine (1.0.0, aliases removed).
//   game-0x + engine-0x: a game on a 0.x engine that still has a `@deprecated` alias.
// Both use the DOM's deprecated `document.execCommand`, which must not be reported.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  calleeAt,
  findGameDeprecations,
  inEngine,
  migrationTable,
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

test('migrationTable reads every row of the guide, with dotted names and signatures split', () => {
  const rows = migrationTable(
    [
      '| Module | 0.x name | v1 replacement |',
      '| --- | --- | --- |',
      '| `anim` | `BlendMode` | `AnimBlendMode` |',
      '| `core` | `SceneStack.list()` | the `scenes` getter |',
      '| `render` | `Renderer.createSpriteMaterial(texture, label?)` | an options object |',
    ].join('\n'),
  );
  assert.deepEqual(
    rows.map((r) => [r.module, r.name, r.type, r.member, r.signature]),
    [
      ['anim', 'BlendMode', null, 'BlendMode', false],
      ['core', 'SceneStack.list', 'SceneStack', 'list', false],
      ['render', 'Renderer.createSpriteMaterial', 'Renderer', 'createSpriteMaterial', true],
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
  const uses = findGameDeprecations(join(game, 'tsconfig.json'));
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
  assert.match(r.stdout, /9 uses of old engine names/);
});
