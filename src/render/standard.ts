import type { Material } from './material';
import { WGSL_PBR } from './pbr-wgsl';
import type { Renderer } from './renderer';
import type { SkinPalette } from './skin';
import { defaultTextures, type SamplerKind, type TextureLike } from './texture';

/**
 * The standard physically based material (`createStandardMaterial`): base colour,
 * metallic-roughness, normal, occlusion and emissive maps with factors, over every light of the
 * engine's block (sun with its shadow, point and spot lights masked against the instance's
 * layers, fog) through `engine_pbr_layers` (`WGSL_PBR`, the shared light loop). Every map is
 * optional: a missing one is a 1×1 `defaultTextures` entry (white, white, flat normal, white,
 * black), so any subset works.
 * Texture conventions follow glTF: `metallicRoughness` has roughness in G and metallic in B,
 * `occlusion` is in R, the normal map is +Y up (OpenGL / glTF), `baseColor` and `emissive` are
 * sRGB and the data maps linear (`textureFromSource(src, label, { linear: true })`).
 */
export interface StandardMaterialDesc {
  /** Pipeline / bind group label. Default `name`, else `'standard'`. */
  label?: string;
  /** `Material.name` (a file's material name). Default: the label. */
  name?: string;
  /** `MaterialDesc.depthTest`: false draws over the scene on its layer (a panel in a room). */
  depthTest?: boolean;
  /** sRGB colour with alpha; multiplied by `baseColorFactor` and the instance colour × tint. */
  baseColor?: TextureLike;
  /** Linear RGBA, default `[1, 1, 1, 1]`. */
  baseColorFactor?: ArrayLike<number>;
  /** Linear; G = roughness, B = metallic, each multiplied by its factor. */
  metallicRoughness?: TextureLike;
  /** 0 (dielectric) .. 1 (metal). Default 0. */
  metallic?: number;
  /** 0 (mirror) .. 1 (matte). Default 0.5. */
  roughness?: number;
  /** Tangent-space normal map, linear, +Y up; applied without mesh tangents (derivatives). */
  normal?: TextureLike;
  /** Scales the normal map's xy. Default 1. */
  normalScale?: number;
  /** Linear; R darkens the ambient term only. */
  occlusion?: TextureLike;
  /** How much of the occlusion map applies: `ao = mix(1, R, strength)`. Default 1. */
  occlusionStrength?: number;
  /** sRGB; × `emissiveFactor`, written to the emissive target (bloom), not the colour. */
  emissive?: TextureLike;
  /** Linear RGB. Default `[1, 1, 1]` when `emissive` is given, else `[0, 0, 0]`. */
  emissiveFactor?: ArrayLike<number>;
  /**
   * `opaque` (default): alpha is written as 1 and the draw is opaque (depth write, shadow
   * caster). `mask`: opaque, and fragments with alpha below `alphaCutoff` are discarded (they
   * still cast a full shadow: the shadow pass has no fragment stage). `blend`: the renderer's
   * alpha-blended path (sorted back to front, no depth write, casts no shadow).
   */
  alphaMode?: 'opaque' | 'mask' | 'blend';
  /** Alpha below this is discarded in `mask` mode. Default 0.5. */
  alphaCutoff?: number;
  /**
   * Back faces are shaded with their normal flipped toward the viewer. Default false: back
   * faces shade with the front normal, as every engine material does (the renderer never
   * culls, so single-sided here means nothing is hidden, only that the normal is not flipped).
   */
  doubleSided?: boolean;
  /**
   * Skinned: bind this palette (or its storage buffer) as `buffers[0]` (`@binding(16)`), so the
   * material draws `VERTEX_LAYOUT_SKINNED` meshes with the prelude's `engine_skin`: no custom
   * WGSL. The same material still draws unskinned 3D meshes; a skinned mesh picks its palette
   * slot with `InstanceParams.params[SKIN_PARAM]` (`params.w`). Swap the buffer later with
   * `material.bindings.setBuffer(0, buffer)`.
   */
  skin?: SkinPalette | GPUBuffer;
  /**
   * Texture coordinate transform applied to every map, `[sx, sy, ox, oy, rot]`:
   * `uv' = offset + R(rot) · (scale ⊙ uv)` (glTF's `KHR_texture_transform`, `T · R · S`, `rot`
   * in radians). Default identity; the rotation's cosine and sine are packed on the CPU, so the
   * shader does two multiply-adds per map whether or not one is given.
   */
  uvTransform?: ArrayLike<number>;
  /**
   * Per-map overrides (ws/render-4): a map's own `uvTransform` (else the material's) and the
   * texture coordinate set it reads, `0` (`uv`, default) or `1` (`uv1`, a `VERTEX_LAYOUT_3D_UV2`
   * mesh's second set; `uv` again on a layout without one).
   */
  maps?: Partial<Record<StandardMapSlot, StandardMapDesc>>;
  /** The sampler every map is read with. Default `'linear-mip-repeat'`. */
  sampler?: SamplerKind;
  /**
   * A noise-threshold dissolve (ws/render-5): fragments whose value noise is below `amount`
   * are discarded, in the scene pass and in the sun's shadow pass alike, and a band
   * `edgeWidth` wide above the threshold glows `edgeColor` (to the emissive target). Given at
   * creation (even with `amount: 0`), the material builds its own shadow pipeline
   * (`shadowFragmentEntry`); animate it with `setUniforms(packStandardUniforms(next))`.
   */
  dissolve?: StandardDissolve;
}

