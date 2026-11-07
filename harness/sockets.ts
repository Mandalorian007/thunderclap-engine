/**
 * Sockets demo page (ws/sockets, E-015): a three-joint arm animated by `AnimationMixer`, its
 * bones and two attached cubes all drawn through `attachTransform`. Noun-free; nothing here is
 * engine code beyond what a game would write.
 *
 * - The arm: root, elbow, wrist, one unit apart, bent by a looping sine clip (root about Z,
 *   elbow about X). Each bone is a stretched cube on a socket of its own joint.
 * - Cube A rides the wrist by index with a position offset; cube B rides the elbow by name
 *   (`Skeleton.names`) with a rotated, scaled offset. The whole rig turns slowly as an instance
 *   `Transform`, whose `world` is the `instanceWorld` of every socket.
 * - State exposes both sockets' world positions beside their joints' (e2e/sockets.spec.ts
 *   checks the distance equals the offset length and that it moves); `setPaused` parks all
 *   motion (E-017).
 */
import {
  type AnimationClip,
  AnimationMixer,
  attachTransform,
  createSocket,
  POSE_NODE_FLOATS,
  poseToWorld,
  quatFromAxisAngle,
  type Skeleton,
  type Socket,
  socketWorld,
  WORLD_NODE_FLOATS,
} from '@thunderclap-engine/engine/anim';
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessSocketsApi, HarnessSocketsState, Vec3 } from './sockets-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessSocketsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  gpuErrors: 0,
  stats: { drawCalls: 0, instances: 0 },
  paused: false,
  socketWorldPos: [0, 0, 0],
  jointWorldPos: [0, 0, 0],
  offsetLength: 0,
  namedJoint: -1,
  namedSocketWorldPos: [0, 0, 0],
  namedJointWorldPos: [0, 0, 0],
  namedOffsetLength: 0,
};

const api: HarnessSocketsApi = {
  state,
  setPaused(paused) {
    state.paused = paused;
  },
};
window.__harnessSockets = api;

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const [n, r, u] of faces) {
    const base = v / 12;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (n[k]! + sx * r[k]! + sy * u[k]!) * 0.5;
      vertices[v + 3] = n[0]!;
      vertices[v + 4] = n[1]!;
      vertices[v + 5] = n[2]!;
      vertices[v + 6] = (sx + 1) / 2;
      vertices[v + 7] = (1 - sy) / 2;
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += 12;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
    i += 6;
  }
  return { vertices, indices };
}

/** A unit quad in the XZ plane (y = 0) facing +y, white. */
function groundGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the rig

const NODES = 3;
const NAMES = ['root', 'elbow', 'wrist'];

/** Root at the origin, each child one unit up its parent's +y; identity rotations. */
function armSkeleton(): Skeleton {
  const rest = new Float32Array(NODES * POSE_NODE_FLOATS);
  for (let i = 0; i < NODES; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o + 1] = i === 0 ? 0 : 1;
    rest[o + 6] = 1;
    rest[o + 7] = rest[o + 8] = rest[o + 9] = 1;
  }
  return { parents: new Int16Array([-1, 0, 1]), rest, names: NAMES };
}

/** A looping sine: the root sways about Z, the elbow bends about X, over `period` seconds. */
function swayClip(period: number): AnimationClip {
  const keys = 33;
  const times = new Float32Array(keys);
  const rootValues = new Float32Array(keys * 4);
  const elbowValues = new Float32Array(keys * 4);
  for (let k = 0; k < keys; k++) {
    const t = (k / (keys - 1)) * period;
    times[k] = t;
    const phase = (t / period) * Math.PI * 2;
    quatFromAxisAngle(rootValues, k * 4, 0, 0, 1, 0.5 * Math.sin(phase));
    quatFromAxisAngle(elbowValues, k * 4, 1, 0, 0, 0.9 * Math.sin(phase * 2) - 0.3);
  }
  return {
    name: 'sway',
    duration: period,
    channels: [
      { node: 0, path: 'rotation', interpolation: 'LINEAR', times, values: rootValues },
      { node: 1, path: 'rotation', interpolation: 'LINEAR', times, values: elbowValues },
    ],
  };
}

