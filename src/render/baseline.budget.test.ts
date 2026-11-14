/**
 * Counted work, the 1.3 baseline (E-041, D2 R2; ws/budget): today's bench rungs, two 2D harness
 * scenes and the D2-P1 distinct-mesh scene, each run on the counted fake device
 * (`createWorkMeter`), with what a frame does pinned in `baseline.budget.json` and written into
 * docs/BENCH.md ("Counted work, 1.3 baseline").
 *
 * - Every scene must stay at or under its baseline, counter by counter: this is the guard the
 *   retained render core (D1 §3) must beat or explain. A change that does more work in a frame
 *   writes the baseline again and says why in its PR.
 * - The 2D scenes also keep a call-trace golden (sha256 of every call, in order): The Last Rune's
 *   path must not change under it (D1 §3.9).
 * - Rewrite both, and the docs/BENCH.md section rendered from them, with
 *   `TC_BUDGET=write pnpm vitest run src/render/baseline.budget.test.ts`.
 *
 * The bench scenes mirror harness/bench.ts (the same seeded field, rung by rung; the src tree
 * cannot import the harness, so the ladder's ids are read from harness/bench-state.ts as text and
 * checked against this file's). The bench page times the rungs in a browser; this counts them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { env } from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { ParticleSystem } from '../fx/particles';
import {
  type BudgetLimits,
  budget,
  createWorkMeter,
  diffTraceGolden,
  type TraceGolden,
  traceGolden,
  type WorkMeter,
  type WorkReport,
} from '../testing/budget';
import { createTestGame } from '../testing/test-game';
import { Camera } from './camera';
import { createFakeDevice, type FakeDevice, fakeCanvasContext } from './fake-gpu';
import { atlasFrames, createFlipbook } from './flipbook';
import {
  type DrawParams,
  INSTANCE_PARAM_FLOATS,
  type InstanceParams,
  writeInstanceParams,
} from './frame';
import { Lights, type PointLight } from './lights';
import { VERTEX_LAYOUT_3D } from './mesh';
import { Renderer } from './renderer';
import { createTileLayer } from './tile-layer';
import { Transform } from './transform';

const BASELINE_URL = new URL('./baseline.budget.json', import.meta.url);
const BENCH_DOC_URL = new URL('../../docs/BENCH.md', import.meta.url);
const SECTION = '## Counted work, 1.3 baseline';
const WRITE = env.TC_BUDGET === 'write';

/** The counters a baseline row keeps (per frame). */
const KEYS = [
  'commands',
  'draw',
  'drawIndexed',
  'setPipeline',
  'setBindGroup',
  'setVertexBuffer',
  'beginRenderPass',
  'beginComputePass',
  'dispatch',
  'submit',
  'writeBuffer',
  'writeBufferBytes',
  'writeTexture',
  'copies',
  'createBuffer',
  'createTexture',
  'createBindGroup',
  'createOther',
  'typedArrays',
  'arrayBuffers',
  'clockReads',
] as const satisfies readonly (keyof BudgetLimits)[];

