/**
 * The frustum cull (D1 §3.3), on the GPU and its CPU twin. Both read a set's slot table and
 * write, per cull group and per slot, the five words of a `drawIndexedIndirect` (index count, instance
 * count, first index, base vertex, first instance); a culled slot gets instance count 0, so its
 * draw costs nothing. Generalized from Forge's `cs_cull` (sections → slots with a sphere).
 *
 * A cull group (D1 §3.5) is one plane set: a lone view's own planes, or the union frustum of a
 * stereo pair, so both eyes share one args set. The core binds the groups' plane slots (the upper
 * half of its view buffer) as `views` here; `params.views` counts groups.
 */
import { CORE_VIEW_WGSL, MAX_VIEWS, sphereInPlanes, VIEW_SLOT_FLOATS } from './view';

/** 32-bit words per slot in a set's slot table. */
export const SLOT_WORDS = 12;
/** Bytes per slot. */
export const SLOT_BYTES = SLOT_WORDS * 4;
/** Words of one `drawIndexedIndirect` argument record. */
export const ARGS_WORDS = 5;
/** Bytes of one argument record. */
export const ARGS_BYTES = ARGS_WORDS * 4;
/** Bytes of a set's cull parameters (count, capacity, views, firstInstance mode). */
export const CULL_PARAMS_BYTES = 16;
/** Cull workgroup size. */
export const CULL_WORKGROUP = 64;

/**
 * Slot table word offsets: the bounding sphere (f32 × 4), then the draw (u32): index count,
 * first index, base vertex (i32), instance count, first instance, flags (bit 0: live).
 */
export const SLOT = {
  x: 0,
  y: 1,
  z: 2,
  r: 3,
  indexCount: 4,
  firstIndex: 5,
  baseVertex: 6,
  instanceCount: 7,
  firstInstance: 8,
  flags: 9,
} as const;

/** `SLOT.flags` bit: the slot holds a draw. */
export const SLOT_LIVE = 1;

export const CULL_WGSL = /* wgsl */ `${CORE_VIEW_WGSL}
struct CullParams { count: u32, capacity: u32, views: u32, firstInstance: u32 };
struct Slot { sphere: vec4f, draw: vec4u, inst: vec4u };
@group(0) @binding(0) var<uniform> views: array<CoreView, ${MAX_VIEWS}>;
@group(0) @binding(1) var<uniform> params: CullParams;
@group(0) @binding(2) var<storage, read> slots: array<Slot>;
@group(0) @binding(3) var<storage, read_write> args: array<u32>;

@compute @workgroup_size(${CULL_WORKGROUP}) fn cs_cull(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let v = id.y;
  if (i >= params.count || v >= params.views) { return; }
  let s = slots[i];
  var visible = (s.inst.y & 1u) != 0u;
  for (var k = 0u; k < 6u; k++) {
    let p = views[v].planes[k];
    if (dot(p.xyz, s.sphere.xyz) + p.w < -s.sphere.w) { visible = false; }
  }
  let o = (v * params.capacity + i) * ${ARGS_WORDS}u;
  args[o] = s.draw.x;
  args[o + 1u] = select(0u, s.draw.w, visible);
  args[o + 2u] = s.draw.y;
  args[o + 3u] = s.draw.z;
  args[o + 4u] = select(0u, s.inst.x, params.firstInstance != 0u);
}
`;

/**
 * The CPU twin of `cs_cull`: for each of `views` cull groups (their plane slots in `viewData`, a
 * `VIEW_SLOT_FLOATS`-strided array), write the argument records of slots `0..count` into `args`
 * at `(group * capacity + slot) * ARGS_WORDS`. Returns the visible slot-group pairs. Tests run it
 * as the fake GPU's stand-in for the shader; nothing allocates.
 */
export function cullSlotsCpu(
  slotsF32: Float32Array,
  slotsU32: Uint32Array,
  count: number,
  capacity: number,
  viewData: Float32Array,
  views: number,
  firstInstance: boolean,
  args: Uint32Array,
): number {
  let seen = 0;
  for (let v = 0; v < views; v++) {
    const at = v * VIEW_SLOT_FLOATS + 20;
    for (let i = 0; i < count; i++) {
      const s = i * SLOT_WORDS;
      const live = (slotsU32[s + SLOT.flags]! & SLOT_LIVE) !== 0;
      const visible =
        live &&
        sphereInPlanes(
          viewData,
          at,
          slotsF32[s]!,
          slotsF32[s + 1]!,
          slotsF32[s + 2]!,
          slotsF32[s + 3]!,
        );
      const o = (v * capacity + i) * ARGS_WORDS;
      args[o] = slotsU32[s + SLOT.indexCount]!;
      args[o + 1] = visible ? slotsU32[s + SLOT.instanceCount]! : 0;
      args[o + 2] = slotsU32[s + SLOT.firstIndex]!;
      args[o + 3] = slotsU32[s + SLOT.baseVertex]!;
      args[o + 4] = firstInstance ? slotsU32[s + SLOT.firstInstance]! : 0;
      if (visible && slotsU32[s + SLOT.instanceCount]! > 0) seen++;
    }
  }
  return seen;
}
