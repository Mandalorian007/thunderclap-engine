/**
 * The CPU twin of the pose pass (`ACTOR_POSE_WGSL`): the same baked frames, the same blend
 * (lerp for translation and scale, sign-corrected nlerp for rotation), the same hierarchy and
 * the same actor placement. For picking, attachments and the parity tests; nothing allocates.
 */
import { ACTOR_NONE, ACTOR_RECORD as R } from './record';
import { ACTOR_TRS_FLOATS, type ActorRig, type BakedClip } from './rig';

/** Scratch for `poseRecord`, sized for `nodes` nodes. */
export interface PoseScratch {
  /** One TRS per node, then one for the second layer's sample. */
  trs: Float32Array;
  layer: Float32Array;
  /** World 3×4 per node. */
  world: Float32Array;
  local: Float32Array;
  actor: Float32Array;
}

export function createPoseScratch(nodes: number): PoseScratch {
  return {
    trs: new Float32Array(nodes * ACTOR_TRS_FLOATS),
    layer: new Float32Array(ACTOR_TRS_FLOATS),
    world: new Float32Array(nodes * 12),
    local: new Float32Array(12),
    actor: new Float32Array(12),
  };
}

/** `out[o..o+10)` = mix of TRS `a[ao..]` and `b[bo..]` by `w` (`out` may be `a`). */
function mixTrs(
  out: Float32Array,
  o: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  w: number,
): void {
  const s = 1 - w;
  for (let k = 0; k < 3; k++) out[o + k] = a[ao + k]! * s + b[bo + k]! * w;
  for (let k = 7; k < 10; k++) out[o + k] = a[ao + k]! * s + b[bo + k]! * w;
  let d = 0;
  for (let k = 3; k < 7; k++) d += a[ao + k]! * b[bo + k]!;
  const wb = d < 0 ? -w : w;
  let len = 0;
  for (let k = 3; k < 7; k++) {
    const q = a[ao + k]! * s + b[bo + k]! * wb;
    out[o + k] = q;
    len += q * q;
  }
  const inv = len > 0 ? 1 / Math.sqrt(len) : 0;
  for (let k = 3; k < 7; k++) out[o + k] = out[o + k]! * inv;
}

/** Sample node `node` of `clip` at `phase` seconds into `out[o..]` (the shader's `sampleLayer`). */
function sampleLayer(
  clip: BakedClip,
  phase: number,
  node: number,
  nodes: number,
  out: Float32Array,
  o: number,
): void {
  const n = clip.frameCount;
  let f = phase * clip.fps;
  let i0: number;
  let i1: number;
  if (clip.loop) {
    f -= Math.floor(f / n) * n;
    i0 = Math.min(Math.floor(f), n - 1);
    i1 = i0 + 1 >= n ? 0 : i0 + 1;
  } else {
    f = Math.min(Math.max(f, 0), n - 1);
    i0 = Math.min(Math.floor(f), n - 1);
    i1 = Math.min(i0 + 1, n - 1);
  }
  const a = f - i0;
  const fr = clip.frames;
  mixTrs(
    out,
    o,
    fr,
    (i0 * nodes + node) * ACTOR_TRS_FLOATS,
    fr,
    (i1 * nodes + node) * ACTOR_TRS_FLOATS,
    a,
  );
}

/** 3×4 row-major `T·R·S` of the TRS at `t[to..]` into `m[mo..]` (as `anim`'s `writeNodeMatrix`). */
function trsMatrix(m: Float32Array, mo: number, t: ArrayLike<number>, to: number): void {
  const x = t[to + 3]!;
  const y = t[to + 4]!;
  const z = t[to + 5]!;
  const w = t[to + 6]!;
  const sx = t[to + 7]!;
  const sy = t[to + 8]!;
  const sz = t[to + 9]!;
  m[mo] = (1 - 2 * (y * y + z * z)) * sx;
  m[mo + 1] = 2 * (x * y - w * z) * sy;
  m[mo + 2] = 2 * (x * z + w * y) * sz;
  m[mo + 3] = t[to]!;
  m[mo + 4] = 2 * (x * y + w * z) * sx;
  m[mo + 5] = (1 - 2 * (x * x + z * z)) * sy;
  m[mo + 6] = 2 * (y * z - w * x) * sz;
  m[mo + 7] = t[to + 1]!;
  m[mo + 8] = 2 * (x * z - w * y) * sx;
  m[mo + 9] = 2 * (y * z + w * x) * sy;
  m[mo + 10] = (1 - 2 * (x * x + y * y)) * sz;
  m[mo + 11] = t[to + 2]!;
}