const RIG_TURN_RAD_PER_S = 0.35;
const CUBE_A_OFFSET: Vec3 = [0.8, 1.0, 0];
const CUBE_B_OFFSET: Vec3 = [-0.6, 0.5, 0.3];

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

const scratchWorld = new Float32Array(WORLD_NODE_FLOATS);
function writePosition(socket: Socket, world: Float32Array, instance: Float32Array, out: Vec3) {
  socketWorld(socket, world, instance, scratchWorld);
  out[0] = scratchWorld[3]!;
  out[1] = scratchWorld[7]!;
  out[2] = scratchWorld[11]!;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine sockets demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  camera.lookAt([4.5, 3.5, 7], [0, 1.6, 0]);

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });

  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.direction = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.85, 0.85, 0.8];

  // The rig: skeleton, mixer, world matrices, and the instance transform the arm stands on.
  const skeleton = armSkeleton();
  const mixer = new AnimationMixer(skeleton);
  mixer.play(swayClip(2.4));
  const world = new Float32Array(NODES * WORLD_NODE_FLOATS);
  const rig = new Transform({ x: 0, y: 0.1, z: 0 });

  // Sockets: one per bone (the bone's cube sits half-way up it), the two cosmetics, and the two
  // bare joints the spec compares against.
  const bones = Array.from({ length: NODES }, (_, i) =>
    createSocket(skeleton, i, { position: [0, 0.5, 0], scale: [0.18, 1, 0.18] }),
  );
  const cubeA = createSocket(skeleton, 2, { position: CUBE_A_OFFSET, scale: 0.4 });
  const jointA = createSocket(skeleton, 2);
  const tilt = new Float32Array(4);
  quatFromAxisAngle(tilt, 0, 0, 1, 0, Math.PI / 4);
  const cubeB = createSocket(skeleton, 'elbow', {
    position: CUBE_B_OFFSET,
    rotation: tilt,
    scale: [0.3, 0.3, 0.6],
  });
  const jointB = createSocket(skeleton, 'elbow');
  state.offsetLength = length(CUBE_A_OFFSET);
  state.namedOffsetLength = length(CUBE_B_OFFSET);
  state.namedJoint = cubeB.joint;

  const boneT = bones.map(() => new Transform());
  const cubeAT = new Transform();
  const cubeBT = new Transform();
  const groundT = new Transform({ scaleX: 12, scaleY: 1, scaleZ: 12 });
  const groundP: InstanceParams = { tint: [0.38, 0.42, 0.34, 1] };
  const boneP: InstanceParams = { tint: [0.75, 0.75, 0.8, 1] };
  const cubeAP: InstanceParams = { tint: [1.0, 0.25, 0.1, 1] };
  const cubeBP: InstanceParams = { tint: [0.15, 0.5, 1.0, 1] };
  let turn = 0;

  const loop = new GameLoop({
    update(dt) {
      if (state.paused) return;
      mixer.update(dt);
      turn += dt * RIG_TURN_RAD_PER_S;
      rig.setAxisAngle(0, 1, 0, turn);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      poseToWorld(skeleton, mixer.pose, world);
      const instance = rig.world;
      for (let i = 0; i < NODES; i++) attachTransform(bones[i]!, world, instance, boneT[i]!);
      attachTransform(cubeA, world, instance, cubeAT);
      attachTransform(cubeB, world, instance, cubeBT);
      frame.mesh(ground, lit, groundT, groundP);
      for (let i = 0; i < NODES; i++) frame.mesh(cube, lit, boneT[i]!, boneP);
      frame.mesh(cube, lit, cubeAT, cubeAP);
      frame.mesh(cube, lit, cubeBT, cubeBP);
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      writePosition(cubeA, world, instance, state.socketWorldPos);
      writePosition(jointA, world, instance, state.jointWorldPos);
      writePosition(cubeB, world, instance, state.namedSocketWorldPos);
      writePosition(jointB, world, instance, state.namedJointWorldPos);
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
