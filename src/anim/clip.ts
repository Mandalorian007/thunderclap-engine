/**
 * Keyframe clips with glTF sampler semantics, sampled into a `Pose`.
 *
 * A channel is one glTF animation sampler + target: `times` (seconds, ascending) and `values`
 * (packed components per key: 3 for translation and scale, 4 for rotation, N for morph
 * `weights`). `CUBICSPLINE` stores three vectors per key: in-tangent, value, out-tangent
 * (glTF order). Outside `[times[0], times[last]]` the first or last value holds; looping is the
 * mixer's job.
 *
 * Sampling keeps a per-channel keyframe cursor (`ClipCursor`, one `Uint32Array` per clip, or one
 * per playing action in the mixer) so a time that moves forward costs O(1) amortised; a jump
 * falls back to a binary search. Nothing allocates per call.
 */

import { POSE_NODE_FLOATS, type Pose } from './pose';
import { quatIdentity, quatMultiply, quatNormalize, quatSlerp } from './quat';

export type ChannelPath = 'translation' | 'rotation' | 'scale' | 'weights';
export type Interpolation = 'STEP' | 'LINEAR' | 'CUBICSPLINE';

export interface AnimationChannel {
  /** Target node index (into the skeleton / pose). */
  node: number;
  path: ChannelPath;
  interpolation: Interpolation;
  /** Keyframe times in seconds, ascending. */
  times: Float32Array;
  /**
   * Packed values: `times.length × components` floats, or `× 3` for `CUBICSPLINE`
   * (in-tangent, value, out-tangent per key).
   */
  values: Float32Array;
  /**
   * Quantised rotation keys from `quantizeClip` (`compress.ts`): three `uint16` per key in
   * smallest-three form (`unpackQuat`), read instead of `values` when present. Only on
   * `rotation` channels with `STEP` or `LINEAR` interpolation.
   */
  packed?: Uint16Array;
}

/** A named time in a clip; the mixer reports each crossing through `onEvent`. */
export interface AnimationEvent {
  time: number;
  name: string;
}

export interface AnimationClip {
  name: string;
  /** Seconds. Normally `max(times)` over the channels; the mixer loops at it. */
  duration: number;
  channels: AnimationChannel[];
  events?: AnimationEvent[];
}

/** Keyframe cursor per channel, see `createClipCursor`. */
export type ClipCursor = Uint32Array;

/** How `sampleClip` writes into the pose. */
export type BlendMode = 'override' | 'additive';

/** Components per key of a channel (3, 4, or the morph weight count). */
export function channelComponents(channel: AnimationChannel): number {
  switch (channel.path) {
    case 'translation':
    case 'scale':
      return 3;
    case 'rotation':
      return 4;
    default: {
      const keys = channel.times.length;
      if (keys === 0) return 0;
      const per = channel.values.length / keys;
      return channel.interpolation === 'CUBICSPLINE' ? per / 3 : per;
    }
  }
}

/** A clip whose `duration` is the last keyframe time over its channels (0 when empty). */
export function clipDuration(channels: readonly AnimationChannel[]): number {
  let d = 0;
  for (const c of channels) {
    const n = c.times.length;
    if (n > 0) d = Math.max(d, c.times[n - 1]!);
  }
  return d;
}

/** A fresh cursor for `clip` (one slot per channel). */
export function createClipCursor(clip: AnimationClip): ClipCursor {
  return new Uint32Array(Math.max(1, clip.channels.length));
}

const cursors = new WeakMap<AnimationClip, ClipCursor>();
function cursorFor(clip: AnimationClip): ClipCursor {
  let c = cursors.get(clip);
  if (!c || c.length < clip.channels.length) {
    c = createClipCursor(clip);
    cursors.set(clip, c);
  }
  return c;
}

/**
 * Index `k` with `times[k] <= t < times[k+1]`, clamped to `[0, n-2]` (`0` for one key). Checks
 * the hint and the key after it first, then binary-searches.
 */
