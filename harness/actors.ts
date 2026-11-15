/**
 * Actors page (ws/actors): a crowd of `?n=N` actors (default 1000) from
 * `@thunderclap-engine/engine/actors`, half walking toy robots built from part models (a rigid
 * rig, two LODs), half skinned figures (a linear rig over a procedural skinned mesh), all under
 * one pose pass and one bundle of indirect draws. Every frame one actor turns about (one record
 * write), so a frame's GPU calls are the same at 100 actors as at 1,000.
 *
 * `?crowd=1` (ws/actor-post-fit) adds the crowd fit on top of `?fit=1`: see `HarnessActorsState.crowd`.
 * `?parity=1` (ws/pose-parity-fix, implies `fit`): see `HarnessActorsState.parity`.
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
  GpuTimer,
  gpuDiagnostics,
  installGpuErrorLogging,
  SKIN_JOINTS_BYTE_OFFSET,
  setViewFromCamera,
  supportsTimestamps,
  VERTEX_SKINNED_STRIDE,
} from '@thunderclap-engine/engine/render';
import type { HarnessActorsState } from './actors-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const n = Math.max(1, Math.min(4096, Number(params.get('n') ?? 1000) | 0));
const emptyModels = Math.max(0, Math.min(120, Number(params.get('models') ?? 0) | 0));
const timing = params.get('timing') === '1';
const crowd = params.get('crowd') === '1';
const parity = params.get('parity') === '1';
const fit = crowd || parity || params.get('fit') === '1';
const lodScale = Number(params.get('scale') ?? 1) || 1;
const vertexCap = Math.max(0, Number(params.get('cap') ?? 0) | 0);

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
  emptyModels,
  timestamps: false,
  gpuMs: -1,
  gpuSamples: 0,
  fit,
  shadows: 0,
  crowd,
  pipelineReady: false,
  markers: 0,
  recordWrites: 0,
  poseMs: -1,
  parity: parity
    ? {
        checks: 0,
        error: -1,
        worstSlot: -1,
        posed: 0,
        live: 0,
        near: 0,
        far: 0,
        naiveError: -1,
        overlapSame: false,
        bodyVertices: -1,
        bodyVerticesWant: -2,
      }
    : null,
};
let wantCheck = false;
let wantParity = false;
window.__harnessActors = {
  state,
  check() {
    wantCheck = true;
  },
  parityCheck() {
    wantParity = true;
  },
};

/** `?fit=1`: the nod about x, as the pose hook's local rotation times the clip's. */
const NOD_WGSL = /* wgsl */ `
fn actor_pose(actor: u32, model: u32, node: u32, p: Trs, time: f32) -> Trs {
  if (model != 0u || node != 1u) { return p; }
  let h = sin(time * 3.0) * NOD_AMP * 0.5;
  let n = vec4f(sin(h), 0.0, 0.0, cos(h));
  var o = p;
  o.q = vec4f(
    n.w * p.q.x + n.x * p.q.w + n.y * p.q.z - n.z * p.q.y,
    n.w * p.q.y - n.x * p.q.z + n.y * p.q.w + n.z * p.q.x,
    n.w * p.q.z + n.x * p.q.y - n.y * p.q.x + n.z * p.q.w,
    n.w * p.q.w - n.x * p.q.x - n.y * p.q.y - n.z * p.q.z);
  return o;
}
`;

/** `?crowd=1` reads the nod's amplitude from the game table; else a constant. */
const nodWgsl = (table: boolean) =>
  `const NOD_AMP_C = 0.4;\n${NOD_WGSL.replace('NOD_AMP', table ? 'actor_table_f32(0u)' : 'NOD_AMP_C')}`;

/**
 * `?crowd=1`: a small triangle over each visible actor's head (3 vertices a set), its green from
 * the game table bound into the draws (`drawTable`, ws/actor-fit-2).
 */
