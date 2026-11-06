/**
 * Retargeting: a clip authored for one skeleton drives another with different joint names,
 * bone lengths and rest orientations (E-015: every cosmetic is a rig of its own, and one walk
 * cycle has to play on all of them).
 *
 * `createRetargetMap(source, target, opts?)` pairs target joints with source joints (explicit
 * pairs, then a name match) and precomputes, per matched joint, the two constant rotations that
 * turn a source local rotation into a target local rotation:
 *
 *   `Rt[j] = pre[j] · Rs[i] · post[j]`, with
 *   `pre[j]  = inv(Wt_rest[parent j]) · Ws_rest[parent i]`   (source parent frame → target parent frame)
 *   `post[j] = inv(pre[j] · Rs_rest[i]) · Rt_rest[j]`.
 *
 * Expanded, that is `Rt = A · (Rs · inv(Rs_rest)) · inv(A) · Rt_rest`: the source joint's
 * rest-relative rotation delta, expressed in the source parent's frame, carried into the target
 * parent's frame through the rest poses, and applied on top of the target's own rest rotation.
 * When the two rigs' bones point the same way in world space at rest (the usual T- or A-pose
 * convention), the target's bones end up pointing where the source's do, whatever its local
 * joint frames look like. Translations stay at the target's rest except the root's, which moves
 * by the source root's rest-relative delta scaled by the hip-height ratio.
 *
 * `retargetPose` allocates nothing; `createRetargetMap` and `retargetClip` allocate (once).
 */
import { type AnimationChannel, type AnimationClip, createClipCursor, sampleClip } from './clip';
import { POSE_NODE_FLOATS, type Pose, poseToWorld, type Skeleton, WORLD_NODE_FLOATS } from './pose';
import { quatMultiply, quatNormalize } from './quat';

export interface RetargetOptions {
  /**
   * Explicit `[source, target]` joint pairs by name or node index. Pairs win over name matching
   * and are the only way to pair joints of a skeleton without `names`.
   */
  pairs?: Array<[string | number, string | number]>;
  /**
   * Replaces the default name matching: given a source joint name, return the target joint name
   * it drives, or `null` for none. Not called for joints covered by `pairs`.
   */
  match?: (sourceName: string) => string | null;
  /**
   * The target node whose translation follows its paired source node (the hips). Default: the
   * first matched target node in hierarchy order. A node that ends up unmatched gets none.
   */
  rootNode?: string | number;
  /**
   * Scale the root's translation delta by the ratio of the rigs' hip heights (the length of the
   * root node's rest world position; 1 when either is 0). Default true.
   */
  scaleTranslation?: boolean;
}

export interface RetargetMap {
  source: Skeleton;
  target: Skeleton;
  /** Source node per target node, `-1` where the target joint has no source. */
  pairs: Int32Array;
  /** Target joints with no source, by name (index as text when the skeleton has no names). */
  unmatched: string[];
  /** Target node whose translation is transferred, `-1` for none. */
  root: number;
  /** Factor on the root's translation delta (hip-height ratio, or 1). Settable. */
  translationScale: number;
  /** Precomputed rest frames: `pre[j]` (4 floats per target node), applied before the source rotation. */
  pre: Float32Array;
  /** Precomputed rest frames: `post[j]` (4 floats per target node), applied after it. */
  post: Float32Array;
}

export interface RetargetClipOptions {
  /** Samples per second. Default: the clip's own key times, merged over its channels. */
  sampleRate?: number;
  /** Name of the baked clip. Default: the source clip's name. */
  name?: string;
}

type Named = Skeleton & { names?: readonly string[] };

/**
 * Lowercase, drop a `namespace:` or `Armature|` prefix, and strip separators (`_`, `-`, `.`,
 * `:`, `|`, spaces), so `mixamorig:LeftArm`, `Left_Arm` and `left arm` compare equal.
 */
export function normalizeJointName(name: string): string {
  let s = name;
  const cut = Math.max(s.lastIndexOf(':'), s.lastIndexOf('|'));
  if (cut >= 0) s = s.slice(cut + 1);
  return s.toLowerCase().replace(/[\s_\-.:|]+/g, '');
}

function resolveNode(skeleton: Named, ref: string | number, side: string): number {
  if (typeof ref === 'number') {
    if (ref < 0 || ref >= skeleton.parents.length || (ref | 0) !== ref) {
      throw new Error(`retarget: ${side} node ${ref} is out of range`);
    }
    return ref;
  }
  const names = skeleton.names;
  const i = names ? names.indexOf(ref) : -1;
  if (i < 0) throw new Error(`retarget: ${side} skeleton has no node named "${ref}"`);
  return i;
}

