// Tests for scripts/bake-nav.mjs (ws/nav-6). Run by `pnpm check:bake` (node --test), which
// `pnpm check` runs. Fixtures: scripts/fixtures/level.json (a 20×20 floor and a 2×2×2 box, the
// `pnpm bake` fixture) and scripts/fixtures/nav-yard.glb (the demos/arpg courtyard's navmesh
// triangle soup as one glTF mesh: a 60×60 m floor, walls, colonnades, rubble and a
// stepped dais). Both bake to the same polygons with the engine defaults as with the options
// their callers spell out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadEngine, UsageError } from './bake.mjs';
import { bakeNavFile, DEFAULT_OPTIONS, parseNavArgs, resolveNavOptions } from './bake-nav.mjs';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, 'bake-nav.mjs');
const level = join(here, 'fixtures', 'level.json');
const yard = join(here, 'fixtures', 'nav-yard.glb');
const tmp = mkdtempSync(join(tmpdir(), 'bake-nav-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: tmp });
let n = 0;
const optionsFile = (json) => {
  const p = join(tmp, `options-${n++}.json`);
  writeFileSync(p, typeof json === 'string' ? json : JSON.stringify(json));
  return p;
};

/** The options demos/arpg passes to `bakeNavMesh` for its courtyard. */
const ARPG = {
  cellSize: 0.3,
  cellHeight: 0.1,
  agentHeight: 1.8,
  agentRadius: 0.4,
  agentMaxClimb: 0.3,
  agentMaxSlope: 45,
};
/** bake-nav's DEFAULT_OPTIONS as ws/nav-5 shipped them. */
const NAV5 = {
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 1.8,
  agentRadius: 0.4,
  agentMaxClimb: 0.4,
  agentMaxSlope: 45,
};

test('parseNavArgs: positionals, --options, --verbose, misuse', () => {
  assert.deepEqual(parseNavArgs(['a.glb', 'b.navm', '--options', 'o.json', '--verbose']), {
    input: 'a.glb',
    output: 'b.navm',
    options: 'o.json',
    verbose: true,
  });
  assert.deepEqual(parseNavArgs(['a.json', 'b.navm']), {
    input: 'a.json',
    output: 'b.navm',
    options: null,
    verbose: false,
  });
  assert.throws(() => parseNavArgs(['a.json']), UsageError);
  assert.throws(() => parseNavArgs(['a', 'b', '--options']), UsageError);
  assert.throws(() => parseNavArgs(['a', 'b', '--nope']), UsageError);
});

test('resolveNavOptions: the engine defaults derived from the script cellSize', async () => {
  assert.deepEqual(DEFAULT_OPTIONS, { cellSize: 0.3 });
  const o = await resolveNavOptions({});
  assert.equal(o.cellSize, 0.3);
  assert.equal(o.cellHeight, 0.15);
  assert.equal(o.agentHeight, 2);
  assert.equal(o.agentRadius, 0.6);
  assert.equal(o.agentMaxClimb, 0.3);
  assert.equal(o.agentMaxSlope, 45);
  assert.equal(o.maxVertsPerPoly, 6);
  const big = await resolveNavOptions({ cellSize: 0.5, cellHeight: 0.2 });
  assert.equal(big.agentRadius, 1);
  assert.equal(big.agentMaxClimb, 0.4);
  // The same function the engine bakes with.
  const { nav } = await loadEngine();
  assert.deepEqual(
    await resolveNavOptions({ cellSize: 0.25 }),
    nav.resolveNavBakeOptions({ cellSize: 0.25 }),
  );
});

test('resolveNavOptions: a bad value is a UsageError naming the option and value', async () => {
  await assert.rejects(resolveNavOptions({ agentHeight: 'tall' }, 'nav.json'), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /^nav\.json: bakeNavMesh: agentHeight must be .*got "tall"/);
    return true;
  });
  await assert.rejects(resolveNavOptions({ agentMaxSlope: 120 }), /agentMaxSlope .*got 120/);
  await assert.rejects(resolveNavOptions({ cellSize: 0 }), /cellSize .*got 0/);
  await assert.rejects(resolveNavOptions({ agentRadius: null }), /agentRadius .*got null/);
});

/** Polygons equal: same vertex indices per polygon, same XZ; Y within half the larger cellHeight. */
function assertSamePolygons(a, b, maxDy) {
  assert.ok(a.polyCount > 0);
  assert.equal(a.polyCount, b.polyCount);
  assert.equal(a.vertCount, b.vertCount);
  assert.deepEqual(a.polys, b.polys);
  assert.deepEqual(a.adjacency, b.adjacency);
  for (let i = 0; i < a.vertCount; i++) {
    assert.equal(a.verts[i * 3], b.verts[i * 3]);
    assert.equal(a.verts[i * 3 + 2], b.verts[i * 3 + 2]);
    assert.ok(Math.abs(a.verts[i * 3 + 1] - b.verts[i * 3 + 1]) <= maxDy + 1e-6);
  }
}

test('defaults bake the arpg courtyard and the nav-5 fixture to the same polygons', async () => {
  const { nav } = await loadEngine();
  const bake = async (input, json) =>
    nav.importNavMesh((await bakeNavFile(input, json ? optionsFile(json) : null)).bytes);
  const yardExplicit = await bake(yard, ARPG);
  const yardDefault = await bake(yard, null);
  assert.equal(yardExplicit.polyCount, 164);
  // Vertex heights snap to cells, so the only difference is cellHeight 0.1 against 0.15.
  assertSamePolygons(yardDefault, yardExplicit, 0.05);
  const levelExplicit = await bake(level, NAV5);
  const levelDefault = await bake(level, null);
  assertSamePolygons(levelDefault, levelExplicit, 0.05);
  // With the cell height pinned, the defaults are byte-identical to the spelled-out options.
  const pinned = await bakeNavFile(yard, optionsFile({ cellSize: 0.3, cellHeight: 0.1 }));
  const full = await bakeNavFile(yard, optionsFile(ARPG));
  assert.deepEqual(new Uint8Array(pinned.bytes), new Uint8Array(full.bytes));
});

test('CLI: bakes, is deterministic, and exits 1 naming a bad option', () => {
  const out = join(tmp, 'out', 'level.navm');
  const r1 = run(level, out);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /bake:nav: .*level\.navm \(\d+ polygons, \d+ bytes\)/);
  const first = readFileSync(out);
  const r2 = run(level, out, '--options', optionsFile({}));
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(readFileSync(out), first);

  const bad = run(level, out, '--options', optionsFile({ agentMaxClimb: -1 }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /agentMaxClimb must be a finite number >= 0, got -1/);
  const notJson = run(level, out, '--options', optionsFile('{'));
  assert.equal(notJson.status, 1);
  const missing = run(join(tmp, 'nope.json'), out);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no input/);
});

test('CLI: a bake with nothing walkable warns once on stderr', () => {
  // One vertical wall: triangles, but no walkable surface.
  const wall = join(tmp, 'wall.json');
  writeFileSync(
    wall,
    JSON.stringify({
      positions: [0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0],
      indices: [0, 1, 2, 0, 2, 3],
    }),
  );
  const r = run(wall, join(tmp, 'wall.navm'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(0 polygons/);
  const warnings = r.stderr.match(/\[nav\] bakeNavMesh: 0 polygons from 2 triangles/g) ?? [];
  assert.equal(warnings.length, 1, r.stderr);
});