/** `out[oo..] = a[ao..] · b[bo..]` (3×4 affine; `out` may alias `b` but not `a`). */
function mul(
  out: Float32Array,
  oo: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): void {
  const b0 = b[bo]!;
  const b1 = b[bo + 1]!;
  const b2 = b[bo + 2]!;
  const b3 = b[bo + 3]!;
  const b4 = b[bo + 4]!;
  const b5 = b[bo + 5]!;
  const b6 = b[bo + 6]!;
  const b7 = b[bo + 7]!;
  const b8 = b[bo + 8]!;
  const b9 = b[bo + 9]!;
  const b10 = b[bo + 10]!;
  const b11 = b[bo + 11]!;
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4]!;
    const a1 = a[ao + r * 4 + 1]!;
    const a2 = a[ao + r * 4 + 2]!;
    const a3 = a[ao + r * 4 + 3]!;
    out[oo + r * 4] = a0 * b0 + a1 * b4 + a2 * b8;
    out[oo + r * 4 + 1] = a0 * b1 + a1 * b5 + a2 * b9;
    out[oo + r * 4 + 2] = a0 * b2 + a1 * b6 + a2 * b10;
    out[oo + r * 4 + 3] = a0 * b3 + a1 * b7 + a2 * b11 + a3;
  }
}

/** The actor's placement: `T(position + velocity·(time − since)) · Ry(yaw) · S(scale)`. */
export function actorMatrix(
  f32: Float32Array,
  base: number,
  time: number,
  out: Float32Array,
  o = 0,
): void {
  const dt = time - f32[base + R.since]!;
  const c = Math.cos(f32[base + R.yaw]!);
  const s = Math.sin(f32[base + R.yaw]!);
  const k = f32[base + R.scale]!;
  out[o] = c * k;
  out[o + 1] = 0;
  out[o + 2] = s * k;
  out[o + 3] = f32[base + R.x]! + f32[base + R.vx]! * dt;
  out[o + 4] = 0;
  out[o + 5] = k;
  out[o + 6] = 0;
  out[o + 7] = f32[base + R.y]! + f32[base + R.vy]! * dt;
  out[o + 8] = -s * k;
  out[o + 9] = 0;
  out[o + 10] = c * k;
  out[o + 11] = f32[base + R.z]! + f32[base + R.vz]! * dt;
}

/**
 * Pose the record at word `base` of `f32`/`u32` with `rig` at `time`. `space: 'world'` writes
 * one world matrix per node (12 floats each, actor placement included: attachments and
 * picking); `'skin'` writes one skin matrix per joint (world × inverse bind: what the GPU
 * pass writes to the bone buffer).
 */
export function poseRecord(
  rig: ActorRig,
  f32: Float32Array,
  u32: Uint32Array,
  base: number,
  time: number,
  scratch: PoseScratch,
  out: Float32Array,
  space: 'world' | 'skin',
): void {
  const nodes = rig.nodes;
  const trs = scratch.trs;
  const clips = rig.clips;
  const c0 = u32[base + R.clip]!;
  const c1 = u32[base + R.clip2]!;
  const blend = Math.min(f32[base + R.blend]!, 1);
  const p0 = (time - f32[base + R.clipStart]!) * f32[base + R.clipRate]!;
  const p1 = (time - f32[base + R.clip2Start]!) * f32[base + R.clip2Rate]!;
  for (let b = 0; b < nodes; b++) {
    const o = b * ACTOR_TRS_FLOATS;
    if (c0 !== ACTOR_NONE && c0 < clips.length) sampleLayer(clips[c0]!, p0, b, nodes, trs, o);
    else for (let k = 0; k < ACTOR_TRS_FLOATS; k++) trs[o + k] = rig.rest[o + k]!;
    if (c1 !== ACTOR_NONE && c1 < clips.length && blend > 0) {
      sampleLayer(clips[c1]!, p1, b, nodes, scratch.layer, 0);
      mixTrs(trs, o, trs, o, scratch.layer, 0, blend);
    }
  }
  const world = space === 'world' ? out : scratch.world;
  actorMatrix(f32, base, time, scratch.actor);
  for (let b = 0; b < nodes; b++) {
    trsMatrix(scratch.local, 0, trs, b * ACTOR_TRS_FLOATS);
    const p = rig.parents[b]!;
    if (p < 0) mul(world, b * 12, scratch.actor, 0, scratch.local, 0);
    else mul(world, b * 12, world, p * 12, scratch.local, 0);
  }
  if (space === 'world') return;
  for (let j = 0; j < rig.joints; j++) {
    mul(out, j * 12, world, rig.jointNodes[j]! * 12, rig.inverseBind, j * 12);
  }
}
