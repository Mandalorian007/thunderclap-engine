// Tests for scripts/bake.mjs. Run by `pnpm check:bake` (node --test), which `pnpm check` runs.
// Bakes scripts/fixtures/level.json (a 20×20 floor and a 2×2×2 box at x = 3) into a temp dir
// through the CLI, then asserts the files, the manifest, `--check`, determinism and that the
// engine's importers accept the bytes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  hashInputs,
  loadConfig,
  loadEngine,
  MANIFEST_NAME,
  parseArgs,
  UsageError,
} from './bake.mjs';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, 'bake.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'bake-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A private copy of the fixtures, so the input edit below touches nothing checked in.
cpSync(join(here, 'fixtures'), join(tmp, 'fixtures'), { recursive: true });
const config = join(tmp, 'fixtures', 'bake.config.json');
const out = join(tmp, 'out');

const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: tmp });
const bytes = (name) => readFileSync(join(out, name));
const manifest = () => JSON.parse(readFileSync(join(out, MANIFEST_NAME), 'utf8'));

test('parseArgs: config, --out, flags, misuse', () => {
  assert.deepEqual(parseArgs(['c.json', '--out', 'd', '--verbose']), {
    config: 'c.json',
    out: 'd',
    check: false,
    watch: false,
    verbose: true,
  });
  assert.equal(parseArgs(['--check']).check, true);
  assert.throws(() => parseArgs(['--out']), UsageError);
  assert.throws(() => parseArgs(['--bogus']), UsageError);
  assert.throws(() => parseArgs(['a', 'b']), UsageError);
  assert.throws(() => parseArgs(['--check', '--watch']), UsageError);
});

test('loadConfig: paths resolve against the config, bad shapes are usage errors', () => {
  const c = loadConfig(config, out);
  assert.equal(c.out, out);
  assert.deepEqual(
    c.entries.map((e) => [e.kind, e.name]),
    [
      ['nav', 'level'],
      ['collider', 'level'],
    ],
  );
  assert.equal(c.entries[0].files[0], join(tmp, 'fixtures', 'level.json'));
  assert.equal(loadConfig(config).out, join(tmp, 'fixtures', 'baked'));
  const bad = join(tmp, 'bad.json');
  writeFileSync(bad, JSON.stringify({ nav: [{ name: 'x' }] }));
  assert.throws(() => loadConfig(bad), /sources/);
  writeFileSync(bad, JSON.stringify({ colliders: [{ name: 'a/b', sources: ['x'] }] }));
  assert.throws(() => loadConfig(bad), /name/);
  writeFileSync(bad, '{}');
  assert.throws(() => loadConfig(bad), /no "nav"/);
  assert.throws(() => loadConfig(join(tmp, 'missing.json')), /no config/);
});

test('misuse exits 1 with usage; --check before any bake exits 1 naming the entries', () => {
  const r = run('--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: pnpm bake/);
  const c = run(config, '--out', out, '--check');
  assert.equal(c.status, 1);
  assert.match(c.stderr, /nav "level" is stale: no manifest/);
  assert.match(c.stderr, /collider "level" is stale/);
});

test('bakes the fixture: files, manifest hashes, importers, --check, determinism', async () => {
  const r = run(config, '--out', out, '--verbose');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /level\.navm {2}\d+ bytes {2}[\d.]+ ms/);
  assert.match(r.stdout, /level\.coll {2}\d+ bytes/);
  assert.match(r.stdout, /bake: 2 entries to/);
  for (const f of ['level.navm', 'level.coll', MANIFEST_NAME]) {
    assert.ok(existsSync(join(out, f)), `missing ${f}`);
  }

  // The manifest lists both entries with the hash of their inputs and the written size.
  const m = manifest();
  assert.equal(m.version, 1);
  assert.match(m.bakedAt, /^\d{4}-\d{2}-\d{2}T/);
  const c = loadConfig(config, out);
  assert.equal(m.entries.length, 2);
  for (let i = 0; i < 2; i++) {
    const e = m.entries[i];
    assert.equal(e.name, 'level');
    assert.equal(e.kind, c.entries[i].kind);
    assert.deepEqual(e.sources, ['level.json']);
    assert.equal(e.sha256, hashInputs(c.entries[i]));
    assert.equal(e.bytes, bytes(i === 0 ? 'level.navm' : 'level.coll').length);
    assert.ok(e.ms >= 0);
  }

  // The engine's importers accept the bytes and see the level: a floor with the box cut out.
  const { nav, geom } = await loadEngine();
  const navm = bytes('level.navm');
  const mesh = nav.importNavMesh(navm.buffer.slice(navm.byteOffset, navm.byteOffset + navm.length));
  assert.ok(mesh.polyCount > 0, 'navmesh has polygons');
  assert.ok(Number.isFinite(mesh.height(-5, -5)), 'floor is walkable');
  assert.ok(Number.isNaN(mesh.height(3, 0)), 'box is not walkable at floor level');
  const coll = bytes('level.coll');
  const collider = geom.importCollider(
    coll.buffer.slice(coll.byteOffset, coll.byteOffset + coll.length),
  );
  assert.equal(collider.triangleCount, 2 + 12);
  assert.equal(collider.sourceCount, 2);
  const hit = geom.createHit();
  assert.ok(geom.raycast(collider, [3, 5, 0], [0, -1, 0], 10, hit));
  assert.ok(Math.abs(hit.y - 2) < 1e-5, `ray lands on the box top, got ${hit.y}`);

  // --check: current, then stale after an input edit, then current again after a rebake.
  const ok = run(config, '--out', out, '--check');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2 entries current/);
  const level = join(tmp, 'fixtures', 'level.json');
  const text = readFileSync(level, 'utf8');
  writeFileSync(level, text.replace('"transform": [1, 0, 0, 3,', '"transform": [1, 0, 0, 4,'));
  const stale = run(config, '--out', out, '--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /nav "level" is stale: inputs changed/);
  assert.match(stale.stderr, /collider "level" is stale: inputs changed/);
  writeFileSync(level, text);
  assert.equal(run(config, '--out', out, '--check').status, 0);

  // Determinism: a second bake writes the same bytes.
  const again = run(config, '--out', out);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(bytes('level.navm').equals(navm), 'navmesh bytes differ between bakes');
  assert.ok(bytes('level.coll').equals(coll), 'collider bytes differ between bakes');
  assert.equal(manifest().entries[0].sha256, m.entries[0].sha256);
});

test('a .gltf source is parsed through the engine and placed by its node', async () => {
  // One triangle at y = 0, moved up by 1.5 by its node.
  const positions = new Float32Array([0, 0, 0, 0, 0, 2, 2, 0, 0]);
  const bin = Buffer.from(positions.buffer);
  writeFileSync(join(tmp, 'tri.bin'), bin);
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [0, 1.5, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [2, 0, 2],
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ uri: 'tri.bin', byteLength: bin.length }],
  };
  writeFileSync(join(tmp, 'tri.gltf'), JSON.stringify(gltf));
  writeFileSync(
    join(tmp, 'tri.config.json'),
    JSON.stringify({ out: 'tri-out', colliders: [{ name: 'tri', sources: ['tri.gltf'] }] }),
  );
  const r = run('tri.config.json');
  assert.equal(r.status, 0, r.stderr);
  const { geom } = await loadEngine();
  const b = readFileSync(join(tmp, 'tri-out', 'tri.coll'));
  const c = geom.importCollider(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.equal(c.triangleCount, 1);
  assert.ok(Math.abs(c.bounds.min[1] - 1.5) < 1e-5, `placed at y 1.5, got ${c.bounds.min[1]}`);
});