/** `StandardMaterialDesc.dissolve`. */
export interface StandardDissolve {
  /** 0 (whole) .. 1 (gone): the noise threshold below which fragments are discarded. */
  amount: number;
  /** Linear RGB of the glowing band at the edge. Default `[1, 0.5, 0.1]`. */
  edgeColor?: ArrayLike<number>;
  /** Width of the band in noise units (0..1). Default 0.05; 0 draws no edge. */
  edgeWidth?: number;
  /**
   * Noise scale: cells of value noise per uv unit of the mesh's own coordinates
   * (`VSOut.local`). Default 6.
   */
  noise?: number;
}

/** A map's own settings (`StandardMaterialDesc.maps`). */
export interface StandardMapDesc {
  uvTransform?: ArrayLike<number>;
  texCoord?: 0 | 1;
}

/** The map names of `STANDARD_TEXTURE_SLOTS`. */
export type StandardMapSlot = keyof typeof STANDARD_TEXTURE_SLOTS;

/** Texture slots of a standard material (`material.setTexture(slot, tex)` swaps a map). */
export const STANDARD_TEXTURE_SLOTS = {
  baseColor: 0,
  metallicRoughness: 1,
  normal: 2,
  occlusion: 3,
  emissive: 4,
} as const;

/** Floats of the shared head of the block, before the five per-map slots. */
const STANDARD_HEAD_FLOATS = 20;
/** Floats per map slot: `scale_offset` (4), `rot` (cos, sin, texCoord, 0). */
const STANDARD_SLOT_FLOATS = 8;
/** Float offset of the dissolve tail (`dissolve`, `dissolve_edge`) after the slots. */
export const STANDARD_DISSOLVE_OFFSET = STANDARD_HEAD_FLOATS + 5 * STANDARD_SLOT_FLOATS;
/** The standard material's uniform block, in floats (`setUniforms` takes the whole block). */
export const STANDARD_UNIFORM_FLOATS = STANDARD_DISSOLVE_OFFSET + 8;

const SLOT_NAMES: readonly StandardMapSlot[] = [
  'baseColor',
  'metallicRoughness',
  'normal',
  'occlusion',
  'emissive',
];

/** Flag bits in `StandardParams.emissive.w`. */
const FLAG_DOUBLE_SIDED = 1;
const FLAG_MASK = 2;
const FLAG_BLEND = 4;
const FLAG_DISSOLVE = 8;

/**
 * Pack a desc's factors into the standard material's uniform block:
 * `base_color` (rgba), `factors` (metallic, roughness, normal_scale, alpha_cutoff),
 * `emissive` (rgb, flags: bit 0 double-sided, bit 1 alpha mask, bit 2 alpha blend, bit 3
 * dissolve),
 * `uv_scale_offset` (sx, sy, ox, oy) and `uv_rot` (cos, sin, occlusion_strength, 0) from
 * `uvTransform`, then one `StandardSlot` per map (`scale_offset`, `rot` = cos, sin, texCoord,
 * 0) from `maps`, defaulting to the material's transform, then at `STANDARD_DISSOLVE_OFFSET`
 * `dissolve` (amount, edge width, noise scale, 0) and `dissolve_edge` (rgb, 0). `out` must hold
 * `STANDARD_UNIFORM_FLOATS`; returns it.
 */
