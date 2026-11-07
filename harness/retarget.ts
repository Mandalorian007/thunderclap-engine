/**
 * Retarget harness page: `createRetargetMap` and `retargetPose` from `@thunderclap-engine/engine/anim`
 * on two procedural stick figures (no assets, no WebGPU), drawn with a 2D canvas, so
 * e2e/retarget.spec.ts can watch a clip cross rigs on every matrix row. Noun-free.
 *
 * - Left: the source rig (`mixamorig:*` names, hips 1 up, 0.7 arm bones) plays a procedural
 *   wave clip through an `AnimationMixer`.
 * - Right: the target rig (snake_case names, hips 1.4 up, 0.9 arm bones; the right arm's rest
 *   frames turned ±90° about Z so the local joint frames differ while the bones point the same
 *   way at rest) is driven by `retargetPose` from the mixer's pose every frame.
 * - `state.sourceHandDir` / `targetHandDir` are the forearm directions in world space; the spec
 *   checks they agree. `setMoving(false)` parks the clip (E-017).
 */
import {
  type AnimationClip,
  AnimationMixer,
  createRetargetMap,
  POSE_NODE_FLOATS,
  poseToWorld,
  quatFromAxisAngle,
  retargetPose,
  type Skeleton,
  WORLD_NODE_FLOATS,
} from '@thunderclap-engine/engine/anim';
import { computeLetterbox } from '@thunderclap-engine/engine/platform';
import type { HarnessRetargetApi, HarnessRetargetState, Vec3 } from './retarget-state';

const LOGICAL = { width: 800, height: 600 };
const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

interface NodeSpec {
  name: string;
  parent: number;
  t: Vec3;
  /** Rest rotation about Z in degrees. */
  rz?: number;
}
type NamedSkeleton = Skeleton & { names: string[] };

function rig(spec: NodeSpec[]): NamedSkeleton {
  const n = spec.length;
  const rest = new Float32Array(n * POSE_NODE_FLOATS);
  const parents = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = spec[i]!;
    const o = i * POSE_NODE_FLOATS;
    parents[i] = s.parent;
    rest.set(s.t, o);
    quatFromAxisAngle(rest, o + 3, 0, 0, 1, ((s.rz ?? 0) * Math.PI) / 180);
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  return { parents, rest, names: spec.map((s) => s.name) };
}

/** A figure: hips, spine, neck, head, two arms along ±X, two legs down. `arm`/`leg` are bone lengths. */
function figure(
  prefix: (n: string) => string,
  hips: number,
  arm: number,
  leg: number,
  rotatedArm: boolean,
): NodeSpec[] {
  const up = rotatedArm ? 90 : 0;
  // With the upper arm turned +90° about Z, "along the bone" is local -Y; the forearm turns back.
  const foreT: Vec3 = rotatedArm ? [0, -arm, 0] : [arm, 0, 0];
  return [
    { name: prefix('Hips'), parent: -1, t: [0, hips, 0] }, // 0
    { name: prefix('Spine'), parent: 0, t: [0, 0.5, 0] }, // 1
    { name: prefix('Neck'), parent: 1, t: [0, 0.3, 0] }, // 2
    { name: prefix('Head'), parent: 2, t: [0, 0.25, 0] }, // 3
    { name: prefix('RightArm'), parent: 1, t: [0.2, 0.25, 0], rz: up }, // 4
    { name: prefix('RightForeArm'), parent: 4, t: foreT, rz: -up }, // 5
    { name: prefix('RightHand'), parent: 5, t: [arm, 0, 0] }, // 6
    { name: prefix('LeftArm'), parent: 1, t: [-0.2, 0.25, 0] }, // 7
    { name: prefix('LeftForeArm'), parent: 7, t: [-arm, 0, 0] }, // 8
    { name: prefix('LeftHand'), parent: 8, t: [-arm, 0, 0] }, // 9
    { name: prefix('RightUpLeg'), parent: 0, t: [0.15, 0, 0] }, // 10
    { name: prefix('RightLeg'), parent: 10, t: [0, -leg, 0] }, // 11
    { name: prefix('RightFoot'), parent: 11, t: [0, -leg, 0] }, // 12
    { name: prefix('LeftUpLeg'), parent: 0, t: [-0.15, 0, 0] }, // 13
    { name: prefix('LeftLeg'), parent: 13, t: [0, -leg, 0] }, // 14
    { name: prefix('LeftFoot'), parent: 14, t: [0, -leg, 0] }, // 15
  ];
}
const snake = (n: string) => n.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

const source = rig(figure((n) => `mixamorig:${n}`, 1, 0.7, 0.5, false));
const target = rig(figure(snake, 1.4, 0.9, 0.7, true));
const ARM = 4;
const FORE_ARM = 5;
const HAND = 6;