const MARKER_WGSL = /* wgsl */ `
@vertex fn vs(in: VertexIn, @builtin(instance_index) inst: u32) -> @builtin(position) vec4f {
  let actor = actor_at(actor_draw_of(in.core_vertex), inst);
  var corners = array<vec2f, 3>(vec2f(-0.15, 0.0), vec2f(0.15, 0.0), vec2f(0.0, -0.25));
  let c = corners[in.core_vertex % ACTOR_SET_VERTICES];
  let p = actor_position(actor) + vec3f(c.x, 2.3 + c.y, 0.0) * actor_scale(actor);
  return view.viewProj * vec4f(p, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, actor_table_f32(1u), 0.2, 1.0); }
`;

/** The CPU twin of `NOD_WGSL`: `q = nod(angle about x) · q`. */
function nod(trs: Float32Array, at: number, angle: number): void {
  const h = angle * 0.5;
  const nx = Math.sin(h);
  const nw = Math.cos(h);
  const x = trs[at + 3]!;
  const y = trs[at + 4]!;
  const z = trs[at + 5]!;
  const w = trs[at + 6]!;
  trs[at + 3] = nw * x + nx * w;
  trs[at + 4] = nw * y - nx * z;
  trs[at + 5] = nw * z + nx * y;
  trs[at + 6] = nw * w - nx * x;
}