type Row = Record<(typeof KEYS)[number], number>;
interface Baseline {
  scenes: Record<string, Row>;
  views: Record<string, Record<string, Row>>;
  goldens: Record<string, TraceGolden>;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function rowOf(r: WorkReport): Row {
  const out = {} as Row;
  for (const k of KEYS) {
    out[k] = round(
      k === 'clockReads'
        ? r.clockReads
        : k === 'typedArrays' || k === 'arrayBuffers'
          ? r.allocs[k]
          : r.gpu[k],
    );
  }
  return out;
}

function viewRow(r: WorkReport, name: string): Row {
  const c = r.views[name]!;
  const out = { ...rowOf(r) };
  for (const k of KEYS) {
    if (k === 'clockReads' || k === 'typedArrays' || k === 'arrayBuffers') out[k] = 0;
    else out[k] = round(c[k]);
  }
  return out;
}

const kept: Baseline = WRITE
  ? { scenes: {}, views: {}, goldens: {} }
  : (JSON.parse(readFileSync(BASELINE_URL, 'utf8')) as Baseline);
const got: Baseline = { scenes: {}, views: {}, goldens: {} };

/** Hold `r` to the kept row for `name` (at or under it, counter by counter), and keep it. */
function hold(name: string, r: WorkReport): void {
  const row = rowOf(r);
  got.scenes[name] = row;
  if (WRITE) return;
  const want = kept.scenes[name];
  expect(want, `${name}: no baseline row; run with TC_BUDGET=write`).toBeDefined();
  // Rounded to the row's precision, plus float noise.
  const limits: BudgetLimits = {};
  for (const k of KEYS) limits[k] = want![k] + 0.0011;
  budget(r, limits, name);
}

function holdView(name: string, view: string, r: WorkReport): void {
  const row = viewRow(r, view);
  got.views[name] ??= {};
  got.views[name]![view] = row;
  if (WRITE) return;
  const want = kept.views[name]?.[view];
  expect(want, `${name}/${view}: no baseline row`).toBeDefined();
  for (const k of KEYS) expect(row[k], `${name}/${view} ${k}`).toBeLessThanOrEqual(want![k]);
}

function holdGolden(name: string, r: WorkReport): void {
  const g = traceGolden(r.trace!);
  got.goldens[name] = g;
  if (WRITE) return;
  const want = kept.goldens[name];
  expect(want, `${name}: no trace golden`).toBeDefined();
  expect(diffTraceGolden(g, want!), `${name}: the frame's calls`).toBeNull();
}

const n = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 1 });

/** The docs/BENCH.md section for a baseline: everything from `SECTION` to the end of the file. */
function benchSection(b: Baseline): string {
  const head = [
    'Scene',
    'Commands',
    'Draws',
    'Pipelines',
    'Bind groups',
    'Vertex buffers',
    'Passes',
    'Dispatches',
    'Submits',
    'Writes',
    'Bytes written',
    'Creates',
    'Typed arrays',
    'Clock reads',
  ];
  const cells = (name: string, r: Row) => [
    name,
    n(r.commands),
    n(r.draw + r.drawIndexed),
    n(r.setPipeline),
    n(r.setBindGroup),
    n(r.setVertexBuffer),
    n(r.beginRenderPass + r.beginComputePass),
    n(r.dispatch),
    n(r.submit),
    n(r.writeBuffer + r.writeTexture),
    n(r.writeBufferBytes),
    n(r.createBuffer + r.createTexture + r.createBindGroup + r.createOther),
    n(r.typedArrays + r.arrayBuffers),
    n(r.clockReads),
  ];
  const rows: string[][] = [];
  for (const [name, r] of Object.entries(b.scenes)) {
    rows.push(cells(`\`${name}\``, r));
    for (const [view, v] of Object.entries(b.views[name] ?? {}))
      rows.push(cells(`↳ view \`${view}\``, v));
  }
  const table = [
    `| ${head.join(' | ')} |`,
    `| ${head.map((_h, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
  const goldens = Object.entries(b.goldens)
    .map(
      ([name, g]) =>
        `- \`${name}\`: ${g.perFrame.map(([c, f]) => `${c} calls × ${f} frames`).join(', ')}, sha256 \`${g.sha256.slice(0, 16)}…\``,
    )
    .join('\n');
  return `${SECTION}

What a frame does, counted on the fake device by \`createWorkMeter\` (\`@thunderclap-engine/engine/testing\`), averaged per frame over the measured frames after a warm-up. Written by \`TC_BUDGET=write pnpm vitest run src/render/baseline.budget.test.ts\` from \`src/render/baseline.budget.json\`; that test fails any scene that does more of any counter than its row, and fails if this section and the JSON disagree. \`pnpm bench\` keeps this section. Today's numbers (engine 1.3) are the guard the render core must beat or explain (E-041, D2 R2).

- Rows are the bench rungs above (the same seeded scenes on the fake device; timings are the browser's, these are counts), \`2d-tiles\` (harness/tiles.html's grid: a 32×18 tile layer and a flipbook walker), \`2d-game\` (\`createGame\` with one empty scene, its default post chain) and \`distinct-*\` (design/2.0/bar.md D2-P1: that many distinct meshes, nothing batches, the camera turning; \`2views\` renders an eye each with \`renderer.render\`).
- \`Commands\` is every call on the device, queue, encoders and passes; \`Draws\` is \`draw\` + \`drawIndexed\`; \`Passes\` render + compute; \`Writes\` \`writeBuffer\` + \`writeTexture\`; \`Creates\` every \`create*\` call on the device during the frame (buffers, textures, bind groups, pipelines, command encoders: today's 1 is the frame's encoder); \`Typed arrays\` typed arrays, \`ArrayBuffer\`s made by the frame's code (not the device); \`Clock reads\` \`performance.now\` + \`Date.now\`. A fraction is a count that varies frame to frame (the turning camera sees a different set), averaged.
- \`↳ view\` rows split a frame by \`meter.view(name)\`; \`present\` is \`endFrame\`.
- Since ws/core-immediate (engine 2.0) the \`distinct-*\` rows draw their meshes as one merged run on a device with \`indirect-first-instance\` (as \`initGpu\` asks for): one cached bundle of \`drawIndexedIndirect\` per view, so the calls are flat in what is visible (1.5k: 1,418 → 19.2; 6k: 5,775 → 33.1; two views: 2,832 → 30.2). What rises: one \`writeBuffer\` per view (the run's 20-byte indirect arguments, hence the bytes), and \`copies\` (not in the table: about 4 a frame at 1.5k, 18 at 6k), the pool's one-time copy of each mesh the turning camera sees for the first time; the difference between the 1.5k and 6k rows is those copies only.

${table}

Trace goldens (every call in order, hashed; the 2D path must not change under the render core):

${goldens}
`;
}

