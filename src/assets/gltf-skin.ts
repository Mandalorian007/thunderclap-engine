/**
 * Skinned glTF data → the shapes the animation module (`src/anim`) and GPU skinning
 * (`VERTEX_LAYOUT_SKINNED` in `src/render/mesh.ts`) consume. Pure data, no GPU.
 *
 * `assets` does not import `anim`: `GltfSkeleton` restates `anim`'s `Skeleton` structurally
 * (`parents: Int16Array`, `rest` 10 floats per node `t3 q4 s3`, `inverseBind` 12 floats per joint
 * as 3×4 rows, `joints: Uint16Array` joint → node), so a `GltfSkeleton` is a `Skeleton`.
 */
import { type GltfDocument, GltfError, type GltfPrimitive } from './gltf';

/** Floats per vertex in the skinned layout's float part (the 3D layout: pos, normal, uv, colour). */
const SKINNED_FLOATS = 12;
/** Bytes per skinned vertex: 12 floats + joints `uint8x4` + weights `unorm8x4`. */
export const SKINNED_VERTEX_STRIDE = SKINNED_FLOATS * 4 + 4 + 4;
/** Byte offset of the joints within a skinned vertex, then the weights. */
export const SKINNED_JOINTS_OFFSET = SKINNED_FLOATS * 4;
export const SKINNED_WEIGHTS_OFFSET = SKINNED_JOINTS_OFFSET + 4;

/** Interleaved skinned vertices, ready for a `Mesh` in `VERTEX_LAYOUT_SKINNED`. */
export interface SkinnedVertices {
  /** `vertexCount * SKINNED_VERTEX_STRIDE` bytes: `x y z nx ny nz u v r g b a` as f32, 4 joint bytes, 4 weight bytes. */
  vertices: ArrayBuffer;
  layout: 'skinned';
}

/**
 * Pack a skinned primitive into the skinned vertex layout: the 3D floats, then the four joint
 * indices as bytes and the four weights as `unorm8` (renormalised to sum to 1 first and
 * rounded so the four bytes sum to 255, so quantisation never scales the vertex). Throws when
 * the primitive has no `JOINTS_0` or a joint index above 255 (the layout's `uint8x4`).
 */
export function interleaveSkinned(p: GltfPrimitive): SkinnedVertices {
  if (!p.joints || !p.weights) throw new GltfError('interleaveSkinned: primitive is not skinned');
  if (!(p.joints instanceof Uint8Array)) {
    throw new GltfError('interleaveSkinned: joint indices above 255 do not fit uint8x4');
  }
  const n = p.vertexCount;
  const out = new ArrayBuffer(n * SKINNED_VERTEX_STRIDE);
  const f32 = new Float32Array(out);
  const u8 = new Uint8Array(out);
  const fStride = SKINNED_VERTEX_STRIDE / 4;
  for (let i = 0; i < n; i++) {
    const o = i * fStride;
    f32[o] = p.position[i * 3]!;
    f32[o + 1] = p.position[i * 3 + 1]!;
    f32[o + 2] = p.position[i * 3 + 2]!;
    f32[o + 3] = p.normal[i * 3]!;
    f32[o + 4] = p.normal[i * 3 + 1]!;
    f32[o + 5] = p.normal[i * 3 + 2]!;
    f32[o + 6] = p.uv0[i * 2]!;
    f32[o + 7] = p.uv0[i * 2 + 1]!;
    f32[o + 8] = p.color0[i * 4]!;
    f32[o + 9] = p.color0[i * 4 + 1]!;
    f32[o + 10] = p.color0[i * 4 + 2]!;
    f32[o + 11] = p.color0[i * 4 + 3]!;
    const b = i * SKINNED_VERTEX_STRIDE + SKINNED_JOINTS_OFFSET;
    u8[b] = p.joints[i * 4]!;
    u8[b + 1] = p.joints[i * 4 + 1]!;
    u8[b + 2] = p.joints[i * 4 + 2]!;
    u8[b + 3] = p.joints[i * 4 + 3]!;
    quantiseWeights(p.weights, i * 4, u8, b + 4);
  }
  return { vertices: out, layout: 'skinned' };
}

/** Four weights → four `unorm8` bytes summing to 255 (a vertex with no weight gets all of joint 0's). */
function quantiseWeights(w: Float32Array, at: number, out: Uint8Array, to: number): void {
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += Math.max(w[at + k]!, 0);
  if (sum <= 0) {
    out[to] = 255;
    out[to + 1] = 0;
    out[to + 2] = 0;
    out[to + 3] = 0;
    return;
  }
  let total = 0;
  let largest = 0;
  for (let k = 0; k < 4; k++) {
    const q = Math.round((Math.max(w[at + k]!, 0) / sum) * 255);
    out[to + k] = q;
    total += q;
    if (q > out[to + largest]!) largest = k;
  }
  // Rounding can leave the sum one or two off 255: settle it on the heaviest joint.
  out[to + largest] = out[to + largest]! + (255 - total);
}

/**
 * The animation module's `Skeleton` shape (see the file comment). The skeleton spans every
 * node of the document, so `GltfAnimationChannel.node` indexes `rest` and a pose directly;
 * `joints[j]` names the node that drives joint `j` of the skin.
 */
export interface GltfSkeleton {
  /** Parent node per node, -1 for a root. */
  parents: Int16Array;
  /** Rest pose from each node's TRS: 10 floats per node, `tx ty tz qx qy qz qw sx sy sz`. */
  rest: Float32Array;
  /** 12 floats (3×4 rows) per joint, from `GltfSkin.inverseBind`. */
  inverseBind: Float32Array;
  /** Node index per joint. */
  joints: Uint16Array;
}

/** Build a skeleton for `doc.skins[skinIndex]` over every node of the document. */
export function skeletonFromSkin(doc: GltfDocument, skinIndex: number): GltfSkeleton {
  const skin = doc.skins[skinIndex];
  if (!skin) throw new GltfError(`skin ${skinIndex} does not exist`);
  const n = doc.nodes.length;
  if (n > 0x7fff) throw new GltfError(`${n} nodes exceed the Int16 parent table`);
  const parents = new Int16Array(n);
  const rest = new Float32Array(n * 10);
  for (let i = 0; i < n; i++) {
    const node = doc.nodes[i]!;
    parents[i] = node.parent ?? -1;
    const o = i * 10;
    rest[o] = node.translation[0];
    rest[o + 1] = node.translation[1];
    rest[o + 2] = node.translation[2];
    rest[o + 3] = node.rotation[0];
    rest[o + 4] = node.rotation[1];
    rest[o + 5] = node.rotation[2];
    rest[o + 6] = node.rotation[3];
    rest[o + 7] = node.scale[0];
    rest[o + 8] = node.scale[1];
    rest[o + 9] = node.scale[2];
  }
  return {
    parents,
    rest,
    inverseBind: skin.inverseBind,
    joints: Uint16Array.from(skin.joints),
  };
}
