/**
 * IK harness page: `twoBoneIk` and `lookAt` from `@thunderclap-engine/engine/anim` on a procedural rig
 * (`createPose`, no assets, no WebGPU), drawn with a 2D canvas through a perspective `Camera`, so
 * e2e/ik.spec.ts can watch the solve on every matrix row. Noun-free.
 *
 * - Rig: 0 base, 1 shoulder (chain root), 2 elbow (mid), 3 wrist (tip), 4 neck, 5 head. Each arm
 *   bone is one unit long, so the arm reaches 2 from the shoulder.
 * - A target orbits on an ellipse inside the arm's reach on real time; the wrist follows it and
 *   the head looks at it. `state.tipError` is the distance wrist→target after the solve.
 * - `setMoving(false)` parks the orbit (E-017); `setTarget` puts the target anywhere, reachable
 *   or not.
 */
import {
  copyPose,
  createIkChain,
  createPose,
  lookAt,
  POSE_NODE_FLOATS,
  poseToWorld,
  type Skeleton,
  twoBoneIk,
  WORLD_NODE_FLOATS,
} from '@thunderclap-engine/engine/anim';
import { computeLetterbox } from '@thunderclap-engine/engine/platform';
import { Camera } from '@thunderclap-engine/engine/render';
import type { HarnessIkApi, HarnessIkState } from './ik-state';

const LOGICAL = { width: 800, height: 600 };
const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

// Rig: base at the origin; shoulder 1.5 up; elbow and wrist one unit along +X; neck 1.8 up,
// head 0.3 above it. Identity rotations, unit scale.
const PARENTS = new Int16Array([-1, 0, 1, 2, 0, 4]);
const OFFSETS: [number, number, number][] = [
  [0, 0, 0],
  [0, 1.5, 0],
  [1, 0, 0],
  [1, 0, 0],
  [0, 1.8, 0],
  [0, 0.3, 0],
];
const rest = new Float32Array(PARENTS.length * POSE_NODE_FLOATS);
for (let i = 0; i < PARENTS.length; i++) {
  const o = i * POSE_NODE_FLOATS;
  rest.set(OFFSETS[i]!, o);
  rest[o + 6] = 1;
  rest[o + 7] = 1;
  rest[o + 8] = 1;
  rest[o + 9] = 1;
}
const skeleton: Skeleton = { parents: PARENTS, rest };
const SHOULDER = 1;
const WRIST = 3;
const HEAD = 5;
const chain = createIkChain(skeleton, { root: SHOULDER, mid: 2, tip: WRIST });
const pose = createPose(skeleton);
const world = new Float32Array(PARENTS.length * WORLD_NODE_FLOATS);
const target = new Float32Array(3);
const pole = new Float32Array([0, 3.5, 1]);
const FORWARD = [0, 0, 1];
const UP = [0, 1, 0];

const camera = Camera.perspective(Math.PI / 4, LOGICAL.width / LOGICAL.height, 0.1, 100);
camera.lookAt([2.5, 2.2, 6.5], [0.6, 1.4, 0]);
Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });

const state: HarnessIkState = {
  ready: false,
  ticks: 0,
  time: 0,
  target: [0, 0, 0],
  tipError: 0,
  headError: 0,
  reach: 0,
  moving: true,
};

/** The target's orbit: an ellipse in front of the shoulder, within reach (max distance ≈ 1.8). */
function orbit(t: number): void {
  target[0] = 0.9 + 0.7 * Math.cos(t * 1.3);
  target[1] = 1.5 + 0.6 * Math.sin(t * 1.3);
  target[2] = 0.8 + 0.5 * Math.sin(t * 0.7);
}

