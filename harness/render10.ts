/**
 * Render 10 page (ws/render-10): every fx drawable that builds its own scene-pass pipeline,
 * drawn through `createGame({ aux })` with the scene target's aux attachments on. Before
 * render-10 those pipelines declared the two `renderer.sceneFormats` targets while the scene
 * pass had three or four, a GPU validation error every frame; now they take their targets from
 * `renderer.sceneTargets` and the page reports `gpuErrors: 0`. Noun-free.
 *
 * - The scene: a `Sky`, a lit floor and two blocks, a `Water` pool and box `Decals` reading
 *   this frame's depth (so the renderer splits the pass: `scene` and `scene-blend`), a world
 *   `ParticleSystem` (soft, alpha) and a 2D one, `Billboards` (depth-tested and `always`) and a
 *   `DebugDraw` grid.
 * - `?aux=velocity` (default) the velocity target, `?aux=all` rough-metal and velocity,
 *   `?aux=none` neither (the control).
 * - State on `window.__harnessRender10` (harness/render10-state.ts).
 */
import { createGame } from '@thunderclap/engine';
import {
  createBillboards,
  createDebugDraw,
  Decals,
  ParticleSystem,
  Sky,
  Water,
} from '@thunderclap/engine/fx';
import { box } from '@thunderclap/engine/geom';
import {
  gpuDiagnostics,
  type InstanceParams,
  Lights,
  type SceneTargetAux,
  Transform,
} from '@thunderclap/engine/render';
import type { HarnessRender10State, Render10Aux } from './render10-state';

const root = document.getElementById('root') as HTMLElement;
const query = new URLSearchParams(location.search);
const AUX: Render10Aux = ((): Render10Aux => {
  const a = query.get('aux');
  return a === 'all' || a === 'none' ? a : 'velocity';
})();
const AUX_SET: Record<Render10Aux, SceneTargetAux> = {
  velocity: { velocity: true },
  all: { roughMetal: true, velocity: true },
  none: {},
};
const LOGICAL = { width: 1280, height: 720 };
const EYE: [number, number, number] = [0, 5, 13];
const TARGET: [number, number, number] = [0, 0, 0];

const state: HarnessRender10State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  aux: AUX,
  auxKey: 0,
  sceneTargets: 0,
  drawCalls: 0,
  drawables: 0,
  particles: 0,
  gpuErrors: 0,
};
window.__harnessRender10 = { state };

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.1), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

async function main(): Promise<void> {
  const ctx = await createGame({
    root,
    title: 'Engine render 10 demo',
    design: LOGICAL,
    input: { bindings: {} },
    aux: AUX_SET[AUX],
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const { renderer, camera } = ctx;
  camera.setPerspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  camera.lookAt(EYE, TARGET);
  camera.depthTest = true;
  camera.depthWrite = true;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const floor = renderer.createMesh(box({ size: [30, 0.5, 30] }));
  const block = renderer.createMesh(box({ size: [1.5, 1.5, 1.5] }));
  const floorT = new Transform({ y: -1.25 });
  const floorP: InstanceParams = { tint: [0.4, 0.42, 0.38, 1] };
  const blocks = [
    { t: new Transform({ x: -4, y: -0.25, z: -1 }), p: { tint: [0.8, 0.4, 0.3, 1] } },
    { t: new Transform({ x: 4, y: -0.25, z: -1 }), p: { tint: [0.3, 0.5, 0.8, 1] } },
  ] satisfies { t: Transform; p: InstanceParams }[];

  const lights = new Lights();
  lights.ambient.set([0.25, 0.26, 0.3]);
  lights.sun.dir = [-0.4, -1.0, -0.5];
  lights.sun.color = [0.9, 0.88, 0.8];

  const sky = new Sky(renderer);
  const water = new Water(renderer, { size: 6, segments: 24, readsDepth: true });
  const decals = new Decals(renderer, {
    texture: renderer.textureFromSource(decalCanvas(), 'render10-decal'),
  });
  decals.add({ x: -4, y: -1, z: 3, nx: 0, ny: 1, nz: 0, size: 2, color: [1, 0.9, 0.2, 1] });
  decals.add({ x: 4, y: -0.25, z: -0.25, nx: 0, ny: 0, nz: 1, size: 1.2 });
  const world = new ParticleSystem(renderer, {
    space: 'world',
    capacity: 2048,
    blend: 'alpha',
    softness: 0.3,
    countAlive: true,
  });
  const flat = new ParticleSystem(renderer, { capacity: 256 });
  const billboards = createBillboards(renderer, { capacity: 4 });
  billboards.add({ position: [-4, 1.2, -1], size: [1.2, 0.3], color: [0.2, 1, 0.4, 1] });
  billboards.add({ position: [4, 1.2, -1], size: [1.2, 0.3], depth: 'always' });
  const debug = createDebugDraw(renderer, { retain: true });
  for (let i = -5; i <= 5; i++) {
    debug.line([i * 2, -0.99, -10], [i * 2, -0.99, 10], [0.2, 0.2, 0.2, 1]);
    debug.line([-10, -0.99, i * 2], [10, -0.99, i * 2], [0.2, 0.2, 0.2, 1]);
  }

  ctx.stack.push({
    update(dt) {
      world.emit(
        {
          x: 0,
          y: 2,
          z: 4,
          angle: Math.PI / 2,
          spread: 0.8,
          speed: [1, 2.5],
          life: [1, 2],
          size: [0.15, 0.25],
          colorStart: [1, 0.6, 0.2, 0.9],
          colorEnd: [1, 0.2, 0.1, 0],
          gravity: [0, -1.5, 0],
        },
        8,
      );
      flat.emit(
        {
          x: 120,
          y: 120,
          speed: [40, 90],
          spread: Math.PI,
          life: [0.6, 1],
          size: [6, 10],
          colorStart: [0.6, 0.8, 1, 1],
        },
        4,
      );
      world.update(dt);
      flat.update(dt);
      water.update(dt);
      decals.update(dt);
      billboards.update(dt, camera);
    },
    render(frame) {
      frame.clear(0, 0, 0);
      frame.lights = lights;
      frame.drawable(sky, -1);
      frame.mesh(floor, lit, floorT, floorP);
      for (const b of blocks) frame.mesh(block, lit, b.t, b.p);
      frame.drawable(debug);
      frame.drawable(decals, 1);
      frame.drawable(water, 2);
      frame.drawable(world, 3);
      frame.drawable(flat, 4);
      frame.drawable(billboards, 10);
    },
  });
  ctx.hooks.afterRender = () => {
    state.frames++;
    state.drawCalls = renderer.stats.drawCalls;
    state.drawables = renderer.stats.drawables;
    state.particles = world.alive;
    state.gpuErrors = gpuDiagnostics.errorCount;
  };
  state.auxKey = renderer.target.auxKey;
  state.sceneTargets = renderer.sceneTargets().length;
  ctx.loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

/** A 64 px ring for the decals. */
function decalCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  g.lineWidth = 8;
  g.beginPath();
  g.arc(32, 32, 24, 0, Math.PI * 2);
  g.stroke();
  return c;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
