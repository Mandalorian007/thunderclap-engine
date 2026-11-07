/**
 * Anim-4 harness page: the ws/anim-4 pieces of `@thunderclap-engine/engine/anim` on one procedural
 * stick figure (no assets, no WebGPU), drawn with a 2D canvas through a perspective `Camera`, so
 * e2e/anim4.spec.ts can watch each on every matrix row. One mode per page load:
 *
 * - `?blend2d`: a 3×3 strafe set in a 2D blend space on `px`, `py` (`?px=&py=`, the pad's left
 *   stick, or an orbit); `state.weights` are the nine point weights.
 * - `?aim`: a target orbits the figure; the spine, neck and head share the turn through
 *   `applyAimOffset`; `state.headYaw` is the clamped yaw.
 * - `?foot`: the figure idles over a stepped floor (−0.15 for x < 0); `applyFootIk` sinks the
 *   pelvis and plants the feet; `state.pelvisY`, `state.footGap`.
 * - `?spring`: a four-joint cape on a figure turning left and right; `state.tipLag` is how far
 *   the cape tip trails its sampled place; `?teleport` jumps the instance 5 units once at 1 s.
 * - `?match`: two walk clips (the second half a cycle out of phase) cut between each 2 s, the
 *   pose matched; `state.startTime` is where the clip entered started.
 *
 * `setMoving(false)` parks the page's own motion (E-017). Nothing here is engine code.
 */
import {
  type AnimationClip,
  AnimationMixer,
  applyAimOffset,
  applyFootIk,
  createAimOffset,
  createAnimGraph,
  createFootIk,
  createSpringChain,
  multiplyAffine,
  POSE_NODE_FLOATS,
  type Pose,
  poseToWorld,
  quatFromAxisAngle,
  type Skeleton,
  updateSpringChain,
  WORLD_NODE_FLOATS,
} from '@thunderclap-engine/engine/anim';
import { computeLetterbox } from '@thunderclap-engine/engine/platform';
import { Camera } from '@thunderclap-engine/engine/render';
import type { HarnessAnim4Api, HarnessAnim4Mode, HarnessAnim4State } from './anim4-state';

const LOGICAL = { width: 800, height: 600 };
const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

const query = new URLSearchParams(location.search);
const MODES: HarnessAnim4Mode[] = ['blend2d', 'aim', 'foot', 'spring', 'match'];
const mode: HarnessAnim4Mode = MODES.find((m) => query.has(m)) ?? 'blend2d';

// Rig: 0 pelvis, 1 spine, 2 chest, 3 neck, 4 head; 5-7 left hip/knee/ankle, 8-10 right;
// 11-14 a cape hanging from the chest. Feet rest on y = 0; knees bend toward +Z.
const PARENTS = new Int16Array([-1, 0, 1, 2, 3, 0, 5, 6, 0, 8, 9, 2, 11, 12, 13]);
const OFFSETS: [number, number, number][] = [
  [0, 1, 0],
  [0, 0.3, 0],
  [0, 0.3, 0],
  [0, 0.2, 0],
  [0, 0.2, 0],
  [-0.15, 0, 0],
  [0, -0.5, 0.02],
  [0, -0.5, -0.02],
  [0.15, 0, 0],
  [0, -0.5, 0.02],
  [0, -0.5, -0.02],
  [0, 0.1, -0.12],
  [0, -0.3, 0],
  [0, -0.3, 0],
  [0, -0.3, 0],
];
const N = PARENTS.length;
const rest = new Float32Array(N * POSE_NODE_FLOATS);
for (let i = 0; i < N; i++) {
  const o = i * POSE_NODE_FLOATS;
  rest.set(OFFSETS[i]!, o);
  rest[o + 6] = 1;
  rest[o + 7] = 1;
  rest[o + 8] = 1;
  rest[o + 9] = 1;
}
const skeleton: Skeleton = { parents: PARENTS, rest };
const PELVIS = 0;
const HEAD = 4;
const L = { root: 5, mid: 6, tip: 7 };
const R = { root: 8, mid: 9, tip: 10 };
const CAPE_ROOT = 11;
const CAPE_TIP = 14;

