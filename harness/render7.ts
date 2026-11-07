/**
 * Render 7 page (ws/render-7): stable LOD keys and per-instance velocity on one `InstanceList`
 * over a `MeshLod`, on the raw renderer, one mode per flag. Every frame the page churns the
 * list: it swap-removes one rock and appends it again, so rocks change slots without moving.
 *
 * - `?lod-keys` (the default): 16 rocks on an arc around the camera, at one distance just
 *   inside the hysteresis band below the first threshold. They arrive there from alternate
 *   sides (even rocks near, odd rocks far, on the first frame), so even rocks hold level 0 and
 *   odd rocks settle at level 1. Each rock keeps its id as its `setKey` key, so the level
 *   follows the rock through the churn: `state.levelChanges` (per rock, from
 *   `renderer.lodLevelOf`) stays 0. `&unkeyed` drops the keys: levels follow the slots and
 *   the churn hands rocks each other's levels.
 * - `?instanced-velocity`: the renderer draws into a velocity target. Two rows of 8 rocks at
 *   two distances (two LOD levels), the top row sliding sideways and the bottom row standing,
 *   in one keyed list with `velocity: true` under the standard material. A probe after the
 *   post stack reads the velocity at every rock's centre: `state.velocityMoving` and
 *   `state.velocityStatic`. With `&unkeyed` the churn hands static rocks a moved rock's
 *   history, and they write velocity.
 * - `?single-velocity` (ws/render-8): one sliding rock drawn by `frame.mesh` with its own
 *   `Transform` (no list, no churn) under a still camera, into the velocity target. Probes on
 *   the rock (`state.velocityMoving`) and on the background (`state.velocityStatic`): the
 *   rock writes its own motion from its Transform's previous world matrix, the background 0.
 * - `?still`: park the sliding rocks (the churn goes on), or the single rock, so every probe
 *   reads zero.
 */

import { GameLoop } from '@thunderclap/engine/core';
import { createLodChain, icosphere } from '@thunderclap/engine/geom';
import { boot } from '@thunderclap/engine/platform';
import { PostStack } from '@thunderclap/engine/post';
import {
  Camera,
  type CameraPoint,
  createStandardMaterial,
  type FullscreenPass,
  gpuDiagnostics,
  type InstanceList,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  lodSizePx,
  type MeshLod,
  type PostInputs,
  type PostProcessor,
  Renderer,
  type SceneTargetViewport,
  type Texture,
  Transform,
} from '@thunderclap/engine/render';
import type { HarnessRender7Api, HarnessRender7State, Render7Mode } from './render7-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const query = new URLSearchParams(location.search);
const mode: Render7Mode = query.has('instanced-velocity')
  ? 'instanced-velocity'
  : query.has('single-velocity')
    ? 'single-velocity'
    : 'lod-keys';
const single = mode === 'single-velocity';
const still = query.has('still');
const keyed = !query.has('unkeyed');

const state: HarnessRender7State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  mode,
  still,
  keyed,
  instances: 0,
  drawCalls: 0,
  lodCounts: [],
  churns: 0,
  levelChanges: 0,
  velocityMoving: 0,
  velocityStatic: 0,
  velocityStaticPeak: 0,
  readbacks: 0,
  window: { x: 0, y: 0, width: 0, height: 0 },
  logical: { ...LOGICAL },
  gpuErrors: 0,
};

/** Running sums behind the velocity means since the last reset. */
let movingSum = 0;
let staticSum = 0;

const api: HarnessRender7Api = {
  state,
  reset() {
    state.levelChanges = 0;
    state.velocityMoving = 0;
    state.velocityStatic = 0;
    state.velocityStaticPeak = 0;
    state.readbacks = 0;
    movingSum = 0;
    staticSum = 0;
    return state.frames;
  },
};
window.__harnessRender7 = api;

// ------------------------------------------------------------------ the velocity probe