export function packStandardUniforms(
  desc: StandardMaterialDesc,
  out: Float32Array<ArrayBuffer> = new Float32Array(STANDARD_UNIFORM_FLOATS),
): Float32Array<ArrayBuffer> {
  if (out.length < STANDARD_UNIFORM_FLOATS) {
    throw new Error(`packStandardUniforms: need ${STANDARD_UNIFORM_FLOATS} floats`);
  }
  const bc = desc.baseColorFactor;
  out[0] = bc?.[0] ?? 1;
  out[1] = bc?.[1] ?? 1;
  out[2] = bc?.[2] ?? 1;
  out[3] = bc?.[3] ?? 1;
  out[4] = desc.metallic ?? 0;
  out[5] = desc.roughness ?? 0.5;
  out[6] = desc.normalScale ?? 1;
  out[7] = desc.alphaCutoff ?? 0.5;
  const ef = desc.emissiveFactor;
  const e = desc.emissive ? 1 : 0;
  out[8] = ef?.[0] ?? e;
  out[9] = ef?.[1] ?? e;
  out[10] = ef?.[2] ?? e;
  let flags = 0;
  if (desc.doubleSided) flags |= FLAG_DOUBLE_SIDED;
  if (desc.alphaMode === 'mask') flags |= FLAG_MASK;
  if (desc.alphaMode === 'blend') flags |= FLAG_BLEND;
  const dv = desc.dissolve;
  if (dv) flags |= FLAG_DISSOLVE;
  out[11] = flags;
  const t = desc.uvTransform;
  out[12] = t?.[0] ?? 1;
  out[13] = t?.[1] ?? 1;
  out[14] = t?.[2] ?? 0;
  out[15] = t?.[3] ?? 0;
  const rot = t?.[4] ?? 0;
  out[16] = Math.cos(rot);
  out[17] = Math.sin(rot);
  out[18] = desc.occlusionStrength ?? 1;
  out[19] = 0;
  for (let k = 0; k < 5; k++) {
    const slot = desc.maps?.[SLOT_NAMES[k]!];
    const st = slot?.uvTransform ?? t;
    const o = STANDARD_HEAD_FLOATS + k * STANDARD_SLOT_FLOATS;
    out[o] = st?.[0] ?? 1;
    out[o + 1] = st?.[1] ?? 1;
    out[o + 2] = st?.[2] ?? 0;
    out[o + 3] = st?.[3] ?? 0;
    const sr = st?.[4] ?? 0;
    out[o + 4] = Math.cos(sr);
    out[o + 5] = Math.sin(sr);
    out[o + 6] = slot?.texCoord === 1 ? 1 : 0;
    out[o + 7] = 0;
  }
  const o = STANDARD_DISSOLVE_OFFSET;
  const ec = dv?.edgeColor;
  out[o] = dv ? dv.amount : 0;
  out[o + 1] = dv ? (dv.edgeWidth ?? 0.05) : 0;
  out[o + 2] = dv?.noise ?? 6;
  out[o + 3] = 0;
  out[o + 4] = ec?.[0] ?? 1;
  out[o + 5] = ec?.[1] ?? 0.5;
  out[o + 6] = ec?.[2] ?? 0.1;
  out[o + 7] = 0;
  return out;
}

/**
 * The standard material's shader text, after the prelude and `WGSL_PBR`. Bindings follow the
 * material convention: the block at `@group(1) @binding(0)`, the sampler at 1, the five maps at
 * 2..6 in `STANDARD_TEXTURE_SLOTS` order. Every map is read through `standard_uv_slot`, its
 * own transform and texture coordinate set (`maps`); `standard_uv` is the material-wide
 * transform. The normal map perturbs along the mesh tangent (`VSOut.tangent`, a
 * `VERTEX_LAYOUT_3D_TANGENT` mesh) or, without one, through `engine_perturb_normal`
 * (screen-space derivatives), so the material draws any 3D layout. Roughness, metalness and
 * the velocity go to the target's aux attachments through `engine_write_aux`.
 */