/** Bake a clip at 30 Hz from per-node rotation functions and a pelvis bob. */
function bake(
  name: string,
  duration: number,
  rot: Record<number, (t: number, out: Float32Array, o: number) => void>,
  bob?: (t: number) => number,
): AnimationClip {
  const n = Math.round(duration * 30) + 1;
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = (i / (n - 1)) * duration;
  const clip: AnimationClip = { name, duration, channels: [] };
  for (const key of Object.keys(rot)) {
    const node = Number(key);
    const values = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) rot[node]!(times[i]!, values, i * 4);
    clip.channels.push({ node, path: 'rotation', interpolation: 'LINEAR', times, values });
  }
  if (bob) {
    const values = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      values[i * 3] = 0;
      values[i * 3 + 1] = 1 + bob(times[i]!);
      values[i * 3 + 2] = 0;
    }
    clip.channels.push({
      node: PELVIS,
      path: 'translation',
      interpolation: 'LINEAR',
      times,
      values,
    });
  }
  return clip;
}

/** A locomotion cycle for the velocity (vx, vz): legs swing about the axis across the motion. */
function walk(vx: number, vz: number, phase = 0): AnimationClip {
  const speed = Math.hypot(vx, vz);
  if (speed === 0) {
    return bake(
      'idle',
      1.6,
      {
        1: (t, o, i) => quatFromAxisAngle(o, i, 0, 0, 1, 0.03 * Math.sin((t / 1.6) * Math.PI * 2)),
      },
      (t) => 0.01 * Math.sin((t / 1.6) * Math.PI * 2),
    );
  }
  const d = 1 / speed;
  const ax = vz / speed;
  const az = -vx / speed;
  const amp = 0.45 * Math.min(1, speed);
  const w = (t: number) => ((t / d) * Math.PI + phase) * 2;
  return bake(
    `walk(${vx},${vz})`,
    d,
    {
      [L.root]: (t, o, i) => quatFromAxisAngle(o, i, ax, 0, az, amp * Math.sin(w(t))),
      // Knees bend on the cosine so every phase of the cycle is a distinct pose (pose matching).
      [L.mid]: (t, o, i) => quatFromAxisAngle(o, i, 1, 0, 0, 0.25 * (1 + Math.cos(w(t)))),
      [R.root]: (t, o, i) => quatFromAxisAngle(o, i, ax, 0, az, -amp * Math.sin(w(t))),
      [R.mid]: (t, o, i) => quatFromAxisAngle(o, i, 1, 0, 0, 0.25 * (1 - Math.cos(w(t)))),
    },
    (t) => 0.03 * Math.abs(Math.sin(w(t))) * Math.min(1, speed),
  );
}

const state: HarnessAnim4State = {
  ready: false,
  ticks: 0,
  time: 0,
  mode,
  moving: true,
  px: 0,
  py: 0,
  weights: [],
  headYaw: 0,
  headPitch: 0,
  headError: 0,
  target: [0, 0, 0],
  pelvisY: 0,
  footGap: 0,
  tipLag: 0,
  instanceX: 0,
  teleported: false,
  lagBefore: 0,
  lagAfter: 0,
  matchState: 'a',
  startTime: 0,
  timeBefore: 0,
  duration: 0,
};

const mixer = new AnimationMixer(skeleton, { maxActions: 12 });
const pose: Pose = mixer.pose;
const world = new Float32Array(N * WORLD_NODE_FLOATS);
const drawn = new Float32Array(N * WORLD_NODE_FLOATS);
const instance = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
const target = new Float32Array([0, 1.8, 2]);
let orbiting = true;