/** World rest rotation per node (4 floats each), parents before children. Allocates. */
function restWorldRotations(skeleton: Skeleton): Float32Array {
  const n = skeleton.parents.length;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = skeleton.parents[i]!;
    const ro = i * POSE_NODE_FLOATS + 3;
    if (p < 0) {
      out[i * 4] = skeleton.rest[ro]!;
      out[i * 4 + 1] = skeleton.rest[ro + 1]!;
      out[i * 4 + 2] = skeleton.rest[ro + 2]!;
      out[i * 4 + 3] = skeleton.rest[ro + 3]!;
    } else {
      quatMultiply(out, i * 4, out, p * 4, skeleton.rest, ro);
    }
    quatNormalize(out, i * 4);
  }
  return out;
}

/** Hip height: the length of the node's rest world position. */
function restHeight(skeleton: Skeleton, node: number): number {
  const world = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS);
  poseToWorld(skeleton, skeleton.rest, world);
  const o = node * WORLD_NODE_FLOATS;
  return Math.hypot(world[o + 3]!, world[o + 7]!, world[o + 11]!);
}

/** Write the conjugate (inverse, for unit quaternions) of `q[qo..]` at `out[oo..]`. */
function conjugate(out: Float32Array, oo: number, q: ArrayLike<number>, qo: number): void {
  out[oo] = -q[qo]!;
  out[oo + 1] = -q[qo + 1]!;
  out[oo + 2] = -q[qo + 2]!;
  out[oo + 3] = q[qo + 3]!;
}

const IDENTITY = new Float32Array([0, 0, 0, 1]);
const tmpA = new Float32Array(4);
const tmpB = new Float32Array(4);

/**
 * Pair the joints of `source` and `target` and precompute the rest frames `retargetPose` and
 * `retargetClip` use. Pairing, per source joint: `opts.pairs` first; then `opts.match` when
 * given, else the target joint with the same name, else the one whose `normalizeJointName`
 * matches. Two skeletons without names pair by index. Target joints left over are listed in
 * `unmatched` and hold their rest. Allocates; build once per (clip skeleton, character) pair.
 */
export function createRetargetMap(
  source: Skeleton,
  target: Skeleton,
  opts: RetargetOptions = {},
): RetargetMap {
  const src = source as Named;
  const tgt = target as Named;
  const ns = source.parents.length;
  const nt = target.parents.length;
  const pairs = new Int32Array(nt).fill(-1);
  const sourceUsed = new Uint8Array(ns);

  const pair = (s: number, t: number) => {
    if (pairs[t] !== -1 || sourceUsed[s]) return;
    pairs[t] = s;
    sourceUsed[s] = 1;
  };

  for (const [s, t] of opts.pairs ?? []) {
    pair(resolveNode(src, s, 'source'), resolveNode(tgt, t, 'target'));
  }

  if (src.names && tgt.names) {
    const targetByName = new Map<string, number>();
    const targetByNormal = new Map<string, number>();
    for (let t = 0; t < nt; t++) {
      const name = tgt.names[t];
      if (name === undefined) continue;
      if (!targetByName.has(name)) targetByName.set(name, t);
      const norm = normalizeJointName(name);
      if (!targetByNormal.has(norm)) targetByNormal.set(norm, t);
    }
    for (let s = 0; s < ns; s++) {
      if (sourceUsed[s]) continue;
      const name = src.names[s];
      if (name === undefined) continue;
      let t: number | undefined;
      if (opts.match) {
        const wanted = opts.match(name);
        if (wanted !== null)
          t = targetByName.get(wanted) ?? targetByNormal.get(normalizeJointName(wanted));
      } else {
        t = targetByName.get(name) ?? targetByNormal.get(normalizeJointName(name));
      }
      if (t !== undefined) pair(s, t);
    }
  } else if (!src.names && !tgt.names && !opts.pairs) {
    for (let i = 0; i < Math.min(ns, nt); i++) pair(i, i);
  }

  const unmatched: string[] = [];
  for (let t = 0; t < nt; t++) {
    if (pairs[t] === -1) unmatched.push(tgt.names?.[t] ?? String(t));
  }

  let root = -1;
  if (opts.rootNode !== undefined) {
    const r = resolveNode(tgt, opts.rootNode, 'target');
    if (pairs[r] !== -1) root = r;
  } else {
    for (let t = 0; t < nt; t++) {
      if (pairs[t] !== -1) {
        root = t;
        break;
      }
    }
  }

  const ws = restWorldRotations(source);
  const wt = restWorldRotations(target);
  const pre = new Float32Array(nt * 4);
  const post = new Float32Array(nt * 4);
  for (let t = 0; t < nt; t++) {
    const s = pairs[t]!;
    if (s === -1) continue;
    const ps = source.parents[s]!;
    const pt = target.parents[t]!;
    // pre = inv(Wt_rest[pt]) · Ws_rest[ps]
    if (pt < 0) tmpA.set(IDENTITY);
    else conjugate(tmpA, 0, wt, pt * 4);
    if (ps < 0) quatMultiply(pre, t * 4, tmpA, 0, IDENTITY, 0);
    else quatMultiply(pre, t * 4, tmpA, 0, ws, ps * 4);
    quatNormalize(pre, t * 4);
    // post = inv(pre · Rs_rest[s]) · Rt_rest[t]
    quatMultiply(tmpB, 0, pre, t * 4, source.rest, s * POSE_NODE_FLOATS + 3);
    conjugate(tmpA, 0, tmpB, 0);
    quatMultiply(post, t * 4, tmpA, 0, target.rest, t * POSE_NODE_FLOATS + 3);
    quatNormalize(post, t * 4);
  }

  let translationScale = 1;
  if (root !== -1 && opts.scaleTranslation !== false) {
    const hs = restHeight(source, pairs[root]!);
    const ht = restHeight(target, root);
    if (hs > 0 && ht > 0) translationScale = ht / hs;
  }

  return { source, target, pairs, unmatched, root, translationScale, pre, post };
}

