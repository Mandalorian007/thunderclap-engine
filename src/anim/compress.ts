/**
 * Clip compression: fewer keyframes and smaller ones, so a wardrobe of animations fits.
 *
 * `compressClip` keeps, per channel, only the keys a linear fit cannot reproduce within a
 * tolerance (Ramer–Douglas–Peucker over the sampled curve: start from the two end keys, add
 * the key with the largest error until every dropped key is within tolerance), collapses a
 * channel whose keys never change to one key and drops it entirely when that value is the
 * skeleton's rest (with `skeleton`). `quantizeClip` packs rotation keys into three `uint16`
 * per key (smallest-three, `AnimationChannel.packed`), which `sampleChannel` reads directly.
 * Both allocate (they build new clips); call them at load or in a bake step. `CUBICSPLINE`
 * channels are copied unchanged by both.
 */
import { type AnimationChannel, type AnimationClip, channelComponents, unpackQuat } from './clip';
import { POSE_NODE_FLOATS, type Skeleton } from './pose';

export interface CompressClipOptions {
  /** Largest translation error a dropped key may introduce (units). Default 1e-3. */
  positionError?: number;
  /** Largest rotation error a dropped key may introduce (radians). Default 1e-3. */
  rotationError?: number;
  /** Largest scale error a dropped key may introduce. Default 1e-3. */
  scaleError?: number;
  /** Largest morph-weight error a dropped key may introduce. Default 1e-3. */
  weightError?: number;
  /**
   * Collapse a channel whose keys never change (within the tolerance) to a single key, and
   * drop it when that value is the node's rest in `skeleton`. Default true.
   */
  dropConstant?: boolean;
  /** The skeleton whose rest decides which constant channels are redundant. */
  skeleton?: Skeleton;
}

/** `compressClip`'s result: the new clip and the keyframe bytes before and after. */
export interface CompressedClip {
  clip: AnimationClip;
  /** Bytes of `times` + `values` (+ `packed`) over the input's channels. */
  before: number;
  /** The same over the output's channels. */
  after: number;
}

export interface QuantizeClipOptions {
  /** `'smallest-three'` packs `STEP`/`LINEAR` rotation channels; `'none'` copies. */
  rotation: 'smallest-three' | 'none';
}

/** Keyframe bytes of a clip: `times`, `values` and `packed` over every channel. */
export function clipBytes(clip: AnimationClip): number {
  let bytes = 0;
  for (const ch of clip.channels) {
    bytes += ch.times.byteLength + ch.values.byteLength + (ch.packed?.byteLength ?? 0);
  }
  return bytes;
}

const qa = new Float32Array(4);
const qb = new Float32Array(4);

/**
 * The angle between two unit quaternions at `values[a..]` and `values[b..]`, from the chord
 * (`2·asin(|q₁ ∓ q₂| / 2)`), which keeps its precision near zero where `acos(dot)` does not.
 */
function quatAngle(values: ArrayLike<number>, a: number, b: number): number {
  const dot =
    values[a]! * values[b]! +
    values[a + 1]! * values[b + 1]! +
    values[a + 2]! * values[b + 2]! +
    values[a + 3]! * values[b + 3]!;
  const s = dot < 0 ? -1 : 1;
  const dx = values[a]! - s * values[b]!;
  const dy = values[a + 1]! - s * values[b + 1]!;
  const dz = values[a + 2]! - s * values[b + 2]!;
  const dw = values[a + 3]! - s * values[b + 3]!;
  return 2 * Math.asin(Math.min(1, Math.hypot(dx, dy, dz, dw) / 2));
}

/** Largest absolute component gap between keys `a` and `b` (`comps` each). */
function maxGap(values: Float32Array, a: number, b: number, comps: number): number {
  let m = 0;
  for (let i = 0; i < comps; i++) m = Math.max(m, Math.abs(values[a + i]! - values[b + i]!));
  return m;
}

/**
 * The error of key `k` against the linear (slerp for rotations) fit between keys `i` and `j`.
 */
function fitError(ch: AnimationChannel, comps: number, i: number, j: number, k: number): number {
  const times = ch.times;
  const values = ch.values;
  const span = times[j]! - times[i]!;
  const u = span > 0 ? (times[k]! - times[i]!) / span : 0;
  const rotation = ch.path === 'rotation';
  if (ch.interpolation === 'STEP') {
    // A step channel holds key i until key j: the dropped key must equal key i.
    return rotation
      ? quatAngle(values, i * comps, k * comps)
      : maxGap(values, i * comps, k * comps, comps);
  }
  if (rotation) {
    slerpInto(qa, values, i * comps, values, j * comps, u);
    for (let c = 0; c < 4; c++) qb[c] = values[k * comps + c]!;
    return angleBetween(qa, qb);
  }
  let m = 0;
  for (let c = 0; c < comps; c++) {
    const fit = (1 - u) * values[i * comps + c]! + u * values[j * comps + c]!;
    m = Math.max(m, Math.abs(fit - values[k * comps + c]!));
  }
  return m;
}