// --- blend2d: a 3×3 grid of velocities, y rows then x columns.
const GRID = [-1, 0, 1];
const points = GRID.flatMap((y) =>
  GRID.map((x) => ({ at: [x, y] as [number, number], clip: walk(x, y) })),
);
const blendGraph =
  mode === 'blend2d'
    ? createAnimGraph(mixer, {
        params: { px: 0, py: 0 },
        states: { move: { blend: { params: ['px', 'py'], points } } },
        transitions: [],
        initial: 'move',
      })
    : null;

// --- match: two walks half a cycle apart, cut between every two seconds.
const walkA = walk(0, 1);
const walkB = walk(0, 1, Math.PI / 2);
const matchGraph =
  mode === 'match'
    ? createAnimGraph(mixer, {
        params: {},
        states: { a: { clip: walkA }, b: { clip: walkB } },
        transitions: [],
        initial: 'a',
        match: { joints: [L.mid, L.tip, R.mid, R.tip] },
      })
    : null;
let nextCut = 2;
let cutsMatched = true;

// --- aim, foot, spring: an idle on the mixer plus the pass.
if (mode === 'aim' || mode === 'foot' || mode === 'spring') mixer.play(walk(0, 0));
const aim = createAimOffset(skeleton, {
  joints: [1, 2, 3, HEAD],
  weights: [1, 1, 1, 2],
  maxYaw: 1.2,
  maxPitch: 0.7,
});
const STEP_Y = -0.15;
const footIk = createFootIk(skeleton, {
  feet: [L, R],
  pelvis: PELVIS,
  blend: 10,
  probe: (x, _z, out) => {
    out[0] = x < 0 ? STEP_Y : 0;
    out[1] = 0;
    out[2] = 1;
    out[3] = 0;
    return true;
  },
});
const cape = createSpringChain(skeleton, {
  root: CAPE_ROOT,
  tip: CAPE_TIP,
  stiffness: 30,
  damping: 4,
  drag: 0.3,
  collide: [{ center: [0, 1, 0], radius: 0.2 }],
});
const TELEPORT_AT = 1;
let teleportArmed = query.has('teleport');
if (query.has('px') || query.has('py')) {
  orbiting = false;
  state.px = Number(query.get('px') ?? 0) || 0;
  state.py = Number(query.get('py') ?? 0) || 0;
}

const camera = Camera.perspective(Math.PI / 4, LOGICAL.width / LOGICAL.height, 0.1, 100);
Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });

function aimOrbit(t: number): void {
  target[0] = 2.5 * Math.sin(t * 0.8);
  target[1] = 1.8 + 0.8 * Math.sin(t * 0.5);
  target[2] = 2.5 * Math.cos(t * 0.8);
}

function readParams(): void {
  if (!orbiting) return;
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  const pad = pads.find((p) => p?.connected);
  if (pad && (Math.abs(pad.axes[0] ?? 0) > 0.1 || Math.abs(pad.axes[1] ?? 0) > 0.1)) {
    state.px = pad.axes[0] ?? 0;
    state.py = -(pad.axes[1] ?? 0);
  } else {
    state.px = Math.sin(state.time * 0.6);
    state.py = Math.cos(state.time * 0.45);
  }
}

