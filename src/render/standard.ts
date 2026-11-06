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
  /** Pipeline / bind group label. Default `'standard'`. */
  label?: string;
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
  /** The sampler every map is read with. Default `'linear-mip-repeat'`. */
  sampler?: SamplerKind;
}

/** Texture slots of a standard material (`material.setTexture(slot, tex)` swaps a map). */
export const STANDARD_TEXTURE_SLOTS = {
  baseColor: 0,
  metallicRoughness: 1,
  normal: 2,
  occlusion: 3,
  emissive: 4,
} as const;

/** The standard material's uniform block, in floats (`setUniforms` takes the whole block). */
export const STANDARD_UNIFORM_FLOATS = 20;

/** Flag bits in `StandardParams.emissive.w`. */
const FLAG_DOUBLE_SIDED = 1;
const FLAG_MASK = 2;
const FLAG_BLEND = 4;

/**
 * Pack a desc's factors into the standard material's uniform block:
 * `base_color` (rgba), `factors` (metallic, roughness, normal_scale, alpha_cutoff),
 * `emissive` (rgb, flags: bit 0 double-sided, bit 1 alpha mask, bit 2 alpha blend),
 * `uv_scale_offset` (sx, sy, ox, oy) and `uv_rot` (cos, sin, 0, 0) from `uvTransform`. `out`
 * must hold `STANDARD_UNIFORM_FLOATS`; returns it.
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
  out[11] = flags;
  const t = desc.uvTransform;
  out[12] = t?.[0] ?? 1;
  out[13] = t?.[1] ?? 1;
  out[14] = t?.[2] ?? 0;
  out[15] = t?.[3] ?? 0;
  const rot = t?.[4] ?? 0;
  out[16] = Math.cos(rot);
  out[17] = Math.sin(rot);
  out[18] = 0;
  out[19] = 0;
  return out;
}

/**
 * The standard material's shader text, after the prelude and `WGSL_PBR`. Bindings follow the
 * material convention: the block at `@group(1) @binding(0)`, the sampler at 1, the five maps at
 * 2..6 in `STANDARD_TEXTURE_SLOTS` order. Every map is read through `standard_uv`, the
 * `uvTransform`; the normal map perturbs through `engine_perturb_normal` (screen-space
 * derivatives), so the material draws any 3D layout, tangents or not.
 */
export const STANDARD_WGSL = /* wgsl */ `
struct StandardParams {
  base_color: vec4f,
  factors: vec4f,
  emissive: vec4f,
  uv_scale_offset: vec4f,
  uv_rot: vec4f,
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

@fragment fn fs_main(in: VSOut, @builtin(front_facing) front: bool) -> FragOut {
  let uv = standard_uv(in.uv);
  let base = textureSample(standard_base_color, standard_sampler, uv) * standard.base_color * in.color;
  let mr = textureSample(standard_metallic_roughness, standard_sampler, uv);
  let nmap = textureSample(standard_normal, standard_sampler, uv).xyz;
  let ao = textureSample(standard_occlusion, standard_sampler, uv).r;
  let em = textureSample(standard_emissive, standard_sampler, uv).rgb * standard.emissive.rgb;
  let flags = u32(standard.emissive.w);
  var n = normalize(in.normal);
  if ((flags & 1u) != 0u && !front) { n = -n; }
  let v = normalize(camera.camera_pos.xyz - in.worldPos);
  n = engine_perturb_normal(n, in.worldPos, uv, nmap, standard.factors.z);
  if ((flags & 2u) != 0u && base.a < standard.factors.w) { discard; }
  let metallic = mr.b * standard.factors.x;
  let roughness = mr.g * standard.factors.y;
  let lit = engine_pbr_layers(
    base.rgb, metallic, roughness, n, v, in.worldPos, ao, vec3f(0.0),
    engine_instance_layers(in.flags),
  );
  let glow = em + base.rgb * in.emissive;
  // Fog attenuates the emissive without tinting it: fog(e) - fog(0) = e × (1 - f).
  let fogged_glow = engine_fog(glow, in.worldPos) - engine_fog(vec3f(0.0), in.worldPos);
  let alpha = select(1.0, base.a, (flags & 4u) != 0u);
  var o: FragOut;
  o.color = vec4f(lit, alpha);
  o.emissive = vec4f(fogged_glow, alpha);
  return o;
}
`;

/**
 * A standard PBR `Material` for `desc`: `createMaterial` with `STANDARD_WGSL`, an 80-byte block
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
    label: desc.label ?? 'standard',
    wgsl: `${WGSL_PBR}\n${STANDARD_WGSL}`,
    blend: desc.alphaMode === 'blend' ? 'alpha' : 'opaque',
    uniformBytes: STANDARD_UNIFORM_FLOATS * 4,
    textures: 5,
    sampler: desc.sampler ?? 'linear-mip-repeat',
    buffers,
  });
  m.setUniforms(packStandardUniforms(desc));
  m.setTexture(STANDARD_TEXTURE_SLOTS.baseColor, desc.baseColor ?? d.white);
  m.setTexture(STANDARD_TEXTURE_SLOTS.metallicRoughness, desc.metallicRoughness ?? d.white);
  m.setTexture(STANDARD_TEXTURE_SLOTS.normal, desc.normal ?? d.flatNormal);
  m.setTexture(STANDARD_TEXTURE_SLOTS.occlusion, desc.occlusion ?? d.white);
  m.setTexture(STANDARD_TEXTURE_SLOTS.emissive, desc.emissive ?? d.black);
  return m;
}