function solve(): void {
  copyPose(rest, pose);
  poseToWorld(skeleton, pose, world);
  twoBoneIk(pose, skeleton, world, chain, target, pole, null);
  lookAt(pose, skeleton, world, HEAD, target, null, { forward: FORWARD, up: UP, maxAngle: 1.6 });
  poseToWorld(skeleton, pose, world);
  const w = WRIST * WORLD_NODE_FLOATS;
  state.tipError = Math.hypot(
    world[w + 3]! - target[0]!,
    world[w + 7]! - target[1]!,
    world[w + 11]! - target[2]!,
  );
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
  const s = SHOULDER * WORLD_NODE_FLOATS;
  state.reach = Math.hypot(
    world[s + 3]! - target[0]!,
    world[s + 7]! - target[1]!,
    world[s + 11]! - target[2]!,
  );
  state.target = [target[0]!, target[1]!, target[2]!];
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

const p = { x: 0, y: 0, z: 0 };
function project(x: number, y: number, z: number): { x: number; y: number } {
  camera.worldToScreen(x, y, z, p);
  return { x: p.x, y: p.y };
}

function draw(): void {
  if (!g2) return;
  g2.fillStyle = '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  // Ground grid.
  g2.strokeStyle = '#2c3548';
  g2.lineWidth = 1;
  for (let i = -3; i <= 3; i++) {
    const a = project(i, 0, -3);
    const b = project(i, 0, 3);
    g2.beginPath();
    g2.moveTo(a.x, a.y);
    g2.lineTo(b.x, b.y);
    g2.stroke();
    const c = project(-3, 0, i);
    const d = project(3, 0, i);
    g2.beginPath();
    g2.moveTo(c.x, c.y);
    g2.lineTo(d.x, d.y);
    g2.stroke();
  }
  // Bones.
  g2.lineWidth = 6;
  g2.lineCap = 'round';
  for (let i = 1; i < PARENTS.length; i++) {
    const po = PARENTS[i]! * WORLD_NODE_FLOATS;
    const o = i * WORLD_NODE_FLOATS;
    const a = project(world[po + 3]!, world[po + 7]!, world[po + 11]!);
    const b = project(world[o + 3]!, world[o + 7]!, world[o + 11]!);
    g2.strokeStyle = i <= WRIST ? '#8fb0e0' : '#c8a060';
    g2.beginPath();
    g2.moveTo(a.x, a.y);
    g2.lineTo(b.x, b.y);
    g2.stroke();
  }
  // Head forward ray.
  const h = HEAD * WORLD_NODE_FLOATS;
  const hp = project(world[h + 3]!, world[h + 7]!, world[h + 11]!);
  const hf = project(
    world[h + 3]! + world[h + 2]! * 0.6,
    world[h + 7]! + world[h + 6]! * 0.6,
    world[h + 11]! + world[h + 10]! * 0.6,
  );
  g2.lineWidth = 2;
  g2.strokeStyle = '#f0e0a0';
  g2.beginPath();
  g2.moveTo(hp.x, hp.y);
  g2.lineTo(hf.x, hf.y);
  g2.stroke();
  // Joints.
  for (let i = 0; i < PARENTS.length; i++) {
    const o = i * WORLD_NODE_FLOATS;
    const q = project(world[o + 3]!, world[o + 7]!, world[o + 11]!);
    g2.fillStyle = '#e8eef8';
    g2.beginPath();
    g2.arc(q.x, q.y, 5, 0, Math.PI * 2);
    g2.fill();
  }
  // Target.
  const t = project(target[0]!, target[1]!, target[2]!);
  g2.strokeStyle = state.tipError < 1e-3 ? '#60e080' : '#e06060';
  g2.lineWidth = 2;
  g2.beginPath();
  g2.arc(t.x, t.y, 9, 0, Math.PI * 2);
  g2.stroke();
}

let last = performance.now();
const tick = (now: number) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.moving) {
    state.time += dt;
    orbit(state.time);
  }
  solve();
  draw();
  state.ticks++;
  requestAnimationFrame(tick);
};
orbit(0);
solve();
requestAnimationFrame(tick);

const api: HarnessIkApi = {
  state,
  setMoving(moving) {
    state.moving = moving;
  },
  setTarget(x, y, z) {
    state.moving = false;
    target[0] = x;
    target[1] = y;
    target[2] = z;
  },
};
window.__harnessIk = api;
state.ready = true;