/** The wave: the right arm swings up and down about Z, the forearm bends, the hips bob. */
function waveClip(): AnimationClip {
  const keys = 48;
  const duration = 2;
  const times = new Float32Array(keys + 1);
  const armRot = new Float32Array((keys + 1) * 4);
  const foreRot = new Float32Array((keys + 1) * 4);
  const hips = new Float32Array((keys + 1) * 3);
  for (let k = 0; k <= keys; k++) {
    const t = (k / keys) * duration;
    times[k] = t;
    const phase = (t / duration) * Math.PI * 2;
    quatFromAxisAngle(armRot, k * 4, 0, 0, 1, ((40 + 35 * Math.sin(phase)) * Math.PI) / 180);
    quatFromAxisAngle(foreRot, k * 4, 0, 0, 1, (50 * Math.sin(phase * 2) * Math.PI) / 180);
    hips[k * 3] = 0;
    hips[k * 3 + 1] = 1 + 0.06 * Math.sin(phase * 2);
    hips[k * 3 + 2] = 0;
  }
  return {
    name: 'wave',
    duration,
    channels: [
      { node: ARM, path: 'rotation', interpolation: 'LINEAR', times, values: armRot },
      { node: FORE_ARM, path: 'rotation', interpolation: 'LINEAR', times, values: foreRot },
      { node: 0, path: 'translation', interpolation: 'LINEAR', times, values: hips },
    ],
  };
}

const map = createRetargetMap(source, target);
const mixer = new AnimationMixer(source);
mixer.play(waveClip());
const targetPose = new Float32Array(target.rest);
const sourceWorld = new Float32Array(source.parents.length * WORLD_NODE_FLOATS);
const targetWorld = new Float32Array(target.parents.length * WORLD_NODE_FLOATS);

const state: HarnessRetargetState = {
  ready: false,
  ticks: 0,
  time: 0,
  moving: true,
  sourceTipY: 0,
  targetTipY: 0,
  sourceHandDir: [1, 0, 0],
  targetHandDir: [1, 0, 0],
  unmatched: [...map.unmatched],
};

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

const SCALE = 110;
const GROUND = 540;
/** Skeleton-space (x, y) of a figure centred at canvas `cx` to canvas px. */
const project = (cx: number, x: number, y: number) => ({
  x: cx + x * SCALE,
  y: GROUND - y * SCALE,
});

function boneDir(world: Float32Array, from: number, to: number, out: Vec3): void {
  const a = from * WORLD_NODE_FLOATS;
  const b = to * WORLD_NODE_FLOATS;
  const dx = world[b + 3]! - world[a + 3]!;
  const dy = world[b + 7]! - world[a + 7]!;
  const dz = world[b + 11]! - world[a + 11]!;
  const l = Math.hypot(dx, dy, dz) || 1;
  out[0] = dx / l;
  out[1] = dy / l;
  out[2] = dz / l;
}

function drawFigure(sk: Skeleton, world: Float32Array, cx: number, color: string): void {
  if (!g2) return;
  g2.lineWidth = 6;
  g2.lineCap = 'round';
  g2.strokeStyle = color;
  for (let i = 1; i < sk.parents.length; i++) {
    const po = sk.parents[i]! * WORLD_NODE_FLOATS;
    const o = i * WORLD_NODE_FLOATS;
    const a = project(cx, world[po + 3]!, world[po + 7]!);
    const b = project(cx, world[o + 3]!, world[o + 7]!);
    g2.beginPath();
    g2.moveTo(a.x, a.y);
    g2.lineTo(b.x, b.y);
    g2.stroke();
  }
  const head = 3 * WORLD_NODE_FLOATS;
  const h = project(cx, world[head + 3]!, world[head + 7]!);
  g2.fillStyle = color;
  g2.beginPath();
  g2.arc(h.x, h.y, 14, 0, Math.PI * 2);
  g2.fill();
  const hand = HAND * WORLD_NODE_FLOATS;
  const p = project(cx, world[hand + 3]!, world[hand + 7]!);
  g2.fillStyle = '#f0c060';
  g2.beginPath();
  g2.arc(p.x, p.y, 7, 0, Math.PI * 2);
  g2.fill();
}

function draw(): void {
  if (!g2) return;
  g2.fillStyle = '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  g2.strokeStyle = '#2c3548';
  g2.lineWidth = 1;
  g2.beginPath();
  g2.moveTo(0, GROUND);
  g2.lineTo(LOGICAL.width, GROUND);
  g2.stroke();
  drawFigure(source, sourceWorld, 220, '#8fb0e0');
  drawFigure(target, targetWorld, 580, '#c8a060');
}

let last = performance.now();
const tick = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.moving) {
    mixer.update(dt);
    state.time += dt;
  }
  retargetPose(map, mixer.pose, targetPose);
  poseToWorld(source, mixer.pose, sourceWorld);
  poseToWorld(target, targetPose, targetWorld);
  state.sourceTipY = sourceWorld[HAND * WORLD_NODE_FLOATS + 7]!;
  state.targetTipY = targetWorld[HAND * WORLD_NODE_FLOATS + 7]!;
  boneDir(sourceWorld, FORE_ARM, HAND, state.sourceHandDir);
  boneDir(targetWorld, FORE_ARM, HAND, state.targetHandDir);
  state.ticks++;
  draw();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const api: HarnessRetargetApi = {
  state,
  setMoving(moving) {
    state.moving = moving;
  },
};
window.__harnessRetarget = api;
state.ready = true;