function step(dt: number): void {
  if (blendGraph) {
    readParams();
    blendGraph.set('px', state.px);
    blendGraph.set('py', state.py);
    blendGraph.update(dt);
    const actions = blendGraph.actions('move');
    state.weights = actions.map((a) => a.weight);
  } else if (matchGraph) {
    if (state.moving && state.time >= nextCut) {
      nextCut += 2;
      cut(cutsMatched);
    }
    matchGraph.update(dt);
    state.matchState = matchGraph.state;
    state.duration = walkA.duration;
  } else {
    mixer.update(dt);
  }
  poseToWorld(skeleton, pose, world);

  if (mode === 'aim') {
    if (orbiting) aimOrbit(state.time);
    applyAimOffset(pose, skeleton, world, aim, target, null);
    poseToWorld(skeleton, pose, world);
    state.headYaw = aim.yaw;
    state.headPitch = aim.pitch;
    const h = HEAD * WORLD_NODE_FLOATS;
    const fx = world[h + 2]!;
    const fy = world[h + 6]!;
    const fz = world[h + 10]!;
    const dx = target[0]! - world[h + 3]!;
    const dy = target[1]! - world[h + 7]!;
    const dz = target[2]! - world[h + 11]!;
    const cx = fy * dz - fz * dy;
    const cy = fz * dx - fx * dz;
    const cz = fx * dy - fy * dx;
    state.headError = Math.atan2(Math.hypot(cx, cy, cz), fx * dx + fy * dy + fz * dz);
    state.target = [target[0]!, target[1]!, target[2]!];
  } else if (mode === 'foot') {
    applyFootIk(pose, skeleton, world, footIk, null, dt);
    poseToWorld(skeleton, pose, world);
    state.pelvisY = world[PELVIS * WORLD_NODE_FLOATS + 7]!;
    const ly = world[L.tip * WORLD_NODE_FLOATS + 7]!;
    const ry = world[R.tip * WORLD_NODE_FLOATS + 7]!;
    state.footGap = Math.max(Math.abs(ly - STEP_Y), Math.abs(ry));
  } else if (mode === 'spring') {
    // The figure turns left and right about its own axis.
    const yaw = 1.2 * Math.sin(state.time * 1.5);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    instance[0] = c;
    instance[2] = s;
    instance[8] = -s;
    instance[10] = c;
    const before = state.tipLag;
    if (teleportArmed && state.time >= TELEPORT_AT) {
      teleportArmed = false;
      teleport();
    }
    updateSpringChain(pose, skeleton, world, cape, instance, dt);
    poseToWorld(skeleton, pose, world);
    const o = (CAPE_TIP - CAPE_ROOT) * 3;
    state.tipLag = Math.hypot(
      cape.positions[o]! - cape.animated[o]!,
      cape.positions[o + 1]! - cape.animated[o + 1]!,
      cape.positions[o + 2]! - cape.animated[o + 2]!,
    );
    if (state.teleported && state.lagAfter < 0) {
      state.lagBefore = before;
      state.lagAfter = state.tipLag;
    }
    state.instanceX = instance[3]!;
  }
  for (let i = 0; i < N; i++) {
    multiplyAffine(drawn, i * WORLD_NODE_FLOATS, instance, 0, world, i * WORLD_NODE_FLOATS);
  }
}

function cut(matchPose: boolean): void {
  if (!matchGraph) return;
  const from = matchGraph.state;
  const to = from === 'a' ? 'b' : 'a';
  state.timeBefore = matchGraph.actions(from)[0]!.time;
  matchGraph.go(to, 0.2, { matchPose });
  state.startTime = matchGraph.actions(to)[0]!.time;
  state.matchState = to;
}

function teleport(): void {
  instance[3] = instance[3]! + 5;
  state.teleported = true;
  state.lagAfter = -1;
}