afterAll(() => {
  if (!WRITE) return;
  // Laid out as biome formats it: number pairs on one line, a short list of them too.
  const json = JSON.stringify(got, null, 2)
    .replace(/\[\s+(\d+),\s+(\d+)\s+\]/g, '[$1, $2]')
    .replace(
      /\[\s+(\[\d+, \d+\](?:,\s+\[\d+, \d+\])*)\s+\]/g,
      (_m, pairs: string) =>
        `[${pairs.replace(/,\s+/g, (sep) => (sep.includes('\n') ? ', ' : sep))}]`,
    );
  writeFileSync(BASELINE_URL, `${json}\n`);
  const doc = readFileSync(BENCH_DOC_URL, 'utf8');
  const at = doc.indexOf(`\n${SECTION}\n`);
  const before = at < 0 ? `${doc.trimEnd()}\n` : doc.slice(0, at + 1);
  writeFileSync(BENCH_DOC_URL, `${before}\n${benchSection(got)}`);
});

describe('counted work, 1.3 baseline: docs/BENCH.md', () => {
  it.skipIf(WRITE)('carries this baseline', () => {
    const doc = readFileSync(BENCH_DOC_URL, 'utf8');
    const at = doc.indexOf(`\n${SECTION}\n`);
    expect(at, `docs/BENCH.md has no "${SECTION}"; run with TC_BUDGET=write`).toBeGreaterThan(0);
    expect(doc.slice(at + 1)).toBe(benchSection(kept));
  });
});

/** A renderer on a counted fake device, `width × height` backbuffer. */
function counted(width = 1280, height = 720, trace = false, features: string[] = []) {
  const fake = createFakeDevice({}, features);
  const meter = createWorkMeter(fake.device, { trace });
  const renderer = new Renderer({
    device: meter.device,
    context: fakeCanvasContext(fake),
    format: 'bgra8unorm',
  });
  renderer.resize(width, height);
  return { fake, meter, renderer };
}

function noErrors(fake: FakeDevice): void {
  expect(fake.errors).toEqual([]);
}

// ------------------------------------------------------------------------------------ the bench

/** harness/bench.ts's scene constants. */
const LOGICAL = { width: 1920, height: 1080 };
const DT = 1 / 60;
const FIELD = { x: 120, y: 14, z: 120 };
const CUBE_SCALE = 0.8;
const MAX_INSTANCES = 100_000;
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

