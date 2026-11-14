/**
 * Actors page (ws/actors): a crowd of `?n=N` actors (default 1000) from
 * `@thunderclap-engine/engine/actors`, half walking toy robots built from part models (a rigid
 * rig, two LODs), half skinned figures (a linear rig over a procedural skinned mesh), all under
 * one pose pass and one bundle of indirect draws. Every frame one actor turns about (one record
 * write), so a frame's GPU calls are the same at 100 actors as at 1,000.
 *
 * `check()` reads back the next frame's skin matrices and indirect counts and compares them
 * with `poseCpu`. Nothing here is engine code beyond the actors, the core and `boot`.
 */
import {
  type ActorClipDesc,
  createActorSystem,
  defineRig,
  ACTOR_RECORD as R,
} from '@thunderclap-engine/engine/actors';
import type { AnimationClip, Skeleton } from '@thunderclap-engine/engine/anim';
import type { MaterialCodeTable, PartModel } from '@thunderclap-engine/engine/models';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  createRenderCore,
  createRenderView,
  gpuDiagnostics,
  installGpuErrorLogging,
  SKIN_JOINTS_BYTE_OFFSET,
  setViewFromCamera,
  VERTEX_SKINNED_STRIDE,
} from '@thunderclap-engine/engine/render';
import type { HarnessActorsState } from './actors-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const n = Math.max(1, Math.min(4096, Number(params.get('n') ?? 1000) | 0));

const state: HarnessActorsState = {
  ready: false,
  gpu: 'pending',
  actors: n,
  frames: 0,
  gpuErrors: 0,
  calls: 0,
  maxCalls: 0,
  bundles: 0,
  bundleBuilds: 0,
  dispatched: 0,
  checks: 0,
  poseError: -1,
  checkedSlots: 0,
  drawnPerDraw: [],
  drawn: 0,
  cpuMs: 0,
};
let wantCheck = false;
window.__harnessActors = {
  state,
  check() {
    wantCheck = true;
  },
};

const MATS: MaterialCodeTable = {
  metal: { color: [0.62, 0.66, 0.72] },
  dark: { color: [0.22, 0.24, 0.28] },
  lamp: { color: [1, 0.85, 0.35] },
};

const box = (from: [number, number, number], to: [number, number, number]) =>
  ({ type: 'box', from, to }) as const;

/** The robot: a tinted body, a head with an eye, two arms and two legs. */
const ROBOT: PartModel = {
  name: 'robot',
  parts: [
    { name: 'body', color: 'instance', shape: box([-0.35, 0.75, -0.22], [0.35, 1.45, 0.22]) },
    {
      name: 'head',
      material: 'metal',
      shape: box([-0.22, 1.5, -0.2], [0.22, 1.85, 0.2]),
      parts: [{ material: 'lamp', shape: box([-0.12, 1.62, 0.2], [0.12, 1.72, 0.24]) }],
    },
    { name: 'armL', material: 'metal', shape: box([-0.52, 0.8, -0.08], [-0.38, 1.4, 0.08]) },
    { name: 'armR', material: 'metal', shape: box([0.38, 0.8, -0.08], [0.52, 1.4, 0.08]) },
    { name: 'legL', material: 'dark', shape: box([-0.26, 0, -0.1], [-0.06, 0.75, 0.1]) },
    { name: 'legR', material: 'dark', shape: box([0.06, 0, -0.1], [0.26, 0.75, 0.1]) },
  ],
};
/** The far robot: a body and two legs. */
const ROBOT_FAR: PartModel = {
  name: 'robot-far',
  parts: [
    { name: 'body', color: 'instance', shape: box([-0.4, 0.75, -0.22], [0.4, 1.85, 0.22]) },
    { name: 'legL', material: 'dark', shape: box([-0.26, 0, -0.1], [-0.06, 0.75, 0.1]) },
    { name: 'legR', material: 'dark', shape: box([0.06, 0, -0.1], [0.26, 0.75, 0.1]) },
  ],
};

