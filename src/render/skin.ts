import { SKIN_JOINTS_BYTE_OFFSET, SKIN_WEIGHTS_BYTE_OFFSET, VERTEX_SKINNED_STRIDE } from './mesh';

/**
 * GPU skinning: a `SkinPalette` is the storage buffer of joint matrices that a material
 * drawing `VERTEX_LAYOUT_SKINNED` meshes reads (`WGSL_SKIN` / `engine_skin` in the prelude).
 *
 * - One joint matrix is 12 floats (`JOINT_FLOATS`): a 3×4 row-major affine matrix, rows
 *   `r0 r1 r2` of four floats, the same layout as the instance matrix and as `anim`'s
 *   `skinMatrices` output (world × inverse bind, per joint).
 * - The palette holds `instances × joints` of them, instance after instance, after a 16-byte
 *   header (`joints`, `instances`) the shader reads to find an instance's block.
 * - A draw names its block with the palette slot in `InstanceParams.params[3]` (`params.w`,
 *   read as `u32`); the other three `params` stay the material's. Several draws may share one
 *   slot.
 * - `set(slot, matrices)` copies one instance's matrices into CPU staging and marks it dirty;
 *   `flush()` uploads the dirty range in one `writeBuffer`, once per frame, allocating nothing.
 *
 * Bind it to a material with `buffers: [palette.buffer]` (`BindingDesc.buffers`, binding 16).
 * A palette is one material's; two skinned materials take two palettes, or one shared buffer
 * passed to both.
 */
export interface SkinPaletteDesc {
  /** Joints per instance (the skeleton's joint count). */
  joints: number;
  /** Instances (palette slots) the buffer holds. Default 1. */
  instances?: number;
  label?: string;
}

/** Floats in one joint matrix: 3 rows × 4 (row-major 3×4 affine). */
export const JOINT_FLOATS = 12;
/** Floats of the palette header before the first joint row (`joints`, `instances`, pad, pad). */
export const SKIN_PALETTE_HEADER_FLOATS = 4;

export class SkinPalette {
  readonly label: string;
  readonly joints: number;
  readonly instances: number;
  /** The storage buffer (`STORAGE | COPY_DST`), sized at creation; bind it as `buffers[0]`. */
  readonly buffer: GPUBuffer;
  /** Floats per instance block (`joints × JOINT_FLOATS`). */
  readonly instanceFloats: number;
  private readonly data: Float32Array<ArrayBuffer>;
  /** Dirty instance range, inclusive; `lo > hi` means clean. */
  private dirtyLo = 0;
  private dirtyHi = -1;