type Kind = 'instances' | 'lights' | 'shadow' | 'sprites' | 'particles';
type Mode = 'mesh' | 'batch' | 'list';
interface Rung {
  id: string;
  kind: Kind;
  count: number;
  mode: Mode;
  cull: boolean;
  points: number;
  shadow: boolean;
}
const rung = (id: string, kind: Kind, count: number, o: Partial<Rung> = {}): Rung => ({
  id,
  kind,
  count,
  mode: o.mode ?? 'mesh',
  cull: o.cull ?? true,
  points: o.points ?? 0,
  shadow: o.shadow ?? false,
});

/** harness/bench-state.ts's `BENCH_LADDER`. */
const LADDER: Rung[] = [
  rung('instances-1k-cull', 'instances', 1_000),
  rung('instances-1k', 'instances', 1_000, { cull: false }),
  rung('instances-10k-cull', 'instances', 10_000),
  rung('instances-10k', 'instances', 10_000, { cull: false }),
  rung('instances-50k-cull', 'instances', 50_000),
  rung('instances-50k', 'instances', 50_000, { cull: false }),
  rung('batch-10k-cull', 'instances', 10_000, { mode: 'batch' }),
  rung('batch-10k', 'instances', 10_000, { mode: 'batch', cull: false }),
  rung('batch-50k-cull', 'instances', 50_000, { mode: 'batch' }),
  rung('batch-50k', 'instances', 50_000, { mode: 'batch', cull: false }),
  rung('list-10k', 'instances', 10_000, { mode: 'list', cull: false }),
  rung('list-50k', 'instances', 50_000, { mode: 'list', cull: false }),
  rung('lights-0', 'lights', 10_000, { points: 0 }),
  rung('lights-8', 'lights', 10_000, { points: 8 }),
  rung('lights-16', 'lights', 10_000, { points: 16 }),
  rung('shadow-off', 'shadow', 10_000, { shadow: false }),
  rung('shadow-on', 'shadow', 10_000, { shadow: true }),
  rung('sprites-10k', 'sprites', 10_000),
  rung('sprites-50k', 'sprites', 50_000),
  rung('particles-10k', 'particles', 10_000),
  rung('particles-100k', 'particles', 100_000),
];

/** A unit cube: 24 vertices of 12 floats, 36 indices (the bench's geometry, by size). */
function cube(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  const faces = [
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, -1, -1, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 0, -1, 0, 1, 0],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, -1],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
  ];
  let v = 0;
  faces.forEach((f, fi) => {
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (f[k]! + sx * f[3 + k]! + sy * f[6 + k]!) * 0.5;
      vertices.set([f[0]!, f[1]!, f[2]!, (sx + 1) / 2, (1 - sy) / 2, 1, 1, 1, 1], v + 3);
      v += 12;
    }
    const b = fi * 4;
    indices.set([b, b + 1, b + 2, b, b + 2, b + 3], fi * 6);
  });
  return { vertices, indices };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The bench page's scene on a counted renderer: `frame(rung)` is its `step`. */