const quatX = (a: number) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const quatZ = (a: number) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

/** Swing of each part index by `amp` (sign gives phase) about x, one stride per second. */
function walk(swings: [part: number, amp: number][]): ActorClipDesc {
  const times = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
  const clip: AnimationClip = {
    name: 'walk',
    duration: 1,
    channels: swings.map(([node, amp]) => ({
      node,
      path: 'rotation' as const,
      interpolation: 'LINEAR' as const,
      times,
      values: new Float32Array([
        ...quatX(0),
        ...quatX(amp),
        ...quatX(0),
        ...quatX(-amp),
        ...quatX(0),
      ]),
    })),
  };
  return { clip };
}

/** A skinned figure: a chain of four nodes up +y and rings of a tapered column blended between them. */
function figure(): {
  skeleton: Skeleton;
  vertices: ArrayBuffer;
  indices: Uint32Array;
  clip: AnimationClip;
} {
  const nodes = 4;
  const seg = 0.45;
  const rest = new Float32Array(nodes * 10);
  for (let i = 0; i < nodes; i++)
    rest.set([0, i === 0 ? 0.1 : seg, 0, 0, 0, 0, 1, 1, 1, 1], i * 10);
  const skeleton: Skeleton = { parents: new Int16Array([-1, 0, 1, 2]), rest };
  const rings = 13;
  const sides = 10;
  const height = 0.1 + seg * nodes;
  const vb = new ArrayBuffer(rings * sides * VERTEX_SKINNED_STRIDE);
  const f = new Float32Array(vb);
  const u8 = new Uint8Array(vb);
  for (let r = 0; r < rings; r++) {
    const y = (r / (rings - 1)) * height;
    const t = Math.min(Math.max((y - 0.1) / seg, 0), nodes - 1);
    const j0 = Math.min(Math.floor(t), nodes - 2);
    const w1 = Math.round(Math.min(t - j0, 1) * 255);
    const radius = 0.32 - 0.18 * (y / height) + (r === rings - 1 ? -0.1 : 0);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const i = r * sides + s;
      const o = (i * VERTEX_SKINNED_STRIDE) / 4;
      const shade = 0.75 + 0.25 * Math.cos(r * 0.9);
      f.set(
        [Math.cos(a) * radius, y, Math.sin(a) * radius, Math.cos(a), 0.2, Math.sin(a), 0, 0],
        o,
      );
      f.set([shade, shade, shade, 1], o + 8);
      u8.set(
        [j0, j0 + 1, 0, 0, 255 - w1, w1, 0, 0],
        i * VERTEX_SKINNED_STRIDE + SKIN_JOINTS_BYTE_OFFSET,
      );
    }
  }
  const idx: number[] = [];
  for (let r = 0; r + 1 < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s;
      const b = r * sides + ((s + 1) % sides);
      idx.push(a, a + sides, b, b, a + sides, b + sides);
    }
  }
  const times = new Float32Array([0, 0.3, 0.6, 0.9, 1.2]);
  const clip: AnimationClip = {
    name: 'sway',
    duration: 1.2,
    channels: [1, 2, 3].map((node) => ({
      node,
      path: 'rotation' as const,
      interpolation: 'LINEAR' as const,
      times,
      values: new Float32Array([
        ...quatZ(0),
        ...quatZ(0.35),
        ...quatZ(0),
        ...quatZ(-0.35),
        ...quatZ(0),
      ]),
    })),
  };
  return { skeleton, vertices: vb, indices: Uint32Array.from(idx), clip };
}

