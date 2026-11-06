/**
 * Morph targets (blend shapes) on the CPU: `base + Σ weight × delta` per vertex, written into
 * the position and normal lanes of an interleaved vertex buffer the mesh then uploads
 * (`Mesh.update`). The arithmetic is here; the parser (`assets/gltf.ts`) fills `MorphTarget`s
 * and the loader (`assets/gltf-load.ts`) owns the buffers and the upload. Nothing allocates
 * after `createMorphBlender`.
 */

/** Per-vertex deltas of one target, 3 floats per vertex, or null when it leaves that lane alone. */
export interface MorphTarget {
  position: Float32Array | null;
  normal: Float32Array | null;
}

/**
 * Where positions and normals sit in an interleaved vertex: `floats` per vertex, and the float
 * offsets of the position (default 0) and normal (default 3; null when the layout has none).
 * `VERTEX_LAYOUT_3D` from `render/mesh.ts` fits as is.
 */
export interface MorphLayout {
  readonly floats: number;
  readonly positionOffset?: number;
  readonly normalOffset?: number | null;
}

export interface MorphBlender {
  /** One weight per target; the game (or `sampleWeights`) writes here, `apply` reads. */
  readonly weights: Float32Array;
  readonly targetCount: number;
  readonly vertexCount: number;
  /**
   * Write `base + Σ weights[i] × targets[i]` into `out`'s position and normal lanes (normals
   * renormalised). Returns false, writing nothing, when no weight changed since the last apply
   * into this same `out`; a first call or a new `out` copies the whole base first. No allocation.
   */
  apply(out: Float32Array): boolean;
}

/**
 * A blender over `base` (the primitive's interleaved vertices in `layout`) and its `targets`.
 * `weights` may be the array the blender should read (shared between the primitives of a mesh);
 * it defaults to zeros, `targets.length` long. Throws when a target's deltas do not cover
 * `base`'s vertices or `weights` is shorter than `targets`.
 */
export function createMorphBlender(
  base: Float32Array,
  targets: readonly MorphTarget[],
  layout: MorphLayout,
  weights: Float32Array = new Float32Array(targets.length),
): MorphBlender {
  const floats = layout.floats;
  const vertexCount = Math.floor(base.length / floats);
  const po = layout.positionOffset ?? 0;
  const no = layout.normalOffset === undefined ? 3 : layout.normalOffset;
  const targetCount = targets.length;
  if (weights.length < targetCount) {
    throw new RangeError(`morph: ${weights.length} weights for ${targetCount} targets`);
  }
  for (let i = 0; i < targetCount; i++) {
    const t = targets[i]!;
    for (const d of [t.position, t.normal]) {
      if (d && d.length < vertexCount * 3) {
        throw new RangeError(
          `morph: target ${i} has ${d.length / 3} deltas for ${vertexCount} vertices`,
        );
      }
    }
  }
  const applied = new Float32Array(targetCount);
  let lastOut: Float32Array | null = null;

  return {
    weights,
    targetCount,
    vertexCount,
    apply(out: Float32Array): boolean {
      let changed = out !== lastOut;
      for (let i = 0; i < targetCount && !changed; i++) changed = weights[i] !== applied[i];
      if (!changed) return false;
      if (out !== lastOut) {
        out.set(base);
        lastOut = out;
      }
      for (let i = 0; i < targetCount; i++) applied[i] = weights[i]!;

      for (let v = 0; v < vertexCount; v++) {
        const o = v * floats;
        const d = v * 3;
        let px = base[o + po]!;
        let py = base[o + po + 1]!;
        let pz = base[o + po + 2]!;
        for (let i = 0; i < targetCount; i++) {
          const w = applied[i]!;
          const t = targets[i]!.position;
          if (w === 0 || !t) continue;
          px += w * t[d]!;
          py += w * t[d + 1]!;
          pz += w * t[d + 2]!;
        }
        out[o + po] = px;
        out[o + po + 1] = py;
        out[o + po + 2] = pz;
        if (no === null) continue;
        let nx = base[o + no]!;
        let ny = base[o + no + 1]!;
        let nz = base[o + no + 2]!;
        for (let i = 0; i < targetCount; i++) {
          const w = applied[i]!;
          const t = targets[i]!.normal;
          if (w === 0 || !t) continue;
          nx += w * t[d]!;
          ny += w * t[d + 1]!;
          nz += w * t[d + 2]!;
        }
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-12) {
          nx /= len;
          ny /= len;
          nz /= len;
        }
        out[o + no] = nx;
        out[o + no + 1] = ny;
        out[o + no + 2] = nz;
      }
      return true;
    },
  };
}
