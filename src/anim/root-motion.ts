/**
 * Root motion: split the root node's travel out of a clip so the character animates in place
 * while the game moves its transform by the extracted motion, without guessing at speeds.
 *
 * `extractRootMotion` returns two clips sharing keyframe times: `clip` (in place: the root keeps
 * its first-frame translation and yaw) and `motion` (the root's translation relative to the
 * first frame and its yaw about +Y relative to the first frame). At every keyframe
 * `motion + clip` (translation) and `motion · clip` (rotation) equal the original root transform.
 * `applyRootMotionDelta` samples `motion` at two times and gives the game a position delta in the
 * root's own heading frame plus a yaw delta, handling the loop wrap. Yaw is about +Y (Y up).
 */
import { type AnimationChannel, type AnimationClip, sampleChannel } from './clip';
import { quatMultiply, quatNormalize } from './quat';

export interface RootMotionOptions {
  /**
   * `true`: only the horizontal translation (x, z) moves to `motion`; height and rotation stay in
   * the clip (a hop stays a hop). `false` (default): the whole translation and the yaw about +Y.
   */
  planar?: boolean;
}

export interface RootMotionSplit {
  /** The clip with its root held in place (first-frame translation and yaw). */
  clip: AnimationClip;
  /** The root's travel, relative to the first frame: a translation and, unless planar, a yaw. */
  motion: AnimationClip;
}

/** `[dx, dy, dz, yaw]`: a position delta in the root's heading frame at `t0`, and a yaw delta. */
export type RootMotionDelta = Float32Array;

function copyChannel(ch: AnimationChannel): AnimationChannel {
  return {
    node: ch.node,
    path: ch.path,
    interpolation: ch.interpolation,
    times: new Float32Array(ch.times),
    values: new Float32Array(ch.values),
  };
}

const q = new Float32Array(4);
const twist = new Float32Array(4);
const twist0 = new Float32Array(4);
const conj0 = new Float32Array(4);
const rem = new Float32Array(4);

/** Yaw (rotation about +Y) part of `src[o..o+4)` into `out`, by swing-twist decomposition. */
function yawOf(out: Float32Array, src: ArrayLike<number>, o: number): void {
  out[0] = 0;
  out[1] = src[o + 1]!;
  out[2] = 0;
  out[3] = src[o + 3]!;
  quatNormalize(out, 0);
}

/** Flip `dst` so it sits on the same hemisphere as the key before it (no slerp flips). */
function hemisphere(dst: Float32Array, o: number): void {
  if (o < 4) return;
  const dot =
    dst[o]! * dst[o - 4]! +
    dst[o + 1]! * dst[o - 3]! +
    dst[o + 2]! * dst[o - 2]! +
    dst[o + 3]! * dst[o - 1]!;
  if (dot < 0) for (let i = 0; i < 4; i++) dst[o + i] = -dst[o + i]!;
}

/**
 * Split `clip` into an in-place clip and a motion clip for `rootNode`. Channels are copied, never
 * aliased; the two clips share keyframe times with the input. Translation keeps `CUBICSPLINE`
 * tangents (the in-place side's extracted components get zero tangents); a `CUBICSPLINE`
 * rotation channel on the root comes back as two `LINEAR` channels over its key values. Clips
 * with no root channel yield an empty `motion`. Allocates; call at load time.
 */
export function extractRootMotion(
  clip: AnimationClip,
  rootNode: number,
  opts?: RootMotionOptions,
): RootMotionSplit {
  const planar = opts?.planar ?? false;
  const stay: AnimationChannel[] = [];
  const move: AnimationChannel[] = [];
  for (const ch of clip.channels) {
    if (ch.node !== rootNode || ch.path === 'scale' || ch.path === 'weights') {
      stay.push(copyChannel(ch));
      continue;
    }
    if (ch.path === 'translation') {
      const cubic = ch.interpolation === 'CUBICSPLINE';
      const stride = cubic ? 9 : 3;
      const valueOff = cubic ? 3 : 0;
      const n = ch.times.length;
      const s = new Float32Array(ch.values.length);
      const m = new Float32Array(ch.values.length);
      const src = ch.values;
      for (let k = 0; k < n; k++) {
        const base = k * stride;
        for (let part = 0; part < (cubic ? 3 : 1); part++) {
          const isValue = cubic ? part === 1 : true;
          for (let comp = 0; comp < 3; comp++) {
            const idx = base + part * 3 + comp;
            const extract = !planar || comp !== 1;
            const first = isValue ? src[valueOff + comp]! : 0;
            if (extract) {
              m[idx] = src[idx]! - first;
              s[idx] = first;
            } else {
              m[idx] = 0;
              s[idx] = src[idx]!;
            }
          }
        }
      }
      stay.push({ ...copyChannel(ch), values: s });
      move.push({ ...copyChannel(ch), values: m });
      continue;
    }
    // Rotation.
    if (planar) {
      stay.push(copyChannel(ch));
      continue;
    }
    const cubic = ch.interpolation === 'CUBICSPLINE';
    const n = ch.times.length;
    const s = new Float32Array(n * 4);
    const m = new Float32Array(n * 4);
    const src = ch.values;
    if (n > 0) yawOf(twist0, src, cubic ? 4 : 0);
    conj0[0] = -twist0[0]!;
    conj0[1] = -twist0[1]!;
    conj0[2] = -twist0[2]!;
    conj0[3] = twist0[3]!;
    for (let k = 0; k < n; k++) {
      const vo = cubic ? k * 12 + 4 : k * 4;
      for (let i = 0; i < 4; i++) q[i] = src[vo + i]!;
      yawOf(twist, q, 0);
      // q = twist · rem  →  rem = conj(twist) · q.
      rem[0] = -twist[0]!;
      rem[1] = -twist[1]!;
      rem[2] = -twist[2]!;
      rem[3] = twist[3]!;
      quatMultiply(rem, 0, rem, 0, q, 0);
      // motion = twist · conj(twist0); stay = twist0 · rem; motion · stay = twist · rem = q.
      quatMultiply(m, k * 4, twist, 0, conj0, 0);
      quatMultiply(s, k * 4, twist0, 0, rem, 0);
      quatNormalize(m, k * 4);
      quatNormalize(s, k * 4);
      hemisphere(m, k * 4);
      hemisphere(s, k * 4);
    }
    const interpolation = cubic ? 'LINEAR' : ch.interpolation;
    const times = new Float32Array(ch.times);
    stay.push({ node: ch.node, path: 'rotation', interpolation, times, values: s });
    move.push({
      node: ch.node,
      path: 'rotation',
      interpolation,
      times: new Float32Array(times),
      values: m,
    });
  }
  const inPlace: AnimationClip = { name: clip.name, duration: clip.duration, channels: stay };
  if (clip.events) inPlace.events = clip.events.map((e) => ({ ...e }));
  return {
    clip: inPlace,
    motion: { name: `${clip.name}.motion`, duration: clip.duration, channels: move },
  };
}