/** A small deterministic hash in [0, 1). */
function rand(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Light at a point: warm to the west, cool to the east (the default lighting's hook). */
function sampleLight(x: number): number {
  const k = Math.min(Math.max((x + 40) / 80, 0), 1);
  const r = Math.round(255 - 70 * k);
  const g = Math.round(225 + 10 * k);
  const b = Math.round(175 + 80 * k);
  return (r | (g << 8) | (b << 16) | (255 << 24)) >>> 0;
}

const CHECK_SLOTS = 16;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Actors' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  const device = gpu.device;
  installGpuErrorLogging(device);
  const core = createRenderCore(gpu);
  const actors = createActorSystem(core, {
    slots: 4096,
    bonesPerSlot: 8,
    lods: [35, 120],
    maxViews: 1,
    sampleLight,
  });
  // The robot's part order: body, head, armL, armR, legL, legR.
  const robot = actors.addModel(
    defineRig({
      kind: 'rigid',
      model: ROBOT,
      lods: [ROBOT_FAR],
      materials: MATS,
      bones: {
        body: { pivot: [0, 0.75, 0] },
        head: { parent: 'body', pivot: [0, 1.45, 0] },
        armL: { parent: 'body', pivot: [-0.45, 1.4, 0] },
        armR: { parent: 'body', pivot: [0.45, 1.4, 0] },
        legL: { parent: 'body', pivot: [-0.16, 0.75, 0] },
        legR: { parent: 'body', pivot: [0.16, 0.75, 0] },
      },
      clips: [
        walk([
          [2, -0.6],
          [3, 0.6],
          [4, 0.55],
          [5, -0.55],
        ]),
      ],
    }),
  );
  const fig = figure();
  const figureModel = actors.addModel(
    defineRig({
      kind: 'linear',
      skeleton: fig.skeleton,
      meshes: [{ vertices: fig.vertices, indices: fig.indices, tint: true }],
      clips: [{ clip: fig.clip }],
    }),
  );

  const side = Math.ceil(Math.sqrt(n));
  const spacing = 2.2;
  const half = (side * spacing) / 2;
  const pos = new Float32Array(3);
  const vel = new Float32Array(3);
  for (let i = 0; i < n; i++) {
    const yaw = rand(i) * Math.PI * 2;
    const speed = 0.4 + rand(i + 31) * 0.5;
    pos[0] = (i % side) * spacing - half + rand(i + 7) * 0.8;
    pos[1] = 0;
    pos[2] = Math.floor(i / side) * spacing - half + rand(i + 13) * 0.8;
    // Facing +z at yaw 0; the velocity goes where the actor faces.
    vel[0] = Math.sin(yaw) * speed;
    vel[1] = 0;
    vel[2] = Math.cos(yaw) * speed;
    const hue = rand(i + 101);
    const tint = hue < 0.33 ? 0xff4060e0 : hue < 0.66 ? 0xff40c060 : 0xffe08030;
    actors.setRecord(i, {
      model: i % 2 ? figureModel : robot,
      position: pos,
      since: 0,
      velocity: vel,
      yaw,
      clip: 0,
      clipStart: -rand(i + 3),
      clipRate: speed * 1.6,
      tint,
    });
  }

  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.3, 400);
  const view = createRenderView();
  const views = [view];
  const times: number[] = [];
  const target = {
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    clear: { r: 0.55, g: 0.66, b: 0.78, a: 1 },
  };
  // Readback for `check()`.
  const boneBytes = CHECK_SLOTS * actors.bonesPerSlot * 48;
  const argsBytes = actors.maxDraws * 20;
  const boneRead = device.createBuffer({
    label: 'actors check bones',
    size: boneBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const argsRead = device.createBuffer({
    label: 'actors check args',
    size: argsBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const cpuSkin = new Float32Array(CHECK_SLOTS * actors.bonesPerSlot * 12);
  let checking = false;

  state.gpu = 'ok';
  state.ready = true;
  const start = performance.now();
  let turn = 0;

  const frame = () => {
    const t = (performance.now() - start) / 1000;
    const { width, height } = surface.backbuffer;
    camera.setPerspective(Math.PI / 3, width / Math.max(1, height), 0.3, 400);
    const reach = Math.max(half, 8);
    camera.lookAt([0, reach * 0.55 + 4, -reach * 1.25 - 6], [0, 0, 0]);
    setViewFromCamera(view, camera);
    const texture = gpu.context.getCurrentTexture();
    target.view = texture.createView();
    target.width = texture.width;
    target.height = texture.height;

    const t0 = performance.now();
    // One actor a frame turns about where it stands.
    const k = turn++ % n;
    const dt = t - actors.readF32(k, R.since);
    for (let a = 0; a < 3; a++) {
      vel[a] = -actors.readF32(k, R.vx + a);
      pos[a] = actors.readF32(k, R.x + a) - vel[a]! * dt;
    }
    actors.setRecord(k, {
      position: pos,
      since: t,
      velocity: vel,
      yaw: actors.readF32(k, R.yaw) + Math.PI,
    });

    const encoder = device.createCommandEncoder();
    actors.prepare(encoder, views, t);
    core.prepare(encoder, views);
    const doCheck = wantCheck && !checking;
    if (doCheck) {
      wantCheck = false;
      checking = true;
      encoder.copyBufferToBuffer(actors.bones, 0, boneRead, 0, boneBytes);
      encoder.copyBufferToBuffer(actors.args, 0, argsRead, 0, argsBytes);
    }
    core.draw(encoder, 0, target);
    device.queue.submit([encoder.finish()]);
    times.push(performance.now() - t0);
    if (times.length > 60) times.shift();

    if (doCheck) {
      // The pose the GPU computed this frame, on the CPU, at the clock it saw (an f32).
      const tf = Math.fround(t);
      const out = new Float32Array(actors.bonesPerSlot * 12);
      for (let s = 0; s < CHECK_SLOTS; s++) {
        out.fill(0);
        actors.poseCpu(s, out, 'skin', tf);
        cpuSkin.set(out, s * actors.bonesPerSlot * 12);
      }
      const joints = [actors.rig(robot).joints, actors.rig(figureModel).joints];
      Promise.all([boneRead.mapAsync(GPUMapMode.READ), argsRead.mapAsync(GPUMapMode.READ)])
        .then(() => {
          const gpuSkin = new Float32Array(boneRead.getMappedRange().slice(0));
          const args = new Uint32Array(argsRead.getMappedRange().slice(0));
          boneRead.unmap();
          argsRead.unmap();
          let err = 0;
          for (let s = 0; s < CHECK_SLOTS; s++) {
            const j = joints[s % 2]!;
            for (let i = 0; i < j * 12; i++) {
              const o = s * actors.bonesPerSlot * 12 + i;
              err = Math.max(err, Math.abs(gpuSkin[o]! - cpuSkin[o]!));
            }
          }
          const per = [
            args[actors.drawOf(robot, 0) * 5 + 1]!,
            args[actors.drawOf(robot, 1) * 5 + 1]!,
            args[actors.drawOf(figureModel, 0) * 5 + 1]!,
          ];
          state.poseError = err;
          state.checkedSlots = CHECK_SLOTS;
          state.drawnPerDraw = per;
          state.drawn = per[0]! + per[1]! + per[2]!;
          state.checks++;
          checking = false;
        })
        .catch((e: unknown) => {
          state.gpu = e instanceof Error ? e.message : String(e);
          checking = false;
        });
    }

    const calls = actors.stats.calls + core.stats.calls;
    state.calls = calls;
    if (state.frames > 1) state.maxCalls = Math.max(state.maxCalls, calls);
    state.bundles = core.stats.bundles;
    state.bundleBuilds = core.stats.bundleBuilds;
    state.dispatched = actors.stats.dispatched;
    state.cpuMs = [...times].sort((p, q) => p - q)[times.length >> 1]!;
    state.gpuErrors = gpuDiagnostics.errorCount;
    state.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  state.gpu = e instanceof Error ? e.message : String(e);
  state.ready = true;
});