/**
 * Write `targetPose` from `sourcePose`: every target node starts at the target's rest; a matched
 * node gets `pre · Rs · post` as its rotation; the root also gets its paired node's translation
 * delta (rotated into the target root's parent frame, scaled by `translationScale`). Scale stays
 * at the target's rest. No allocation.
 */
export function retargetPose(map: RetargetMap, sourcePose: Pose, targetPose: Pose): void {
  const { source, target, pairs, pre, post } = map;
  const tRest = target.rest;
  const sRest = source.rest;
  targetPose.set(tRest);
  const nt = pairs.length;
  for (let t = 0; t < nt; t++) {
    const s = pairs[t]!;
    if (s === -1) continue;
    const to = t * POSE_NODE_FLOATS;
    const so = s * POSE_NODE_FLOATS;
    quatMultiply(targetPose, to + 3, pre, t * 4, sourcePose, so + 3);
    quatMultiply(targetPose, to + 3, targetPose, to + 3, post, t * 4);
    quatNormalize(targetPose, to + 3);
  }
  const root = map.root;
  if (root !== -1) {
    const s = pairs[root]!;
    const to = root * POSE_NODE_FLOATS;
    const so = s * POSE_NODE_FLOATS;
    const dx = sourcePose[so]! - sRest[so]!;
    const dy = sourcePose[so + 1]! - sRest[so + 1]!;
    const dz = sourcePose[so + 2]! - sRest[so + 2]!;
    // Rotate the delta by pre[root] (source parent frame → target parent frame): v' = q v q*.
    const qo = root * 4;
    const qx = pre[qo]!;
    const qy = pre[qo + 1]!;
    const qz = pre[qo + 2]!;
    const qw = pre[qo + 3]!;
    const cx = qy * dz - qz * dy;
    const cy = qz * dx - qx * dz;
    const cz = qx * dy - qy * dx;
    const k = map.translationScale;
    targetPose[to] = tRest[to]! + k * (dx + 2 * (qw * cx + qy * cz - qz * cy));
    targetPose[to + 1] = tRest[to + 1]! + k * (dy + 2 * (qw * cy + qz * cx - qx * cz));
    targetPose[to + 2] = tRest[to + 2]! + k * (dz + 2 * (qw * cz + qx * cy - qy * cx));
  }
}

/** Sorted unique key times over the clip's channels (`[0]` for a clip without keys). */
function keyTimes(clip: AnimationClip): number[] {
  const set = new Set<number>();
  for (const ch of clip.channels) for (let i = 0; i < ch.times.length; i++) set.add(ch.times[i]!);
  if (set.size === 0) set.add(0);
  return [...set].sort((a, b) => a - b);
}