export function findKeyframe(times: Float32Array, t: number, hint: number): number {
  const n = times.length;
  if (n < 2) return 0;
  const last = n - 2;
  const h = Math.min(hint, last);
  if (times[h]! <= t) {
    if (t < times[h + 1]!) return h;
    if (h < last && times[h + 1]! <= t && t < times[h + 2]!) return h + 1;
    if (h === last) return last;
  }
  if (t >= times[n - 1]!) return last;
  if (t <= times[0]!) return 0;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Sample one channel at time `t` into `out[o..o+components)`. Rotations are slerped (`LINEAR`)
 * or normalised (`CUBICSPLINE`). `cursor[ci]` (optional) is the keyframe hint, updated in place.
 */
export function sampleChannel(
  channel: AnimationChannel,
  t: number,
  out: Float32Array,
  o: number,
  cursor?: Uint32Array,
  ci = 0,
): void {
  const times = channel.times;
  const n = times.length;
  const comps = channelComponents(channel);
  if (n === 0 || comps === 0) return;
  const cubic = channel.interpolation === 'CUBICSPLINE';
  const stride = cubic ? comps * 3 : comps;
  const k = findKeyframe(times, t, cursor ? cursor[ci]! : 0);
  if (cursor) cursor[ci] = k;
  const packed = channel.packed;
  let values = channel.values;
  let base0 = k * stride + (cubic ? comps : 0);
  let base1 = (k + 1) * stride + (cubic ? comps : 0);
  if (packed && channel.path === 'rotation' && !cubic) {
    // Packed keys: decode the two around `t` into scratch and sample from there.
    unpackQuat(packed, k, unpacked, 0);
    if (n > 1) unpackQuat(packed, k + 1, unpacked, 4);
    values = unpacked;
    base0 = 0;
    base1 = 4;
  }
  const t0 = times[k]!;
  const t1 = n > 1 ? times[k + 1]! : t0;
  if (n > 1 && t >= t1) {
    // At or past the last key (k is clamped to n-2): hold the last value.
    for (let i = 0; i < comps; i++) out[o + i] = values[base1 + i]!;
    return;
  }
  if (n === 1 || t <= t0 || channel.interpolation === 'STEP') {
    for (let i = 0; i < comps; i++) out[o + i] = values[base0 + i]!;
    return;
  }
  const td = t1 - t0;
  const u = (t - t0) / td;
  if (cubic) {
    // glTF: p(u) = h00·v0 + h10·td·b0 + h01·v1 + h11·td·a1 (a = in-tangent, b = out-tangent).
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = (u3 - 2 * u2 + u) * td;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = (u3 - u2) * td;
    const v0 = k * stride + comps;
    const b0 = v0 + comps;
    const a1 = (k + 1) * stride;
    const v1 = a1 + comps;
    for (let i = 0; i < comps; i++) {
      out[o + i] =
        h00 * values[v0 + i]! +
        h10 * values[b0 + i]! +
        h01 * values[v1 + i]! +
        h11 * values[a1 + i]!;
    }
    if (channel.path === 'rotation') quatNormalize(out, o);
    return;
  }
  if (channel.path === 'rotation') {
    quatSlerp(out, o, values, base0, values, base1, u);
    return;
  }
  const s = 1 - u;
  for (let i = 0; i < comps; i++) out[o + i] = s * values[base0 + i]! + u * values[base1 + i]!;
}

const sample = new Float32Array(4);
const delta = new Float32Array(4);
const unpacked = new Float32Array(8);

/** Scale of a 15-bit smallest-three component: the range is ±1/√2. */
const PACK_SCALE = 32767 / Math.SQRT2;

/**
 * Decode key `key` of a smallest-three packed rotation (`AnimationChannel.packed`) into
 * `out[o..o+4)`. Each key is three `uint16`: bits 0..14 hold the three smaller components as
 * `round((c + 1/√2) × 32767/√2)`; bit 15 of words 0 and 1 hold the index of the largest
 * component, which is rebuilt as `sqrt(1 − Σc²)` (the quaternion was flipped to make it
 * positive). No allocation.
 */
export function unpackQuat(packed: Uint16Array, key: number, out: Float32Array, o: number): void {
  const b = key * 3;
  const w0 = packed[b]!;
  const w1 = packed[b + 1]!;
  const w2 = packed[b + 2]!;
  const largest = ((w0 >> 15) << 1) | (w1 >> 15);
  const a = (w0 & 0x7fff) / PACK_SCALE - Math.SQRT1_2;
  const c = (w1 & 0x7fff) / PACK_SCALE - Math.SQRT1_2;
  const d = (w2 & 0x7fff) / PACK_SCALE - Math.SQRT1_2;
  const rest = 1 - a * a - c * c - d * d;
  const big = rest > 0 ? Math.sqrt(rest) : 0;
  // The three small components fill the slots other than `largest`, in order.
  const s0 = largest === 0 ? 1 : 0;
  const s1 = largest <= 1 ? 2 : 1;
  const s2 = largest === 3 ? 2 : 3;
  out[o + largest] = big;
  out[o + s0] = a;
  out[o + s1] = c;
  out[o + s2] = d;
}

/**
 * Sample every channel of `clip` at `t` into `pose`.
 *
 * - `'override'`: each animated component becomes `lerp(pose, sampled, weight)` (slerp for
 *   rotations); `weight` 1 writes the value outright.
 * - `'additive'`: the clip's values are deltas. Translation adds `weight × v`, scale multiplies
 *   by `lerp(1, v, weight)`, rotation post-multiplies `slerp(identity, q, weight)`. A "floating"
 *   idle on top of a walk is one additive channel on the root.
 *
 * `'weights'` (morph) channels are skipped: a pose has no morph slots; sample them with
 * `sampleWeights`. A channel whose node is outside the pose is skipped. `cursor` defaults to a
 * cursor shared per clip; pass your own when one clip plays at two times at once (the mixer
 * does). No allocation.
 */
export function sampleClip(
  clip: AnimationClip,
  t: number,
  pose: Pose,
  weight = 1,
  blend: BlendMode = 'override',
  cursor: ClipCursor = cursorFor(clip),
): void {
  const channels = clip.channels;
  const nodes = (pose.length / POSE_NODE_FLOATS) | 0;
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci]!;
    if (ch.path === 'weights' || ch.node < 0 || ch.node >= nodes) continue;
    sampleChannel(ch, t, sample, 0, cursor, ci);
    const o = ch.node * POSE_NODE_FLOATS;
    if (blend === 'override') {
      if (ch.path === 'rotation') {
        if (weight >= 1) {
          pose[o + 3] = sample[0]!;
          pose[o + 4] = sample[1]!;
          pose[o + 5] = sample[2]!;
          pose[o + 6] = sample[3]!;
        } else quatSlerp(pose, o + 3, pose, o + 3, sample, 0, weight);
      } else {
        const b = ch.path === 'translation' ? o : o + 7;
        if (weight >= 1) {
          pose[b] = sample[0]!;
          pose[b + 1] = sample[1]!;
          pose[b + 2] = sample[2]!;
        } else {
          const s = 1 - weight;
          pose[b] = s * pose[b]! + weight * sample[0]!;
          pose[b + 1] = s * pose[b + 1]! + weight * sample[1]!;
          pose[b + 2] = s * pose[b + 2]! + weight * sample[2]!;
        }
      }
    } else if (ch.path === 'translation') {
      pose[o] += weight * sample[0]!;
      pose[o + 1] += weight * sample[1]!;
      pose[o + 2] += weight * sample[2]!;
    } else if (ch.path === 'scale') {
      pose[o + 7] *= 1 + weight * (sample[0]! - 1);
      pose[o + 8] *= 1 + weight * (sample[1]! - 1);
      pose[o + 9] *= 1 + weight * (sample[2]! - 1);
    } else {
      quatIdentity(delta, 0);
      quatSlerp(delta, 0, delta, 0, sample, 0, weight);
      quatMultiply(pose, o + 3, pose, o + 3, delta, 0);
      quatNormalize(pose, o + 3);
    }
  }
}

/**
 * Sample the `'weights'` channel of `clip` targeting `node` at `t` into `out[0..n)`, where `n`
 * is the channel's weight count (`channelComponents`): the same interpolation as `sampleClip`
 * (STEP, LINEAR, CUBICSPLINE, hold outside the key range). Returns false, writing nothing, when
 * the clip has no weights channel for `node`. Throws `RangeError` when `out` is too short.
 * `cursor` as in `sampleClip`. No allocation.
 */
export function sampleWeights(
  clip: AnimationClip,
  node: number,
  t: number,
  out: Float32Array,
  cursor: ClipCursor = cursorFor(clip),
): boolean {
  const channels = clip.channels;
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci]!;
    if (ch.path !== 'weights' || ch.node !== node) continue;
    const n = channelComponents(ch);
    if (out.length < n) throw new RangeError(`sampleWeights: ${out.length} slots for ${n} weights`);
    sampleChannel(ch, t, out, 0, cursor, ci);
    return true;
  }
  return false;
}