function benchScene() {
  const { fake, meter, renderer } = counted();
  const camera3d = Camera.perspective(
    (50 * Math.PI) / 180,
    LOGICAL.width / LOGICAL.height,
    0.1,
    500,
  );
  Object.assign(camera3d.screen, { x: 0, y: 0, ...LOGICAL });
  camera3d.lookAt([0, 18, 60], [0, 2, -20]);
  const camera2d = Camera.ortho2d(LOGICAL.width, LOGICAL.height);
  const lit = renderer.createMaterial({ label: 'bench-lit', blend: 'opaque', wgsl: LIT_WGSL });
  const mesh = renderer.createMesh({ ...cube(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const rand = lcg(0x5eed);
  const transforms: Transform[] = [];
  for (let i = 0; i < MAX_INSTANCES; i++) {
    transforms.push(
      new Transform({
        x: (rand() - 0.5) * FIELD.x,
        y: rand() * FIELD.y,
        z: (rand() - 0.5) * FIELD.z,
        scaleX: CUBE_SCALE,
        scaleY: CUBE_SCALE,
        scaleZ: CUBE_SCALE,
      }).setAxisAngle(0, 1, 0, rand() * Math.PI),
    );
  }
  const cubeP: InstanceParams = { tint: [0.75, 0.8, 0.9, 1] };
  const matrices = new Float32Array(MAX_INSTANCES * 12);
  const params = new Float32Array(MAX_INSTANCES * INSTANCE_PARAM_FLOATS);
  for (let i = 0; i < MAX_INSTANCES; i++) {
    matrices.set(transforms[i]!.world, i * 12);
    writeInstanceParams(params, i * INSTANCE_PARAM_FLOATS, cubeP, CUBE_SCALE, CUBE_SCALE);
  }
  const batch = { count: 0, matrices, params };
  const list = renderer.createInstanceList(mesh, lit, MAX_INSTANCES);
  const sprites: DrawParams[] = [];
  for (let i = 0; i < MAX_INSTANCES; i++) {
    sprites.push({
      x: rand() * LOGICAL.width,
      y: rand() * LOGICAL.height,
      w: 24,
      h: 24,
      tint: [0.3 + 0.7 * rand(), 0.3 + 0.7 * rand(), 0.3 + 0.7 * rand(), 1],
    });
  }
  const lights = new Lights();
  lights.ambient.set([0.18, 0.18, 0.2]);
  lights.sun.direction = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];
  const lamps: PointLight[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    lamps.push({
      position: new Float32Array([Math.cos(a) * 30, 4, Math.sin(a) * 30]),
      color: [1.6, 0.9, 0.4],
      radius: 14,
    });
  }
  const emitParams = {
    x: 0,
    y: 8,
    z: -20,
    shape: { kind: 'box', width: 80, height: 14, depth: 80 } as const,
    speed: [0.05, 0.1] as const,
    life: [1e4, 1e4] as const,
    size: [0.25, 0.25] as const,
    gravity: [0, 0, 0] as const,
    drag: 0,
    colorStart: [1.2, 0.9, 0.5, 1] as const,
  };
  let frames = 0;
  let system: ParticleSystem | null = null;

  const start = (r: Rung): void => {
    renderer.camera = r.kind === 'sprites' ? camera2d : camera3d;
    camera3d.cull = r.cull;
    lights.points.length = 0;
    for (let i = 0; i < r.points; i++) lights.points.push(lamps[i]!);
    lights.sun.shadow = r.shadow ? { extent: 40, size: 2048 } : null;
    system = null;
    if (r.kind === 'particles') {
      system = new ParticleSystem(renderer, { space: 'world', capacity: r.count, stretch: 0 });
      system.emit(emitParams, r.count);
    } else if (r.mode === 'batch') batch.count = r.count;
    else if (r.mode === 'list') {
      list.clear();
      for (let i = 0; i < r.count; i++) list.set(i, transforms[i]!, cubeP);
    }
  };
  const step = (r: Rung): void => {
    const frame = renderer.beginFrame(frames++ * DT, DT);
    frame.clear(0.05, 0.07, 0.12);
    frame.lights = lights;
    if (r.kind === 'sprites') {
      for (let i = 0; i < r.count; i++) frame.sprite(null, sprites[i]!);
    } else if (r.kind === 'particles') {
      system!.update(DT);
      frame.drawable(system!);
    } else if (r.mode === 'batch') frame.meshes(mesh, lit, batch);
    else if (r.mode === 'list') frame.list(list);
    else for (let i = 0; i < r.count; i++) frame.mesh(mesh, lit, transforms[i]!, cubeP);
    renderer.endFrame();
  };
  return { fake, meter, renderer, start, step };
}

describe('counted work, 1.3 baseline: the bench rungs', () => {
  it('this file mirrors harness/bench-state.ts', () => {
    const src = readFileSync(new URL('../../harness/bench-state.ts', import.meta.url), 'utf8');
    const ladder = src.slice(src.indexOf('BENCH_LADDER'), src.indexOf('BENCH_TINY:'));
    const ids = [...ladder.matchAll(/rung\('([^']+)'/g)].map((m) => m[1]);
    expect(ids).toEqual(LADDER.map((r) => r.id));
  });

  const scene = benchScene();
  for (const r of LADDER) {
    it(`${r.id}: at or under its baseline`, () => {
      scene.start(r);
      const report = scene.meter.run(() => scene.step(r), { frames: 20, warmup: 10 });
      hold(r.id, report);
      expect(new Set(report.commandsPerFrame).size, `${r.id}: the same calls every frame`).toBe(1);
      noErrors(scene.fake);
    });
  }

  it('sprites-10k: its frame keeps its calls (trace golden)', () => {
    const { fake, meter, renderer } = counted(1280, 720, true);
    renderer.camera = Camera.ortho2d(LOGICAL.width, LOGICAL.height);
    const rand = lcg(7);
    const sprites: DrawParams[] = [];
    for (let i = 0; i < 10_000; i++) {
      sprites.push({ x: rand() * 1920, y: rand() * 1080, w: 24, h: 24, tint: [1, rand(), 1, 1] });
    }
    let n = 0;
    const report = meter.run(
      () => {
        const frame = renderer.beginFrame(n++ * DT, DT);
        frame.clear(0, 0, 0);
        for (const s of sprites) frame.sprite(null, s);
        renderer.endFrame();
      },
      { frames: 10, warmup: 5 },
    );
    holdGolden('sprites-10k', report);
    noErrors(fake);
  });
});

// ------------------------------------------------------------------------------------ 2D scenes

describe('counted work, 1.3 baseline: 2D harness scenes', () => {
  it('tiles: a 32×18 tile layer and a flipbook walker (harness/tiles.html)', () => {
    const { fake, meter, renderer } = counted(1280, 720, true);
    const GRID = { columns: 32, rows: 18, tileW: 60, tileH: 60 };
    const ATLAS = { cols: 2, rows: 2 };
    const texture = renderer.textureFromPixels({
      width: 32,
      height: 32,
      data: new Uint8Array(new ArrayBuffer(32 * 32 * 4)).fill(200),
      format: 'rgba8unorm-srgb',
      label: 'tiles-atlas',
    });
    const material = renderer.createSpriteMaterial({
      texture,
      label: 'tiles',
      sampler: 'nearest-clamp',
    });
    const layer = createTileLayer(renderer, { material, ...GRID, atlas: ATLAS, label: 'tiles' });
    const checker = new Int16Array(GRID.columns * GRID.rows);
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.columns; c++) checker[r * GRID.columns + c] = (c + r) % 2;
    }
    layer.fill(checker);
    const book = createFlipbook({ frames: atlasFrames(ATLAS, [2, 3, 2, 1]), fps: 8 });
    const sprite: DrawParams = { x: 0, y: 12.5 * 60, w: 60, h: 60, uv: book.uv, order: 1 };
    let walk = 0;
    let n = 0;
    const report = meter.run(
      () => {
        walk = (walk + DT * 240) % 1920;
        book.update(DT);
        const frame = renderer.beginFrame(n++ * DT, DT);
        frame.clear(0, 0, 0);
        layer.draw(frame);
        sprite.x = walk;
        sprite.uv = book.uv;
        frame.sprite(material, sprite);
        renderer.endFrame();
      },
      { frames: 30, warmup: 10 },
    );
    hold('2d-tiles', report);
    holdGolden('2d-tiles', report);
    noErrors(fake);
  });

  it('game: createGame with one empty scene (harness/game.html)', async () => {
    const fake = createFakeDevice();
    const meter = createWorkMeter(fake.device, { trace: true });
    const device = Object.create(fake, { device: { value: meter.device } }) as FakeDevice;
    const g = await createTestGame({ overlay: false, device, input: { bindings: {} } });
    g.ctx.stack.push({});
    const report = meter.run(() => g.step(1), { frames: 30, warmup: 10 });
    hold('2d-game', report);
    holdGolden('2d-game', report);
    noErrors(fake);
  });
});

// ------------------------------------------------------------------------------------ D2-P1

/**
 * D2-P1's scene (design/2.0/bar.md §4): `held` distinct meshes (one `Mesh` each, so nothing
 * batches) over a field, the camera turning, through `frame.mesh`. One view, or two (an eye
 * each, `renderer.render` per view as the XR path does today). Today the work grows with what is
 * visible and doubles for two views; the render core must make it flat (G3).
 */
function distinct(held: number, views: 1 | 2): { report: WorkReport; meter: WorkMeter } {
  // The draw features browsers offer and `initGpu` asks for (ws/core-immediate): runs bundle.
  const { fake, meter, renderer } = counted(2360, 1640, false, ['indirect-first-instance']);
  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const geo = cube();
  const rand = lcg(42);
  const meshes: ReturnType<Renderer['createMesh']>[] = [];
  const transforms: Transform[] = [];
  const side = Math.ceil(Math.sqrt(held));
  for (let i = 0; i < held; i++) {
    meshes.push(renderer.createMesh({ ...geo, layout: VERTEX_LAYOUT_3D, label: `m${i}` }));
    transforms.push(
      new Transform({
        x: ((i % side) - side / 2) * 3,
        y: rand() * 4,
        z: (Math.floor(i / side) - side / 2) * 3,
      }),
    );
  }
  const p: InstanceParams = { tint: [0.8, 0.8, 0.8, 1] };
  const eyes = [0, 1].map(() => {
    const c = Camera.perspective(1.2, 2360 / 1640, 0.1, 400);
    c.cull = true;
    if (views === 2) c.screen.width = 0.5;
    return c;
  });
  eyes[1]!.screen.x = 0.5;
  let yaw = 0;
  let n = 0;
  const report = meter.run(
    () => {
      yaw += 0.01;
      const tx = Math.sin(yaw) * 50;
      const tz = Math.cos(yaw) * 50;
      eyes[0]!.lookAt([0, 12, 0], [tx, 0, tz]);
      eyes[1]!.lookAt([0.064, 12, 0], [tx + 0.064, 0, tz]);
      const frame = renderer.beginFrame(n++ * DT, DT);
      frame.clear(0, 0, 0);
      for (let i = 0; i < held; i++) frame.mesh(meshes[i]!, lit, transforms[i]!, p);
      if (views === 1) {
        meter.view('view');
        renderer.render(frame, eyes[0]!);
      } else {
        meter.view('left');
        renderer.render(frame, eyes[0]!);
        meter.view('right');
        renderer.render(frame, eyes[1]!);
      }
      meter.view('present');
      renderer.endFrame();
    },
    { frames: 60, warmup: 10 },
  );
  noErrors(fake);
  return { report, meter };
}

describe('counted work, 1.3 baseline: distinct meshes (D2-P1)', () => {
  it('1,500 and 6,000 held, one view: at or under baseline, flat in what is visible', () => {
    const small = distinct(1500, 1).report;
    const large = distinct(6000, 1).report;
    hold('distinct-1.5k', small);
    hold('distinct-6k', large);
    holdView('distinct-1.5k', 'view', small);
    // ws/core-immediate: the distinct meshes draw as one merged run (one bundle of indirect
    // draws), so the calls no longer grow with what is visible. Only the pool's one-time copies
    // of meshes the turning camera sees for the first time do.
    expect(large.gpu.drawIndexed).toBe(0);
    expect(large.gpu.executeBundles).toBe(small.gpu.executeBundles);
    expect(large.gpu.commands - large.gpu.copies).toBe(small.gpu.commands - small.gpu.copies);
  });

  it('1,500 held, two views: per-view splits at or under baseline', () => {
    const { report } = distinct(1500, 2);
    hold('distinct-1.5k-2views', report);
    holdView('distinct-1.5k-2views', 'left', report);
    holdView('distinct-1.5k-2views', 'right', report);
    holdView('distinct-1.5k-2views', 'present', report);
  });
});