const p0 = new Float32Array(3);
const p1 = new Float32Array(3);
const r0 = new Float32Array(4);
const r1 = new Float32Array(4);
const seg = new Float32Array(4);

/** Yaw angle (radians, about +Y) of a rotation channel at `t`, 0 without a channel. */
function yawAt(ch: AnimationChannel | null, t: number, out: Float32Array): number {
  if (!ch) return 0;
  sampleChannel(ch, t, out, 0);
  return 2 * Math.atan2(out[1]!, out[3]!);
}

function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** One forward segment `t0 → t1` into `out`: the position delta in the heading frame at `t0`, yaw delta. */
function segment(
  tr: AnimationChannel | null,
  rot: AnimationChannel | null,
  t0: number,
  t1: number,
  out: Float32Array,
): void {
  if (tr) {
    sampleChannel(tr, t0, p0, 0);
    sampleChannel(tr, t1, p1, 0);
  } else {
    p0.fill(0);
    p1.fill(0);
  }
  const y0 = yawAt(rot, t0, r0);
  const y1 = yawAt(rot, t1, r1);
  const dx = p1[0]! - p0[0]!;
  const dy = p1[1]! - p0[1]!;
  const dz = p1[2]! - p0[2]!;
  // Undo the heading at t0: rotate by -y0 about +Y.
  const c = Math.cos(-y0);
  const s = Math.sin(-y0);
  out[0] = dx * c + dz * s;
  out[1] = dy;
  out[2] = -dx * s + dz * c;
  out[3] = wrapAngle(y1 - y0);
}

/**
 * The root's motion between `t0` and `t1` of a `motion` clip, into `outDelta` (4 floats):
 * `[dx, dy, dz]` is the position delta expressed in the root's heading frame at `t0` (the motion
 * clip's yaw there, zero at the first key: rotate the delta by the character's own heading, then
 * add it to the position) and `[3]` is the yaw delta in radians about +Y (add it to the
 * heading). When `t1 < t0` the clip has looped: the
 * delta runs `t0 → duration` then `0 → t1`. Returns `outDelta`. No allocation.
 */
export function applyRootMotionDelta(
  motionClip: AnimationClip,
  t0: number,
  t1: number,
  outDelta: Float32Array,
): Float32Array {
  let tr: AnimationChannel | null = null;
  let rot: AnimationChannel | null = null;
  for (const ch of motionClip.channels) {
    if (ch.path === 'translation' && !tr) tr = ch;
    else if (ch.path === 'rotation' && !rot) rot = ch;
  }
  if (t1 >= t0) {
    segment(tr, rot, t0, t1, outDelta);
    return outDelta;
  }
  segment(tr, rot, t0, motionClip.duration, outDelta);
  segment(tr, rot, 0, t1, seg);
  // The second segment is in the heading frame at 0; bring it into the frame at t0 by the yaw
  // the first segment turned.
  const c = Math.cos(outDelta[3]!);
  const s = Math.sin(outDelta[3]!);
  outDelta[0] = outDelta[0]! + seg[0]! * c + seg[2]! * s;
  outDelta[1] = outDelta[1]! + seg[1]!;
  outDelta[2] = outDelta[2]! - seg[0]! * s + seg[2]! * c;
  outDelta[3] = wrapAngle(outDelta[3]! + seg[3]!);
  return outDelta;
}