/** Probes: one texel per rock, the moving row first. */
const ROW = 8;
const PROBES = ROW * 2;
const PROBE_ROW_BYTES = 256;
const PROBE_WGSL = /* wgsl */ `
struct Probe { uv: array<vec4f, ${PROBES / 2}> };
@group(0) @binding(0) var<uniform> probe: Probe;
@group(0) @binding(1) var probe_sampler: sampler;
@group(0) @binding(2) var velocity_tex: texture_2d<f32>;
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let px = u32(in.pos.x);
  let q = probe.uv[px / 2u];
  let uv = select(q.xy, q.zw, (px & 1u) == 1u);
  return textureSampleLevel(velocity_tex, probe_sampler, uv, 0.0);
}`;

/** IEEE half → number. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

/**
 * Wraps the post stack: after it runs, a fullscreen pass samples the velocity input at
 * `PROBES` uvs into a row of `rgba16float` texels copied into a mappable buffer (`read()`
 * maps it after the submit).
 */
class VelocityProbe implements PostProcessor {
  /** The probe uvs (set per frame by the page). */
  readonly uv = new Float32Array(PROBES * 2);
  /** |velocity| per probe of the last readback. */
  readonly speed = new Float32Array(PROBES);
  private readonly pass: FullscreenPass;
  private readonly target: Texture;
  private readonly buffer: GPUBuffer;
  private mapping = false;
  private copied = false;
  private readonly raw = new Uint16Array(PROBES * 4);

  constructor(
    private readonly renderer: Renderer,
    private readonly inner: PostStack,
  ) {
    this.pass = renderer.createFullscreenPass({
      label: 'render7-probe',
      wgsl: PROBE_WGSL,
      targets: ['rgba16float'],
      uniformBytes: PROBES * 8,
      textures: 1,
      sampler: 'nearest-clamp',
    });
    this.target = renderer.createRenderTarget({
      width: PROBES,
      height: 1,
      format: 'rgba16float',
      label: 'render7-probe',
    });
    this.buffer = renderer.device.createBuffer({
      label: 'render7-probe-readback',
      size: PROBE_ROW_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  resize(width: number, height: number): void {
    this.inner.resize(width, height);
  }

  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void {
    this.inner.encode(encoder, inputs, output, viewport);
    if (this.mapping || !inputs.velocity) return;
    this.pass.setUniforms(this.uv);
    this.pass.setTexture(0, inputs.velocity);
    this.pass.encode(encoder, this.target.view);
    encoder.copyTextureToBuffer(
      { texture: this.target.texture },
      { buffer: this.buffer, bytesPerRow: PROBE_ROW_BYTES },
      { width: PROBES, height: 1 },
    );
    this.copied = true;
  }

  /** After the frame's submit: map the readback when one was encoded; `done` on arrival. */
  read(done: () => void): void {
    if (!this.copied || this.mapping) return;
    this.copied = false;
    this.mapping = true;
    this.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        this.raw.set(new Uint16Array(this.buffer.getMappedRange(0, PROBES * 8)));
        this.buffer.unmap();
        for (let i = 0; i < PROBES; i++) {
          const x = halfToFloat(this.raw[i * 4]!);
          const y = halfToFloat(this.raw[i * 4 + 1]!);
          this.speed[i] = Math.hypot(x, y);
        }
        this.mapping = false;
        done();
      },
      () => {
        this.mapping = false;
      },
    );
  }

  get device(): GPUDevice {
    return this.renderer.device;
  }
}

// ------------------------------------------------------------------ the scene

/** `?lod-keys`: the arc's radius, its half-angle and the rock count. */
const PARK = 30;
const ARC = (32 * Math.PI) / 180;
const ARC_ROCKS = 16;
/** `?instanced-velocity`: the two rows' distances, the slide's amplitude and rate per frame. */
const NEAR = 9;
const FAR = 18;
const SLIDE = 0.9;
const SLIDE_RATE = 0.09;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

/** Grow `state.window` around a world sphere's screen footprint (logical px). */
function frameRock(camera: Camera, x: number, y: number, z: number, r: number, first: boolean) {
  camera.worldToScreen(x, y, z, probePoint);
  const d = Math.hypot(x - camera.position[0]!, y - camera.position[1]!, z - camera.position[2]!);
  const px = (r / d) * camera.projection[5]! * 0.5 * LOGICAL.height;
  const w = state.window;
  const x0 = Math.max(0, probePoint.x - px);
  const y0 = Math.max(0, probePoint.y - px);
  const x1 = Math.min(LOGICAL.width, probePoint.x + px);
  const y1 = Math.min(LOGICAL.height, probePoint.y + px);
  if (first) {
    w.x = x0;
    w.y = y0;
    w.width = x1 - x0;
    w.height = y1 - y0;
    return;
  }
  const rx = Math.max(w.x + w.width, x1);
  const ry = Math.max(w.y + w.height, y1);
  w.x = Math.min(w.x, x0);
  w.y = Math.min(w.y, y0);
  w.width = rx - w.x;
  w.height = ry - w.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine render 7 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const velocity = mode !== 'lod-keys';
  const renderer = new Renderer(gpu, velocity ? { aux: { velocity: true } } : {});
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 400);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  camera.lookAt([0, 0, 0], [0, 0, -1]);