export const STANDARD_WGSL = /* wgsl */ `
struct StandardSlot {
  scale_offset: vec4f,
  rot: vec4f,
};
struct StandardParams {
  base_color: vec4f,
  factors: vec4f,
  emissive: vec4f,
  uv_scale_offset: vec4f,
  uv_rot: vec4f,
  slots: array<StandardSlot, 5>,
  dissolve: vec4f,
  dissolve_edge: vec4f,
};
@group(1) @binding(0) var<uniform> standard: StandardParams;
@group(1) @binding(1) var standard_sampler: sampler;
@group(1) @binding(2) var standard_base_color: texture_2d<f32>;
@group(1) @binding(3) var standard_metallic_roughness: texture_2d<f32>;
@group(1) @binding(4) var standard_normal: texture_2d<f32>;
@group(1) @binding(5) var standard_occlusion: texture_2d<f32>;
@group(1) @binding(6) var standard_emissive: texture_2d<f32>;
fn standard_uv(uv: vec2f) -> vec2f {
  let s = uv * standard.uv_scale_offset.xy;
  let r = standard.uv_rot.xy;
  return vec2f(r.x * s.x - r.y * s.y, r.y * s.x + r.x * s.y) + standard.uv_scale_offset.zw;
}
// Map slot's coordinates: its texture coordinate set through its own transform.
fn standard_uv_slot(in: VSOut, slot: u32) -> vec2f {
  let p = standard.slots[slot];
  let uv = select(in.uv, in.uv1, p.rot.z > 0.5);
  let s = uv * p.scale_offset.xy;
  return vec2f(p.rot.x * s.x - p.rot.y * s.y, p.rot.y * s.x + p.rot.x * s.y) + p.scale_offset.zw;
}
// Dissolve noise at a fragment, 0..1 (value-noise fbm over the mesh's own uv).
fn standard_dissolve_noise(in: VSOut) -> f32 {
  return engine_fbm(in.local * standard.dissolve.z, 3) / 0.875;
}
// True when the dissolve discards this fragment (flag bit 3 and noise below the amount).
fn standard_dissolved(in: VSOut) -> bool {
  if ((u32(standard.emissive.w) & 8u) == 0u) { return false; }
  let a = standard.dissolve.x;
  return a >= 1.0 || standard_dissolve_noise(in) < a;
}
// The shadow pass fragment (shadowFragmentEntry): the same holes as the dissolve in fs_main.
@fragment fn fs_shadow(in: VSOut) {
  if (standard_dissolved(in)) { discard; }
}

@fragment fn fs_main(in: VSOut, @builtin(front_facing) front: bool) -> FragOut {
  let uv = standard_uv_slot(in, 2u);
  let base = textureSample(standard_base_color, standard_sampler, standard_uv_slot(in, 0u)) * standard.base_color * in.color;
  let mr = textureSample(standard_metallic_roughness, standard_sampler, standard_uv_slot(in, 1u));
  let nmap = textureSample(standard_normal, standard_sampler, uv).xyz;
  let ao_tex = textureSample(standard_occlusion, standard_sampler, standard_uv_slot(in, 3u)).r;
  let em = textureSample(standard_emissive, standard_sampler, standard_uv_slot(in, 4u)).rgb * standard.emissive.rgb;
  let ao = mix(1.0, ao_tex, standard.uv_rot.z);
  let flags = u32(standard.emissive.w);
  var n = normalize(in.normal);
  if ((flags & 1u) != 0u && !front) { n = -n; }
  let v = normalize(camera.camera_pos.xyz - in.worldPos);
  // Derivative path first (uniform control flow), then the tangent frame when the mesh has one.
  let nd = engine_perturb_normal(n, in.worldPos, uv, nmap, standard.factors.z);
  let tp = in.tangent.xyz - n * dot(n, in.tangent.xyz);
  let tl = length(tp);
  if (in.tangent.w != 0.0 && tl > 1e-6) {
    let t = tp / tl;
    let b = in.tangent.w * cross(n, t);
    let m = (nmap * 2.0 - 1.0) * vec3f(standard.factors.z, standard.factors.z, 1.0);
    n = normalize(t * m.x + b * m.y + n * m.z);
  } else {
    n = nd;
  }
  if ((flags & 2u) != 0u && base.a < standard.factors.w) { discard; }
  var edge = vec3f(0.0);
  if ((flags & 8u) != 0u) {
    let dn = standard_dissolve_noise(in);
    let da = standard.dissolve.x;
    if (da >= 1.0 || dn < da) { discard; }
    let w = standard.dissolve.y;
    if (da > 0.0 && w > 0.0) {
      edge = standard.dissolve_edge.rgb * (1.0 - smoothstep(da, da + w, dn));
    }
  }
  let metallic = mr.b * standard.factors.x;
  let roughness = mr.g * standard.factors.y;
  let lit = engine_pbr_layers(
    base.rgb, metallic, roughness, n, v, in.worldPos, ao, vec3f(0.0),
    engine_instance_layers(in.flags),
  );
  let glow = em + base.rgb * in.emissive + edge;
  // Fog attenuates the emissive without tinting it: fog(e) - fog(0) = e × (1 - f).
  let fogged_glow = engine_fog(glow, in.worldPos) - engine_fog(vec3f(0.0), in.worldPos);
  let alpha = select(1.0, base.a, (flags & 4u) != 0u);
  var o: FragOut;
  o.color = vec4f(lit, alpha);
  o.emissive = vec4f(fogged_glow, alpha);
  engine_write_aux(&o, vec2f(roughness, metallic), engine_velocity(in));
  return o;
}
`;