  constructor(
    private readonly device: GPUDevice,
    desc: SkinPaletteDesc,
  ) {
    const joints = Math.floor(desc.joints);
    const instances = Math.floor(desc.instances ?? 1);
    if (!(joints >= 1)) throw new Error(`SkinPalette: joints must be ≥ 1, got ${desc.joints}`);
    if (!(instances >= 1)) {
      throw new Error(`SkinPalette: instances must be ≥ 1, got ${desc.instances}`);
    }
    this.label = desc.label ?? 'skin-palette';
    this.joints = joints;
    this.instances = instances;
    this.instanceFloats = joints * JOINT_FLOATS;
    this.data = new Float32Array(SKIN_PALETTE_HEADER_FLOATS + instances * this.instanceFloats);
    const header = new Uint32Array(this.data.buffer, 0, SKIN_PALETTE_HEADER_FLOATS);
    header[0] = joints;
    header[1] = instances;
    this.buffer = device.createBuffer({
      label: `${this.label}-buffer`,
      size: this.data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Identity everywhere, so an unset slot draws the mesh in its bind pose.
    for (let i = 0; i < instances; i++) this.setIdentity(i);
    // The header goes up with the first flush (the whole buffer is dirty).
    this.device.queue.writeBuffer(
      this.buffer,
      0,
      this.data.buffer,
      0,
      SKIN_PALETTE_HEADER_FLOATS * 4,
    );
  }

  /** Float offset of `instance`'s first joint row inside the buffer (tests, custom writers). */
  offsetOf(instance: number): number {
    return SKIN_PALETTE_HEADER_FLOATS + instance * this.instanceFloats;
  }

  /**
   * Copy `joints × 12` floats from `matrices` (starting at float `offset`) into palette slot
   * `instance`. The upload happens in `flush()`. No allocation.
   */
  set(instance: number, matrices: ArrayLike<number>, offset = 0): void {
    this.check(instance);
    const n = this.instanceFloats;
    if (offset + n > matrices.length) {
      throw new Error(
        `${this.label}: slot ${instance} needs ${n} floats from ${offset}, got ${matrices.length}`,
      );
    }
    const d = this.data;
    const o = this.offsetOf(instance);
    for (let i = 0; i < n; i++) d[o + i] = matrices[offset + i]!;
    this.dirty(instance);
  }

  /** Reset every joint of slot `instance` to the identity (the mesh's bind pose). */
  setIdentity(instance: number): void {
    this.check(instance);
    const d = this.data;
    let o = this.offsetOf(instance);
    for (let j = 0; j < this.joints; j++) {
      d.fill(0, o, o + JOINT_FLOATS);
      d[o] = 1;
      d[o + 5] = 1;
      d[o + 10] = 1;
      o += JOINT_FLOATS;
    }
    this.dirty(instance);
  }

  /** Upload the slots written since the last flush in one `writeBuffer`; nothing when clean. */
  flush(): void {
    const lo = this.dirtyLo;
    const hi = this.dirtyHi;
    if (lo > hi) return;
    this.dirtyLo = this.instances;
    this.dirtyHi = -1;
    const first = this.offsetOf(lo) * 4;
    const bytes = (hi - lo + 1) * this.instanceFloats * 4;
    this.device.queue.writeBuffer(this.buffer, first, this.data.buffer, first, bytes);
  }

  /** True when a `flush()` would upload something. */
  get isDirty(): boolean {
    return this.dirtyLo <= this.dirtyHi;
  }

  destroy(): void {
    this.buffer.destroy();
  }

  private check(instance: number): void {
    if (instance < 0 || instance >= this.instances || !Number.isInteger(instance)) {
      throw new Error(`${this.label}: slot ${instance} out of range (0..${this.instances - 1})`);
    }
  }

  private dirty(instance: number): void {
    if (instance < this.dirtyLo) this.dirtyLo = instance;
    if (instance > this.dirtyHi) this.dirtyHi = instance;
  }
}

/**
 * Write the joints and weights of vertex `vertex` of a `VERTEX_LAYOUT_SKINNED` buffer, through
 * `bytes`, a `Uint8Array` over the vertex data (`new Uint8Array(vertices.buffer)`). Weights are
 * normalised to sum to 1 and quantised to unorm8 so the four bytes add up to 255. Up to four
 * joints; missing entries read joint 0 with weight 0.
 */
export function setVertexSkin(
  bytes: Uint8Array,
  vertex: number,
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
): void {
  const base = vertex * VERTEX_SKINNED_STRIDE;
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += k < weights.length ? Math.max(0, weights[k]!) : 0;
  const scale = sum > 0 ? 255 / sum : 0;
  let used = 0;
  let largest = 0;
  for (let k = 0; k < 4; k++) {
    const j = k < joints.length ? joints[k]! : 0;
    const w = k < weights.length ? Math.round(Math.max(0, weights[k]!) * scale) : 0;
    bytes[base + SKIN_JOINTS_BYTE_OFFSET + k] = j;
    bytes[base + SKIN_WEIGHTS_BYTE_OFFSET + k] = w;
    used += w;
    if (w > bytes[base + SKIN_WEIGHTS_BYTE_OFFSET + largest]!) largest = k;
  }
  // Rounding may leave the bytes short of (or past) 255: settle it on the heaviest weight.
  if (sum > 0 && used !== 255) {
    bytes[base + SKIN_WEIGHTS_BYTE_OFFSET + largest] += 255 - used;
  }
}