function angleBetween(a: Float32Array, b: Float32Array): number {
  for (let i = 0; i < 4; i++) qab[i] = a[i]!;
  for (let i = 0; i < 4; i++) qab[4 + i] = b[i]!;
  return quatAngle(qab, 0, 4);
}
const qab = new Float64Array(8);

/** Shortest-arc slerp of two quaternions (no dependence on `quat.ts` scratch). */
function slerpInto(
  out: Float32Array,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  t: number,
): void {
  let bx = b[bo]!;
  let by = b[bo + 1]!;
  let bz = b[bo + 2]!;
  let bw = b[bo + 3]!;
  let cos = a[ao]! * bx + a[ao + 1]! * by + a[ao + 2]! * bz + a[ao + 3]! * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  out[0] = s0 * a[ao]! + s1 * bx;
  out[1] = s0 * a[ao + 1]! + s1 * by;
  out[2] = s0 * a[ao + 2]! + s1 * bz;
  out[3] = s0 * a[ao + 3]! + s1 * bw;
  const len = Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!) || 1;
  for (let i = 0; i < 4; i++) out[i] = out[i]! / len;
}

function toleranceOf(ch: AnimationChannel, opts: CompressClipOptions): number {
  switch (ch.path) {
    case 'translation':
      return opts.positionError ?? 1e-3;
    case 'rotation':
      return opts.rotationError ?? 1e-3;
    case 'scale':
      return opts.scaleError ?? 1e-3;
    default:
      return opts.weightError ?? 1e-3;
  }
}