/**
 * A standard PBR `Material` for `desc`: `createMaterial` with `STANDARD_WGSL`, a 272-byte block
 * from `packStandardUniforms` and the five maps (the device's `defaultTextures` for the missing
 * ones: `white` for the base colour, metallic-roughness and occlusion, since a 255 texel reads
 * as 1.0 whether the view is sRGB or linear, `flatNormal` and `black`). The instance
 * tint (and vertex colour) multiplies the base colour; `InstanceParams.emissive` adds
 * `base × emissive` to the glow like the sprite material. Call `setTexture(slot, tex)` with a
 * `STANDARD_TEXTURE_SLOTS` entry to swap a map, or `setUniforms(packStandardUniforms(next))`
 * to change factors. The sampler is `desc.sampler`, default `linear-mip-repeat` (trilinear on
 * maps with mips; level 0 otherwise).
 * With `skin` (a `SkinPalette` or its buffer) the palette is bound as `buffers[0]` and the
 * material skins `VERTEX_LAYOUT_SKINNED` meshes.
 */
export function createStandardMaterial(renderer: Renderer, desc: StandardMaterialDesc): Material {
  const d = defaultTextures(renderer.device);
  const skin = desc.skin;
  // A palette carries its `buffer`; a bare `GPUBuffer` has no such field (no `instanceof`: tests run without the global).
  const buffers = skin ? ['buffer' in skin ? skin.buffer : skin] : undefined;
  const m = renderer.createMaterial({
    label: desc.label ?? desc.name ?? 'standard',
    name: desc.name,
    depthTest: desc.depthTest,
    aux: true,
    wgsl: `${WGSL_PBR}\n${STANDARD_WGSL}`,
    blend: desc.alphaMode === 'blend' ? 'alpha' : 'opaque',
    uniformBytes: STANDARD_UNIFORM_FLOATS * 4,
    textures: 5,
    sampler: desc.sampler ?? 'linear-mip-repeat',
    buffers,
    // A dissolve's holes show in the shadow too: the material's own shadow pipeline.
    shadowFragmentEntry: desc.dissolve ? 'fs_shadow' : undefined,
  });
  m.setUniforms(packStandardUniforms(desc));
  m.setTexture(STANDARD_TEXTURE_SLOTS.baseColor, desc.baseColor ?? d.white);
  m.setTexture(STANDARD_TEXTURE_SLOTS.metallicRoughness, desc.metallicRoughness ?? d.white);
  m.setTexture(STANDARD_TEXTURE_SLOTS.normal, desc.normal ?? d.flatNormal);
  m.setTexture(STANDARD_TEXTURE_SLOTS.occlusion, desc.occlusion ?? d.white);
  m.setTexture(STANDARD_TEXTURE_SLOTS.emissive, desc.emissive ?? d.black);
  return m;
}