  const probe = velocity
    ? new VelocityProbe(renderer, new PostStack(renderer, { bloom: { enabled: false } }))
    : null;
  if (probe) renderer.post = probe;

  const lights = new Lights();
  lights.ambient.set([0.3, 0.31, 0.35]);
  lights.sun.dir = [-0.4, -0.8, -0.5];
  lights.sun.color = [1.1, 1.05, 0.95];

  const chain = createLodChain(icosphere({ radius: 1, subdivisions: 3 }), [0.25, 0.06]);
  const thresholds = [0, 0];
  const lod: MeshLod = {
    meshes: chain.map((g, i) => renderer.createMesh({ ...g, label: `rock-lod${i}` })),
    thresholdsPx: thresholds,
  };
  const radius = lod.meshes[0]!.bounds.radius;
  const mat = createStandardMaterial(renderer, { label: 'rock', metallic: 0, roughness: 0.85 });

  const count = single ? 1 : velocity ? PROBES : ARC_ROCKS;
  const list: InstanceList = renderer.createInstanceList(lod, mat, count, { velocity });
  /** Each rock's transform and tint, by rock id; `slotRock[i]` is the rock in slot `i`. */
  const rocks: Transform[] = [];
  const params: InstanceParams[] = [];
  const slotRock = new Int32Array(count);
  const lastLevel = new Int8Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    rocks.push(new Transform().setAxisAngle(0, 1, 0, i * 0.7));
    const warm = velocity ? i < ROW : i % 2 === 0;
    params.push({ tint: warm ? [0.85, 0.55, 0.3, 1] : [0.35, 0.5, 0.8, 1] });
  }

  /** Where rock `id` stands on `frame`. */
  const place = (id: number, frame: number): void => {
    const t = rocks[id]!;
    if (!velocity) {
      // Frame 0: even rocks near (level 0), odd rocks far (level 2); then all on the arc.
      const a = -ARC + (2 * ARC * id) / (ARC_ROCKS - 1);
      const d = frame === 0 ? (id % 2 === 0 ? PARK * 0.5 : PARK * 5) : PARK;
      t.setPosition(d * Math.sin(a), 0, -d * Math.cos(a));
      return;
    }
    if (single) {
      // One rock sliding across the screen centre at the near distance.
      t.setPosition(still ? 0 : 2 * SLIDE * Math.sin(frame * SLIDE_RATE), 0, -NEAR);
      return;
    }
    const moving = id < ROW;
    const k = moving ? id : id - ROW;
    const z = k % 2 === 0 ? -NEAR : -FAR;
    const spread = k % 2 === 0 ? 1.15 : 2.3;
    const y = moving ? (k % 2 === 0 ? 1.1 : 2.2) : k % 2 === 0 ? -1.1 : -2.2;
    const slide = moving && !still ? SLIDE * Math.sin(frame * SLIDE_RATE + k * 0.8) : 0;
    t.setPosition((k - (ROW - 1) / 2) * spread + slide, y, z);
  };

  for (let i = 0; i < count; i++) {
    place(i, 0);
    list.set(i, rocks[i]!, params[i]!);
    if (keyed) list.setKey(i, i);
    slotRock[i] = i;
  }

  const sizeThresholds = (): void => {
    const h = renderer.target.height;
    if (velocity) {
      // Near row on level 0, far row on level 1.
      const near = lodSizePx(radius, NEAR, camera.projection, h);
      thresholds[0] = near * 0.7;
      thresholds[1] = near * 0.1;
      return;
    }
    // The arc sits 5% under the first threshold: inside the band, so level 0 holds there
    // while a rock coming from level 2 picks 1.
    const parked = lodSizePx(radius, PARK, camera.projection, h);
    thresholds[0] = parked / 0.95;
    thresholds[1] = parked * 0.3;
  };

  let churnAt = 0;
  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const f = state.frames;
      sizeThresholds();
      // The churn: one rock out of its slot and back in at the end. From frame 2 on in
      // `?lod-keys` (frame 0 sets the memory, frame 1 parks).
      if (!single && (velocity || f >= 2)) {
        const j = churnAt % count;
        churnAt += 7;
        const id = slotRock[j]!;
        const moved = list.remove(j);
        if (moved >= 0) slotRock[j] = slotRock[moved]!;
        const at = list.count;
        list.set(at, rocks[id]!, params[id]!);
        if (keyed) list.setKey(at, id);
        slotRock[at] = id;
        state.churns++;
      }
      if (single) {
        place(0, f);
      } else if (velocity || f <= 1) {
        for (let i = 0; i < count; i++) {
          const id = slotRock[i]!;
          place(id, f);
          list.set(i, rocks[id]!, params[id]!);
        }
      }
      if (probe && single) {
        // The rock's centre and points 0.4 radius around it; the background near the edges.
        const p = rocks[0]!.position;
        for (let i = 0; i < ROW; i++) {
          const a = (i * Math.PI * 2) / (ROW - 1);
          const k = i === 0 ? 0 : 0.4 * radius;
          camera.worldToScreen(p.x + k * Math.cos(a), p.y + k * Math.sin(a), p.z, probePoint);
          probe.uv[i * 2] = probePoint.x / LOGICAL.width;
          probe.uv[i * 2 + 1] = probePoint.y / LOGICAL.height;
        }
        for (let i = 0; i < ROW; i++) {
          const o = (ROW + i) * 2;
          probe.uv[o] = i < 4 ? 0.06 : 0.94;
          probe.uv[o + 1] = 0.08 + 0.28 * (i % 4);
        }
      } else if (probe) {
        for (let i = 0; i < count; i++) {
          const p = rocks[i]!.position;
          camera.worldToScreen(p.x, p.y, p.z, probePoint);
          probe.uv[i * 2] = probePoint.x / LOGICAL.width;
          probe.uv[i * 2 + 1] = probePoint.y / LOGICAL.height;
        }
      }

      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      if (single) frame.mesh(lod.meshes[0]!, mat, rocks[0]!, params[0]!);
      else frame.list(list);
      renderer.endFrame();

      if (!velocity && f >= 1) {
        for (let i = 0; i < count; i++) {
          const id = slotRock[i]!;
          const level = renderer.lodLevelOf(list, i);
          if (f >= 2 && level !== lastLevel[id]) state.levelChanges++;
          lastLevel[id] = level;
        }
      }
      probe?.read(() => {
        let moving = 0;
        let standing = 0;
        for (let i = 0; i < PROBES; i++) {
          const s = probe.speed[i]!;
          if (i < ROW) moving += s / ROW;
          else {
            standing += s / ROW;
            state.velocityStaticPeak = Math.max(state.velocityStaticPeak, s);
          }
        }
        state.readbacks++;
        movingSum += moving;
        staticSum += standing;
        state.velocityMoving = movingSum / state.readbacks;
        state.velocityStatic = staticSum / state.readbacks;
      });

      for (let i = 0; i < count; i++) {
        const p = rocks[i]!.position;
        frameRock(camera, p.x, p.y, p.z, radius, i === 0);
      }
      state.frames++;
      state.drawCalls = renderer.stats.drawCalls;
      state.instances = renderer.stats.instances;
      const lc = renderer.stats.lodCounts;
      if (state.lodCounts.length !== lc.length) state.lodCounts.length = lc.length;
      for (let i = 0; i < lc.length; i++) state.lodCounts[i] = lc[i]!;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  gpu.device.lost.then(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