const layout = () => {
  const r = computeLetterbox(root.clientWidth, root.clientHeight, LOGICAL.width, LOGICAL.height);
  Object.assign(stage.style, {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
};
window.addEventListener('resize', layout);
layout();

const pt = { x: 0, y: 0, z: 0 };
function project(x: number, y: number, z: number): { x: number; y: number } {
  camera.worldToScreen(x, y, z, pt);
  return { x: pt.x, y: pt.y };
}
function line(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  if (!g2) return;
  const a = project(ax, ay, az);
  const b = project(bx, by, bz);
  g2.beginPath();
  g2.moveTo(a.x, a.y);
  g2.lineTo(b.x, b.y);
  g2.stroke();
}

function draw(): void {
  if (!g2) return;
  const cx = instance[3]!;
  camera.lookAt([cx + 2.4, 2.2, 5.5], [cx, 1, 0]);
  g2.fillStyle = '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  // Ground: a grid, stepped in foot mode.
  g2.strokeStyle = '#2c3548';
  g2.lineWidth = 1;
  for (let i = -3; i <= 3; i++) {
    const yl = mode === 'foot' && i < 0 ? STEP_Y : 0;
    line(cx + i, yl, -3, cx + i, yl, 3);
    line(cx - 3, STEP_Y * (mode === 'foot' ? 1 : 0), i, cx, STEP_Y * (mode === 'foot' ? 1 : 0), i);
    line(cx, 0, i, cx + 3, 0, i);
  }
  // Bones.
  g2.lineWidth = 6;
  g2.lineCap = 'round';
  for (let i = 1; i < N; i++) {
    const po = PARENTS[i]! * WORLD_NODE_FLOATS;
    const o = i * WORLD_NODE_FLOATS;
    g2.strokeStyle = i >= CAPE_ROOT ? '#c05050' : i >= L.root ? '#8fb0e0' : '#c8a060';
    line(
      drawn[po + 3]!,
      drawn[po + 7]!,
      drawn[po + 11]!,
      drawn[o + 3]!,
      drawn[o + 7]!,
      drawn[o + 11]!,
    );
  }
  if (mode === 'spring') {
    // The simulated cape over the posed one.
    g2.strokeStyle = '#f0b060';
    g2.lineWidth = 2;
    const p = cape.positions;
    for (let i = 1; i < cape.joints.length; i++) {
      const o = i * 3;
      line(p[o - 3]!, p[o - 2]!, p[o - 1]!, p[o]!, p[o + 1]!, p[o + 2]!);
    }
  }
  if (mode === 'aim') {
    const h = HEAD * WORLD_NODE_FLOATS;
    g2.strokeStyle = '#f0e0a0';
    g2.lineWidth = 2;
    line(
      drawn[h + 3]!,
      drawn[h + 7]!,
      drawn[h + 11]!,
      drawn[h + 3]! + drawn[h + 2]! * 0.6,
      drawn[h + 7]! + drawn[h + 6]! * 0.6,
      drawn[h + 11]! + drawn[h + 10]! * 0.6,
    );
    const t = project(target[0]!, target[1]!, target[2]!);
    g2.strokeStyle = state.headError < 0.02 ? '#60e080' : '#e06060';
    g2.beginPath();
    g2.arc(t.x, t.y, 9, 0, Math.PI * 2);
    g2.stroke();
  }
  if (mode === 'blend2d') {
    // The blend space as a 3×3 map, the query as a dot, weights as disc sizes.
    const ox = 660;
    const oy = 120;
    const sc = 50;
    g2.strokeStyle = '#556';
    g2.strokeRect(ox - sc, oy - sc, 2 * sc, 2 * sc);
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i]!.at;
      g2.fillStyle = '#8fb0e0';
      g2.beginPath();
      g2.arc(ox + x * sc, oy - y * sc, 2 + 10 * (state.weights[i] ?? 0), 0, Math.PI * 2);
      g2.fill();
    }
    g2.fillStyle = '#f0e0a0';
    g2.beginPath();
    g2.arc(ox + state.px * sc, oy - state.py * sc, 4, 0, Math.PI * 2);
    g2.fill();
  }
  if (mode === 'match') {
    g2.fillStyle = '#e8eef8';
    g2.font = '14px monospace';
    g2.fillText(`${state.matchState} start ${state.startTime.toFixed(3)}`, 16, 24);
  }
}

let last = performance.now();
const tick = (now: number) => {
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  const dt = state.moving ? real : 0;
  if (state.moving) state.time += dt;
  step(dt);
  draw();
  state.ticks++;
  requestAnimationFrame(tick);
};
step(0);
requestAnimationFrame(tick);

const api: HarnessAnim4Api = {
  state,
  setMoving(moving) {
    state.moving = moving;
  },
  setParams(px, py) {
    orbiting = false;
    state.px = px;
    state.py = py;
  },
  setTarget(x, y, z) {
    orbiting = false;
    target[0] = x;
    target[1] = y;
    target[2] = z;
  },
  cut(matchPose) {
    cutsMatched = matchPose;
    cut(matchPose);
  },
  teleport,
};
window.__harnessAnim4 = api;
state.ready = true;