/** `?fit=1`: a soft dark disc on the ground under each visible actor. */
const SHADOW_WGSL = /* wgsl */ `
struct ShadowOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vs(in: VertexIn, @builtin(instance_index) inst: u32) -> ShadowOut {
  let actor = actor_at(actor_draw_of(in.core_vertex), inst);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let uv = corners[in.core_vertex % ACTOR_SET_VERTICES];
  let p = actor_position(actor) + vec3f(uv.x, 0.0, uv.y) * 0.7 * actor_scale(actor);
  var o: ShadowOut;
  o.clip = view.viewProj * vec4f(p.x, p.y + 0.02, p.z, 1.0);
  o.uv = uv;
  return o;
}
@fragment fn fs(in: ShadowOut) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, clamp(1.0 - dot(in.uv, in.uv), 0.0, 1.0) * 0.45);
}
`;

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
    maxModels: 2 + emptyModels,
    sampleLight,
    ...(fit
      ? {
          // The robot's head (node 1) nods, on the GPU and in `poseCpu` alike.
          poseWgsl: nodWgsl(crowd),
          poseCpu: (
            _slot: number,
            model: number,
            node: number,
            trs: Float32Array,
            at: number,
            time: number,
          ) => {
            if (model !== 0 || node !== 1) return;
            nod(trs, at, Math.fround(Math.sin(time * 3) * 0.4));
          },
          actorVertices: crowd ? [6, 3] : 6,
        }
      : {}),
    ...(crowd
      ? {
          asyncPipeline: true,
          tableWords: 4,
          drawTable: true,
          showLive: false,
          lodScale,
          vertexCap,
        }
      : {}),
  });
  if (crowd) {
    actors.writeTable(new Float32Array([0.4, 0.85, 0, 0]));
    actors.ready.then(
      () => {
        state.pipelineReady = true;
      },
      (e: unknown) => {
        state.gpu = e instanceof Error ? e.message : String(e);
      },
    );
    actors.addDrawSet({
      label: 'markers',
      shape: 'actor',
      vertices: 3,
      showLive: false,
      order: 11,
      castShadow: false,
      shader: { code: MARKER_WGSL, cullMode: 'none' },
    });
  }
  if (fit) {
    actors.addDrawSet({
      label: 'contact shadows',
      shape: 'actor',
      order: 10,
      castShadow: false,
      shader: {
        code: SHADOW_WGSL,
        cullMode: 'none',
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'zero', dstFactor: 'one' },
        },
      },
    });
  }
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
    crowd ? { lods: [30, 200] } : undefined,
  );
  // Models no actor shows (`?models=M`): their draws are empty every frame.
  for (let m = 0; m < emptyModels; m++) {
    actors.addModel(
      defineRig({
        kind: 'rigid',
        model: { ...ROBOT, name: `robot-${m}` },
        lods: [ROBOT_FAR],
        materials: MATS,
      }),
    );
  }
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
  for (let i = 0; i < (parity ? 0 : n); i++) {
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
      ...(crowd && i % 9 === 8 ? { cullRadius: 0.01 } : {}),
    });
  }

  // `?parity=1`: actor i in slot i × PARITY_GAP (runs too far apart to merge: sparse uploads),
  // walking a circle whose centre is near the camera or past the LOD distance (35), its record
  // rewritten every frame (as a game moves its players: no velocity), an eighth of them gone at
  // a time and the eighth changing every 10 frames (spawns and despawns).
  const PARITY_GAP = 13;
  const parityLive = new Uint8Array(n);
  const parityFrame = (t: number, frameNo: number) => {
    for (let i = 0; i < n; i++) {
      const slot = i * PARITY_GAP;
      const live = (Math.floor(frameNo / 10) + i) % 8 !== 0;
      if (!live) {
        if (parityLive[i]) actors.remove(slot);
        parityLive[i] = 0;
        continue;
      }
      const far = i % 3 === 2;
      const cx = (rand(i + 5) - 0.5) * 16;
      const cz = far ? 30 + rand(i + 9) * 15 : (rand(i + 9) - 0.5) * 10;
      const r = 1 + rand(i + 2) * 2;
      const a = rand(i) * 6.283 + (i % 2 ? 1 : -1) * (1 + rand(i + 4) * 3) * t;
      pos[0] = cx + Math.cos(a) * r;
      pos[1] = 0;
      pos[2] = cz + Math.sin(a) * r;
      if (!parityLive[i]) {
        parityLive[i] = 1;
        actors.setRecord(slot, {
          model: i % 2 ? figureModel : robot,
          velocity: [0, 0, 0],
          clip: 0,
          clipStart: t - rand(i + 3),
          clipRate: 1 + rand(i + 31),
          tint: 0xff40c060,
        });
      }
      actors.setRecord(slot, { position: pos, yaw: a });
    }
  };
  const parityOut = new Float32Array(actors.bonesPerSlot * 12);

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
    timestamps: undefined as
      | ((label: string) => GPURenderPassTimestampWrites | undefined)
      | undefined,
  };
  // Readback for `check()`.
  const boneBytes = CHECK_SLOTS * actors.bonesPerSlot * 48;
  const argsWords = crowd ? 13 : fit ? 9 : 5;
  const argsBytes = actors.maxDraws * argsWords * 4;
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

  // GPU time (`?timing=1`): every frame sampled that the timer is free for.
  state.timestamps = supportsTimestamps(device);
  const timer = (timing || crowd) && state.timestamps ? new GpuTimer(device) : null;
  const gpuTimes: number[] = [];
  const poseTimes: number[] = [];
  timer?.onResult((r) => {
    const pose = r.passes.actors;
    if (pose !== undefined) {
      poseTimes.push(pose);
      if (poseTimes.length > 120) poseTimes.shift();
      state.poseMs = [...poseTimes].sort((p, q) => p - q)[poseTimes.length >> 1]!;
    }
    gpuTimes.push(r.totalMs);
    if (gpuTimes.length > 120) gpuTimes.shift();
    state.gpuSamples++;
    state.gpuMs = [...gpuTimes].sort((p, q) => p - q)[gpuTimes.length >> 1]!;
  });
  const timestamps = timer ? (label: string) => timer.pass(label) : undefined;

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
    if (parity) parityFrame(t, state.frames);
    if (!parity) {
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
    }

    const encoder = device.createCommandEncoder();
    const timed = timer?.begin() ?? false;
    target.timestamps = timed ? timestamps : undefined;
    if (timed) timer!.mark(encoder);
    actors.prepare(encoder, views, t, crowd && timed ? timer!.pass('actors') : undefined);
    core.prepare(encoder, views);
    const doCheck = wantCheck && !checking;
    if (doCheck) {
      wantCheck = false;
      checking = true;
      encoder.copyBufferToBuffer(actors.bones, 0, boneRead, 0, boneBytes);
      encoder.copyBufferToBuffer(actors.args, 0, argsRead, 0, argsBytes);
    }
    core.draw(encoder, 0, target);
    if (timed) timer!.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    if (timed) timer!.afterSubmit();
    times.push(performance.now() - t0);
    if (times.length > 60) times.shift();

    if (parity && wantParity && !checking) {
      // Right after the submit: the CPU twin of this frame's records, at the clock the pass saw.
      wantParity = false;
      checking = true;
      let live = 0;
      for (let i = 0; i < n; i++) live += parityLive[i]!;
      const pending = actors.readBack();
      // A second read overlapping the first (ws/actor-fit-2): its own buffer, the same frame.
      const twin = actors.readBack();
      // A frame that runs while the copy maps (a game's next frame, under load): every record
      // moves on (0.1 s) and the clock with it. The readback's CPU twin must not see it.
      parityFrame(t + 0.1, state.frames + 1);
      const extra = device.createCommandEncoder();
      actors.prepare(extra, views, t + 0.1);
      device.queue.submit([extra.finish()]);
      Promise.all([pending, twin]).then(
        ([rb, rb2]) => {
          const p = state.parity!;
          p.overlapSame =
            rb2.maxError === rb.maxError &&
            rb2.gpu.length === rb.gpu.length &&
            rb2.gpu.every((v, i) => v === rb.gpu[i]) &&
            rb2.args.every((v, i) => v === rb.args[i]);
          // The body's vertices that frame: its instances × each mesh's indices.
          let want = 0;
          for (let m = 0; m < actors.models; m++) {
            actors.rig(m).meshes.forEach((mesh, lod) => {
              want += rb.args[actors.drawOf(m, lod) * rb.argsWords + 1]! * mesh.indices.length;
            });
          }
          p.bodyVertices = rb.setVertices[0]!;
          p.bodyVerticesWant = want;
          // The old way, for the log: `poseCpu` after the map, on records frames since have moved.
          let naive = 0;
          const per = actors.bonesPerSlot * 12;
          rb.slots.forEach((slot, i) => {
            parityOut.fill(0);
            if (!actors.poseCpu(slot, parityOut, 'skin', rb.time)) return;
            const j = actors.rig(rb.models[i]!).joints * 12;
            for (let k = 0; k < j; k++) {
              naive = Math.max(naive, Math.abs(rb.gpu[i * per + k]! - parityOut[k]!));
            }
          });
          const W = rb.argsWords;
          p.near = rb.args[actors.drawOf(robot, 0) * W + 1]!;
          p.far = rb.args[actors.drawOf(robot, 1) * W + 1]!;
          p.error = rb.maxError;
          p.worstSlot = rb.worstSlot;
          p.posed = rb.slots.length;
          p.live = live;
          p.naiveError = naive;
          p.checks++;
          checking = false;
        },
        (e: unknown) => {
          state.gpu = e instanceof Error ? e.message : String(e);
          checking = false;
        },
      );
    }

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
            args[actors.drawOf(robot, 0) * argsWords + 1]!,
            args[actors.drawOf(robot, 1) * argsWords + 1]!,
            args[actors.drawOf(figureModel, 0) * argsWords + 1]!,
          ];
          if (fit) {
            let shadows = 0;
            for (let d = 0; d < actors.maxDraws; d++) shadows += args[d * argsWords + 6]!;
            state.shadows = shadows;
          }
          if (crowd) {
            let markers = 0;
            for (let d = 0; d < actors.maxDraws; d++) markers += args[d * argsWords + 10]!;
            state.markers = markers;
          }
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
    state.recordWrites = actors.stats.recordWrites;
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