/** Keys of `ch` (STEP or LINEAR) to keep, ascending, by RDP within `tol`. */
function keepKeys(ch: AnimationChannel, comps: number, tol: number): number[] {
  const n = ch.times.length;
  if (n <= 2) {
    const all: number[] = [];
    for (let i = 0; i < n; i++) all.push(i);
    return all;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j - i < 2) continue;
    let worst = -1;
    let worstErr = tol;
    for (let k = i + 1; k < j; k++) {
      const e = fitError(ch, comps, i, j, k);
      if (e > worstErr) {
        worstErr = e;
        worst = k;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(i, worst, worst, j);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Whether every key of `ch` equals its first within `tol`. */
function isConstant(ch: AnimationChannel, comps: number, tol: number): boolean {
  const n = ch.times.length;
  for (let k = 1; k < n; k++) {
    const e =
      ch.path === 'rotation'
        ? quatAngle(ch.values, 0, k * comps)
        : maxGap(ch.values, 0, k * comps, comps);
    if (e > tol) return false;
  }
  return true;
}

/** Whether key 0 of `ch` is the node's rest value within `tol`. */
function isRest(ch: AnimationChannel, tol: number, skeleton: Skeleton): boolean {
  const n = skeleton.parents.length;
  if (ch.node < 0 || ch.node >= n) return false;
  const o = ch.node * POSE_NODE_FLOATS;
  const rest = skeleton.rest;
  switch (ch.path) {
    case 'translation':
      return (
        Math.abs(ch.values[0]! - rest[o]!) <= tol &&
        Math.abs(ch.values[1]! - rest[o + 1]!) <= tol &&
        Math.abs(ch.values[2]! - rest[o + 2]!) <= tol
      );
    case 'rotation': {
      for (let i = 0; i < 4; i++) qa[i] = rest[o + 3 + i]!;
      for (let i = 0; i < 4; i++) qb[i] = ch.values[i]!;
      return angleBetween(qa, qb) <= tol;
    }
    case 'scale':
      return (
        Math.abs(ch.values[0]! - rest[o + 7]!) <= tol &&
        Math.abs(ch.values[1]! - rest[o + 8]!) <= tol &&
        Math.abs(ch.values[2]! - rest[o + 9]!) <= tol
      );
    default:
      return false;
  }
}

/**
 * A copy of `clip` with the keys a linear fit reproduces within tolerance removed, constant
 * channels collapsed (and dropped when they equal the rest of `skeleton`), and the keyframe
 * byte counts before and after. Packed channels are decoded first; `CUBICSPLINE` channels and
 * events are copied as they are. Allocates.
 */
export function compressClip(clip: AnimationClip, opts: CompressClipOptions = {}): CompressedClip {
  const dropConstant = opts.dropConstant ?? true;
  const channels: AnimationChannel[] = [];
  for (const src of clip.channels) {
    const ch = src.packed ? unpackChannel(src) : src;
    const comps = channelComponents(ch);
    const n = ch.times.length;
    if (ch.interpolation === 'CUBICSPLINE' || n === 0 || comps === 0) {
      channels.push({ ...ch, times: ch.times.slice(), values: ch.values.slice() });
      continue;
    }
    const tol = toleranceOf(ch, opts);
    if (dropConstant && isConstant(ch, comps, tol)) {
      if (opts.skeleton && isRest(ch, tol, opts.skeleton)) continue;
      channels.push({
        node: ch.node,
        path: ch.path,
        interpolation: 'STEP',
        times: new Float32Array([ch.times[0]!]),
        values: ch.values.slice(0, comps),
      });
      continue;
    }
    const keys = keepKeys(ch, comps, tol);
    const times = new Float32Array(keys.length);
    const values = new Float32Array(keys.length * comps);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      times[i] = ch.times[k]!;
      for (let c = 0; c < comps; c++) values[i * comps + c] = ch.values[k * comps + c]!;
    }
    channels.push({ node: ch.node, path: ch.path, interpolation: ch.interpolation, times, values });
  }
  const out: AnimationClip = { name: clip.name, duration: clip.duration, channels };
  if (clip.events) out.events = clip.events.map((e) => ({ ...e }));
  return { clip: out, before: clipBytes(clip), after: clipBytes(out) };
}

/** A float copy of a packed rotation channel. */
function unpackChannel(ch: AnimationChannel): AnimationChannel {
  const n = ch.times.length;
  const values = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) unpackQuat(ch.packed!, k, values, k * 4);
  return { node: ch.node, path: ch.path, interpolation: ch.interpolation, times: ch.times, values };
}

const PACK_SCALE = 32767 / Math.SQRT2;

/**
 * Encode the unit quaternion at `q[o..o+4)` as three `uint16` at `out[b..b+3)` in the
 * smallest-three form `unpackQuat` decodes: the quaternion is flipped so its largest
 * component is positive, that component's index goes to bit 15 of words 0 and 1, and the
 * other three components, each within ±1/√2, fill the low 15 bits of the words in order.
 */
export function packQuat(q: ArrayLike<number>, o: number, out: Uint16Array, b: number): void {
  let largest = 0;
  let mag = 0;
  for (let i = 0; i < 4; i++) {
    const a = Math.abs(q[o + i]!);
    if (a > mag) {
      mag = a;
      largest = i;
    }
  }
  const sign = q[o + largest]! < 0 ? -1 : 1;
  let w = 0;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    let c = q[o + i]! * sign;
    c = Math.min(Math.SQRT1_2, Math.max(-Math.SQRT1_2, c));
    let bits = Math.round((c + Math.SQRT1_2) * PACK_SCALE);
    bits = Math.min(0x7fff, Math.max(0, bits));
    if (w === 0) bits |= (largest >> 1) << 15;
    else if (w === 1) bits |= (largest & 1) << 15;
    out[b + w] = bits;
    w++;
  }
}

/**
 * A copy of `clip` whose `STEP`/`LINEAR` rotation channels carry `packed` keys (three
 * `uint16` each, `packQuat`) and an empty `values`; other channels are copied. `'none'`
 * copies everything. Allocates.
 */
export function quantizeClip(clip: AnimationClip, opts: QuantizeClipOptions): AnimationClip {
  const channels: AnimationChannel[] = [];
  for (const src of clip.channels) {
    const packable =
      opts.rotation === 'smallest-three' &&
      src.path === 'rotation' &&
      src.interpolation !== 'CUBICSPLINE';
    if (!packable) {
      const ch: AnimationChannel = { ...src, times: src.times.slice(), values: src.values.slice() };
      if (src.packed) ch.packed = src.packed.slice();
      channels.push(ch);
      continue;
    }
    if (src.packed) {
      channels.push({
        ...src,
        times: src.times.slice(),
        values: new Float32Array(0),
        packed: src.packed.slice(),
      });
      continue;
    }
    const n = src.times.length;
    const packed = new Uint16Array(n * 3);
    for (let k = 0; k < n; k++) packQuat(src.values, k * 4, packed, k * 3);
    channels.push({
      node: src.node,
      path: src.path,
      interpolation: src.interpolation,
      times: src.times.slice(),
      values: new Float32Array(0),
      packed,
    });
  }
  const out: AnimationClip = { name: clip.name, duration: clip.duration, channels };
  if (clip.events) out.events = clip.events.map((e) => ({ ...e }));
  return out;
}