/**
 * Bake `clip` (authored for `map.source`) into a clip for `map.target`: at every sample time
 * the source pose is sampled, retargeted, and written as `LINEAR` rotation keys for each matched
 * target node whose source node the clip rotates, plus translation keys for the root when the
 * clip translates its source. Events and duration are kept. Allocates; a game that would rather
 * pay once than call `retargetPose` per frame.
 */
export function retargetClip(
  map: RetargetMap,
  clip: AnimationClip,
  opts: RetargetClipOptions = {},
): AnimationClip {
  const { source, target, pairs } = map;
  let times: number[];
  if (opts.sampleRate !== undefined && opts.sampleRate > 0) {
    const n = Math.max(1, Math.ceil(clip.duration * opts.sampleRate));
    times = [];
    for (let i = 0; i <= n; i++) times.push(Math.min(clip.duration, i / opts.sampleRate));
    if (times[times.length - 1]! < clip.duration) times.push(clip.duration);
  } else {
    times = keyTimes(clip);
  }

  const rotated = new Uint8Array(source.parents.length);
  const translated = new Uint8Array(source.parents.length);
  for (const ch of clip.channels) {
    if (ch.node < 0 || ch.node >= rotated.length) continue;
    if (ch.path === 'rotation') rotated[ch.node] = 1;
    else if (ch.path === 'translation') translated[ch.node] = 1;
  }

  const nt = pairs.length;
  const rotationOut: (Float32Array | null)[] = new Array(nt).fill(null);
  for (let t = 0; t < nt; t++) {
    const s = pairs[t]!;
    if (s !== -1 && rotated[s]) rotationOut[t] = new Float32Array(times.length * 4);
  }
  const root = map.root;
  const rootOut =
    root !== -1 && translated[pairs[root]!] ? new Float32Array(times.length * 3) : null;

  const sourcePose = new Float32Array(source.rest);
  const targetPose = new Float32Array(target.rest);
  const cursor = createClipCursor(clip);
  for (let k = 0; k < times.length; k++) {
    sourcePose.set(source.rest);
    sampleClip(clip, times[k]!, sourcePose, 1, 'override', cursor);
    retargetPose(map, sourcePose, targetPose);
    for (let t = 0; t < nt; t++) {
      const out = rotationOut[t];
      if (!out) continue;
      const o = t * POSE_NODE_FLOATS + 3;
      out[k * 4] = targetPose[o]!;
      out[k * 4 + 1] = targetPose[o + 1]!;
      out[k * 4 + 2] = targetPose[o + 2]!;
      out[k * 4 + 3] = targetPose[o + 3]!;
    }
    if (rootOut) {
      const o = root * POSE_NODE_FLOATS;
      rootOut[k * 3] = targetPose[o]!;
      rootOut[k * 3 + 1] = targetPose[o + 1]!;
      rootOut[k * 3 + 2] = targetPose[o + 2]!;
    }
  }

  // Keep neighbouring keys on the same hemisphere so LINEAR slerp takes the short arc.
  for (const out of rotationOut) {
    if (!out) continue;
    for (let k = 1; k < times.length; k++) {
      const a = (k - 1) * 4;
      const b = k * 4;
      const dot =
        out[a]! * out[b]! +
        out[a + 1]! * out[b + 1]! +
        out[a + 2]! * out[b + 2]! +
        out[a + 3]! * out[b + 3]!;
      if (dot < 0) {
        out[b] = -out[b]!;
        out[b + 1] = -out[b + 1]!;
        out[b + 2] = -out[b + 2]!;
        out[b + 3] = -out[b + 3]!;
      }
    }
  }

  const timesArray = Float32Array.from(times);
  const channels: AnimationChannel[] = [];
  if (rootOut) {
    channels.push({
      node: root,
      path: 'translation',
      interpolation: 'LINEAR',
      times: timesArray,
      values: rootOut,
    });
  }
  for (let t = 0; t < nt; t++) {
    const out = rotationOut[t];
    if (!out) continue;
    channels.push({
      node: t,
      path: 'rotation',
      interpolation: 'LINEAR',
      times: timesArray,
      values: out,
    });
  }
  const baked: AnimationClip = { name: opts.name ?? clip.name, duration: clip.duration, channels };
  if (clip.events) baked.events = clip.events.map((e) => ({ ...e }));
  return baked;
}
