/**
 * glTF 2.0 parser: bytes in, an engine-free `GltfDocument` out. Pure data, no DOM, no GPU, no
 * fetch (the game fetches the file and any external resource; VISION rule: the engine never
 * makes a network call). `gltf-load.ts` turns the document into meshes, textures and transforms.
 *
 * Handles the GLB container, `.gltf` JSON (as text bytes or a parsed object), `data:` URIs in
 * buffers and images, and every accessor component type (float, normalised and unnormalised
 * integers, interleaved strides). Static geometry only: `triangles` primitives, metallic-roughness
 * materials, node hierarchies, plus skins (joints, inverse bind matrices, `JOINTS_0`/`WEIGHTS_0`)
 * and animations (every sampler interpolation, cubic-spline tangents kept) and morph targets
 * (`POSITION` and `NORMAL` deltas per target, sparse or dense, plus the mesh's default
 * `weights`). Sparse accessors outside morph targets, other primitive modes and required
 * extensions throw a `GltfError`; `extensionsUsed` entries the parser does not read are listed
 * in `warnings`. Materials carry every metallic-roughness slot (`TextureRef` per map, with
 * `KHR_texture_transform` and `KHR_materials_emissive_strength` applied) and textures their
 * sampler; primitives also read `TANGENT` and `TEXCOORD_1`. `gltf-skin.ts` turns skins into the
 * animation module's `Skeleton` shape and skinned primitives into the skinned vertex layout.
 *
 * Matrices follow the engine's `Transform` convention: 3×4 row-major, `local = T · R · S`,
 * `world = parent.world · local`.
 */

import { decodeMeshopt } from './meshopt';

export class GltfError extends Error {
  constructor(message: string) {
    super(`gltf: ${message}`);
    this.name = 'GltfError';
  }
}

// ---------------------------------------------------------------- the JSON (what we read of it)

export type GltfComponentType = 5120 | 5121 | 5122 | 5123 | 5125 | 5126;
export type GltfAccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';

export interface GltfJsonAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: GltfComponentType;
  normalized?: boolean;
  count: number;
  type: GltfAccessorType;
  min?: number[];
  max?: number[];
  /** Sparse storage: `count` overrides at `indices` over the dense data (or zeros). */
  sparse?: GltfJsonSparse;
}

/** A sparse accessor's indices and values (glTF `accessor.sparse`). */
export interface GltfJsonSparse {
  count: number;
  indices: { bufferView: number; byteOffset?: number; componentType: 5121 | 5123 | 5125 };
  values: { bufferView: number; byteOffset?: number };
}

export interface GltfJsonBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: { EXT_meshopt_compression?: GltfJsonMeshoptView };
}

/** `EXT_meshopt_compression` on a buffer view: where the compressed stream is and how to decode it. */
export interface GltfJsonMeshoptView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride: number;
  count: number;
  mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
  filter?: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';
}

/** One `KHR_lights_punctual` light definition (`extensions.KHR_lights_punctual.lights[i]`). */
export interface GltfJsonLight {
  name?: string;
  type: 'directional' | 'point' | 'spot';
  color?: number[];
  intensity?: number;
  range?: number;
  spot?: { innerConeAngle?: number; outerConeAngle?: number };
}

/** One glTF `camera`. */
export interface GltfJsonCamera {
  name?: string;
  type: 'perspective' | 'orthographic';
  perspective?: { aspectRatio?: number; yfov: number; zfar?: number; znear: number };
  orthographic?: { xmag: number; ymag: number; zfar: number; znear: number };
}

/** `KHR_materials_variants` on a primitive: which material each set of variants binds. */
export interface GltfJsonVariantMapping {
  material: number;
  variants: number[];
  name?: string;
}

export interface GltfJsonPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  /** Morph targets: one attribute map per target (`POSITION`, `NORMAL`, `TANGENT`, …). */
  targets?: Record<string, number>[];
  extensions?: { KHR_materials_variants?: { mappings?: GltfJsonVariantMapping[] } };
}

export interface GltfJsonMesh {
  name?: string;
  primitives: GltfJsonPrimitive[];
  /** Default morph weight per target. */
  weights?: number[];
}

export interface GltfJsonNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  /** Index into `GltfJson.cameras`. */
  camera?: number;
  extensions?: { KHR_lights_punctual?: { light: number } };
}

/** `KHR_texture_transform` on a texture reference (`extensions.KHR_texture_transform`). */
export interface GltfJsonTextureTransform {
  offset?: number[];
  rotation?: number;
  scale?: number[];
  texCoord?: number;
}

/** A glTF `textureInfo` (`normalTextureInfo` adds `scale`, `occlusionTextureInfo` `strength`). */
export interface GltfJsonTextureInfo {
  index: number;
  texCoord?: number;
  scale?: number;
  strength?: number;
  extensions?: { KHR_texture_transform?: GltfJsonTextureTransform };
}

export interface GltfJsonMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: GltfJsonTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfJsonTextureInfo;
  };
  normalTexture?: GltfJsonTextureInfo;
  occlusionTexture?: GltfJsonTextureInfo;
  emissiveTexture?: GltfJsonTextureInfo;
  emissiveFactor?: number[];
  doubleSided?: boolean;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  extensions?: {
    KHR_materials_emissive_strength?: { emissiveStrength?: number };
    KHR_materials_clearcoat?: {
      clearcoatFactor?: number;
      clearcoatTexture?: GltfJsonTextureInfo;
      clearcoatRoughnessFactor?: number;
      clearcoatRoughnessTexture?: GltfJsonTextureInfo;
      clearcoatNormalTexture?: GltfJsonTextureInfo;
    };
    KHR_materials_sheen?: {
      sheenColorFactor?: number[];
      sheenColorTexture?: GltfJsonTextureInfo;
      sheenRoughnessFactor?: number;
      sheenRoughnessTexture?: GltfJsonTextureInfo;
    };
    KHR_materials_transmission?: {
      transmissionFactor?: number;
      transmissionTexture?: GltfJsonTextureInfo;
    };
    KHR_materials_volume?: {
      thicknessFactor?: number;
      thicknessTexture?: GltfJsonTextureInfo;
      attenuationDistance?: number;
      attenuationColor?: number[];
    };
    KHR_materials_ior?: { ior?: number };
    KHR_materials_specular?: {
      specularFactor?: number;
      specularTexture?: GltfJsonTextureInfo;
      specularColorFactor?: number[];
      specularColorTexture?: GltfJsonTextureInfo;
    };
  };
}

export interface GltfJsonSkin {
  name?: string;
  /** Accessor of `MAT4` inverse bind matrices, one per joint (identity when absent). */
  inverseBindMatrices?: number;
  /** The skeleton root node. */
  skeleton?: number;
  joints: number[];
}

export type GltfJsonInterpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

export interface GltfJsonAnimationSampler {
  /** Accessor of keyframe times (`SCALAR` float, seconds, ascending). */
  input: number;
  /** Accessor of keyframe values (`VEC3`, `VEC4` or `SCALAR` weights; ×3 for `CUBICSPLINE`). */
  output: number;
  interpolation?: GltfJsonInterpolation;
}

export interface GltfJsonAnimationChannel {
  sampler: number;
  target: { node?: number; path: string };
}

export interface GltfJsonAnimation {
  name?: string;
  channels: GltfJsonAnimationChannel[];
  samplers: GltfJsonAnimationSampler[];
}

/** The parts of a glTF 2.0 JSON document the parser reads. Other properties pass through. */
export interface GltfJson {
  asset?: { version?: string; generator?: string };
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  scene?: number;
  scenes?: { name?: string; nodes?: number[] }[];
  nodes?: GltfJsonNode[];
  meshes?: GltfJsonMesh[];
  accessors?: GltfJsonAccessor[];
  bufferViews?: GltfJsonBufferView[];
  buffers?: {
    uri?: string;
    byteLength: number;
    /** `fallback: true` marks a buffer only `EXT_meshopt_compression` views point at (may have no data). */
    extensions?: { EXT_meshopt_compression?: { fallback?: boolean } };
  }[];
  materials?: GltfJsonMaterial[];
  textures?: {
    name?: string;
    source?: number;
    sampler?: number;
    extensions?: { KHR_texture_basisu?: { source: number } };
  }[];
  images?: { name?: string; uri?: string; mimeType?: string; bufferView?: number }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  skins?: GltfJsonSkin[];
  animations?: GltfJsonAnimation[];
  cameras?: GltfJsonCamera[];
  extensions?: {
    KHR_lights_punctual?: { lights?: GltfJsonLight[] };
    KHR_materials_variants?: { variants?: { name?: string }[] };
  };
}

// ---------------------------------------------------------------- the document

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/** An axis-aligned box and the sphere around it. */
export interface GltfBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  radius: number;
}

/** One `triangles` primitive, de-interleaved: `vertexCount` vertices, `indices.length / 3` triangles. */
export interface GltfPrimitive {
  vertexCount: number;
  /** xyz per vertex. */
  position: Float32Array;
  /** xyz per vertex; flat face normals when the file has none (vertices are then unwelded). */
  normal: Float32Array;
  /** uv per vertex (`TEXCOORD_0`); zeros when missing. */
  uv0: Float32Array;
  /** `TEXCOORD_1`, uv per vertex, or null when missing (the loader binds `uv0` only). */
  uv1: Float32Array | null;
  /**
   * `TANGENT`, xyzw per vertex (xyz the unit tangent along +u, w ±1 the handedness: the
   * bitangent is `w · cross(normal, tangent)`), or null. Follows the unwelding.
   */
  tangent: Float32Array | null;
  /** rgba per vertex (`COLOR_0`, a vec3 gets alpha 1); ones when missing. */
  color0: Float32Array;
  /** Triangle list; generated `0..n-1` when the file has none. */
  indices: Uint16Array | Uint32Array;
  /** Index into `GltfDocument.materials`, or null for the default material. */
  material: number | null;
  /** From the position accessor's `min`/`max` (computed from the data when absent). */
  bounds: GltfBounds;
  /** Whether the file carried normals (`false`: generated flat). */
  hadNormals: boolean;
  /**
   * `JOINTS_0`, 4 joint indices per vertex (into the node's skin `joints`), or null when the
   * primitive is not skinned. `Uint8Array` when every index fits a byte (the skinned vertex
   * layout's `uint8x4`), `Uint16Array` otherwise.
   */
  joints: Uint8Array | Uint16Array | null;
  /** `WEIGHTS_0`, 4 floats per vertex (normalised integers already divided), or null. */
  weights: Float32Array | null;
  /**
   * Morph targets, in file order (empty when the primitive has none). Each holds per-vertex
   * deltas (`vertexCount × 3`) that `anim`'s `createMorphBlender` adds to the base at the
   * target's weight; both follow the unwelding when flat normals are generated.
   */
  targets: GltfMorphTarget[];
  /** Target attributes the parser read past (`TANGENT`, `TEXCOORD_0`, …), once each. */
  ignoredTargetAttributes: string[];
  /**
   * `KHR_materials_variants` mappings: each binds `material` when one of `variants` (indices
   * into `GltfDocument.variants`) is active; empty when the primitive has none. A variant no
   * mapping names leaves the primitive on `material`.
   */
  variants: GltfVariantMapping[];
}

/** One `KHR_materials_variants` mapping of a primitive. */
export interface GltfVariantMapping {
  /** Index into `GltfDocument.materials`. */
  material: number;
  /** Indices into `GltfDocument.variants`. */
  variants: number[];
}

/**
 * One morph target: position and normal deltas, 3 floats per vertex, or null when the target
 * does not displace that attribute. The shape `anim/morph.ts` (`MorphTarget`) consumes.
 */
export interface GltfMorphTarget {
  position: Float32Array | null;
  normal: Float32Array | null;
}

export interface GltfMesh {
  name: string | null;
  primitives: GltfPrimitive[];
  /**
   * Default morph weights, one per target (`mesh.weights`), or null when the file gives none
   * (every target then starts at 0). The `weights` animation path writes the same layout.
   */
  weights: Float32Array | null;
}

export interface GltfNode {
  name: string | null;
  parent: number | null;
  children: number[];
  mesh: number | null;
  /** Index into `GltfDocument.skins`, or null. */
  skin: number | null;
  /** Index into the file's `cameras` the node carries, or null (`GltfDocument.cameras` places it). */
  camera: number | null;
  /** Index into the file's `KHR_lights_punctual` lights, or null (`GltfDocument.lights`). */
  light: number | null;
  /** TRS, decomposed from `matrix` when the node gave one. */
  translation: Vec3;
  rotation: Vec4;
  scale: Vec3;
  /** `T · R · S`, 3×4 row-major (the engine's `Transform.localMatrix` convention). */
  local: Float32Array;
  /** `parent.world · local`, 3×4 row-major. */
  world: Float32Array;
}

export type GltfAlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

/**
 * `KHR_texture_transform`: `uv' = offset + R(rotation) · (scale ⊙ uv)`, the spec's
 * `T · R · S` with `R` rotating by `rotation` radians counter-clockwise in uv space
 * (`u' = cos·su − sin·sv`, `v' = sin·su + cos·sv`). `transformUv` applies one.
 */
export interface GltfTextureTransform {
  offset: [number, number];
  rotation: number;
  scale: [number, number];
}

/** A material's reference to one of `GltfDocument.textures`. */
export interface TextureRef {
  /** Index into `GltfDocument.textures`. */
  index: number;
  /** Which `TEXCOORD_n` the slot reads (0 or 1; the loader binds `TEXCOORD_0` only). */
  texCoord: number;
  /** The slot's `KHR_texture_transform`, or null for identity. */
  transform: GltfTextureTransform | null;
}

/**
 * A glTF material, every slot of the metallic-roughness model. Factors default as the spec
 * says (base colour 1, metallic 1, roughness 1, normal scale 1, occlusion strength 1, emissive
 * 0); `emissiveFactor` already includes `KHR_materials_emissive_strength`. Texture conventions
 * are glTF's: base colour and emissive are sRGB, metallic-roughness has roughness in G and
 * metallic in B, occlusion is in R, the normal map is +Y up.
 */
export interface GltfMaterial {
  name: string | null;
  /** Linear RGBA multiplier (default 1, 1, 1, 1). */
  baseColorFactor: Vec4;
  baseColor: TextureRef | null;
  /** Default 1. */
  metallicFactor: number;
  /** Default 1. */
  roughnessFactor: number;
  metallicRoughness: TextureRef | null;
  normal: TextureRef | null;
  /** `normalTexture.scale`, default 1. */
  normalScale: number;
  occlusion: TextureRef | null;
  /** `occlusionTexture.strength`, default 1. */
  occlusionStrength: number;
  emissive: TextureRef | null;
  /** Linear RGB × `KHR_materials_emissive_strength` (default 0, 0, 0). */
  emissiveFactor: Vec3;
  doubleSided: boolean;
  alphaMode: GltfAlphaMode;
  /** For `MASK` (default 0.5). */
  alphaCutoff: number;
  /**
   * The `KHR_materials_*` extensions the parser reads but the standard material does not
   * render yet (clearcoat, sheen, transmission, volume, ior, specular), defaults filled; null
   * when the material does not carry one. `GltfDocument.unsupportedExtensions` lists them.
   */
  extensions: GltfMaterialExtensions;
  /** @deprecated `baseColor?.index ?? null`; removed next release. */
  baseColorTexture: number | null;
  /** @deprecated `baseColor?.texCoord ?? 0`; removed next release. */
  texCoord: number;
}

/** `KHR_materials_clearcoat`, spec defaults (factors 0). */
export interface GltfClearcoat {
  clearcoatFactor: number;
  clearcoatTexture: TextureRef | null;
  clearcoatRoughnessFactor: number;
  clearcoatRoughnessTexture: TextureRef | null;
  clearcoatNormalTexture: TextureRef | null;
}

/** `KHR_materials_sheen`, spec defaults (colour 0, roughness 0). */
export interface GltfSheen {
  sheenColorFactor: Vec3;
  sheenColorTexture: TextureRef | null;
  sheenRoughnessFactor: number;
  sheenRoughnessTexture: TextureRef | null;
}

/** `KHR_materials_transmission` (factor default 0). */
export interface GltfTransmission {
  transmissionFactor: number;
  transmissionTexture: TextureRef | null;
}

/** `KHR_materials_volume` (thickness 0, attenuation distance Infinity, colour white). */
export interface GltfVolume {
  thicknessFactor: number;
  thicknessTexture: TextureRef | null;
  attenuationDistance: number;
  attenuationColor: Vec3;
}

/** `KHR_materials_ior` (default 1.5). */
export interface GltfIor {
  ior: number;
}

/** `KHR_materials_specular` (factor 1, colour white). */
export interface GltfSpecular {
  specularFactor: number;
  specularTexture: TextureRef | null;
  specularColorFactor: Vec3;
  specularColorTexture: TextureRef | null;
}

/** The parsed-but-not-rendered `KHR_materials_*` records of one material. */
export interface GltfMaterialExtensions {
  clearcoat: GltfClearcoat | null;
  sheen: GltfSheen | null;
  transmission: GltfTransmission | null;
  volume: GltfVolume | null;
  ior: GltfIor | null;
  specular: GltfSpecular | null;
}

/**
 * One `KHR_lights_punctual` light placed by a node of the default scene. Units are glTF's:
 * world units are metres, angles radians, `intensity` candela (point, spot) or lux
 * (directional); `loadGltf` turns it into the engine's light records (`GltfScene.lights`).
 */
export interface GltfLight {
  name: string | null;
  /** The node carrying the light (index into `GltfDocument.nodes`). */
  node: number;
  /** Index into the file's `KHR_lights_punctual.lights`. */
  light: number;
  type: 'directional' | 'point' | 'spot';
  /** Linear RGB (default white). */
  color: Vec3;
  /** Default 1. */
  intensity: number;
  /** Distance where the light reaches zero; absent for "infinite" (and for directional lights). */
  range?: number;
  /** Spot only: full intensity inside this half-angle (default 0). */
  innerConeAngle?: number;
  /** Spot only: zero outside this half-angle (default π/4). */
  outerConeAngle?: number;
  /** World position of the node. */
  position: Vec3;
  /** Unit world direction the light travels: the node's local -Z. */
  direction: Vec3;
  /** The node's world matrix (3×4 row-major, shared with the node). */
  world: Float32Array;
}

/**
 * One glTF camera placed by a node of the default scene. Perspective: `yfov` radians,
 * `aspectRatio` (null: the viewport's), `znear`, `zfar` (null: infinite). Orthographic:
 * `xmag`, `ymag` (half extents), `znear`, `zfar`. The camera looks down its node's local -Z.
 */
export interface GltfCamera {
  name: string | null;
  /** The node carrying the camera. */
  node: number;
  /** Index into the file's `cameras`. */
  camera: number;
  type: 'perspective' | 'orthographic';
  yfov: number;
  aspectRatio: number | null;
  znear: number;
  zfar: number | null;
  xmag: number;
  ymag: number;
  position: Vec3;
  /** The node's world matrix (3×4 row-major, shared with the node). */
  world: Float32Array;
  /** The view matrix: the inverse of the node's world with scale removed, column-major 4×4. */
  view: Float32Array;
}

export type GltfFilter = 'nearest' | 'linear';
export type GltfWrap = 'repeat' | 'clamp-to-edge' | 'mirror-repeat';

/** A texture's sampler in GPU terms (`GPUSamplerDescriptor` names), defaults filled. */
export interface GltfSampler {
  /** Default `'linear'`. */
  magFilter: GltfFilter;
  /** Default `'linear'`. */
  minFilter: GltfFilter;
  /** Between mip levels; null when `minFilter` names no mipmap mode (then no mips). */
  mipmapFilter: GltfFilter | null;
  /** Default `'repeat'`. */
  wrapS: GltfWrap;
  wrapT: GltfWrap;
}

export interface GltfTexture {
  name: string | null;
  /** Index into `GltfDocument.images`, or null (an extension-only texture). */
  source: number | null;
  /**
   * `KHR_texture_basisu`: the KTX2 image (index into `GltfDocument.images`), or null. The
   * loader does not upload it yet (`parseKtx2` reads the container); `source`, when given, is
   * the file's PNG/JPEG fallback and is what `loadGltf` binds.
   */
  basisuSource: number | null;
  /** `wrapS`/`wrapT` are 10497 repeat (default), 33071 clamp, 33648 mirror. */
  wrapS: number;
  wrapT: number;
  /** 9728 nearest or 9729 linear, when the sampler gave one. */
  magFilter: number | null;
  /** The same sampler in GPU terms, defaults filled. */
  sampler: GltfSampler;
}

export interface GltfImage {
  name: string | null;
  /** Encoded image bytes (from a bufferView or a `data:` URI), or null when `uri` is external. */
  bytes: Uint8Array | null;
  /** `image/png`, `image/jpeg`, …; from the file or the data URI, null when unknown. */
  mimeType: string | null;
  /** An external URI the game resolves (`loadGltf` `opts.resources[uri]`), or null. */
  uri: string | null;
}

/** A skin: which nodes are joints and the matrix that takes a vertex into each joint's space. */
export interface GltfSkin {
  name: string | null;
  /** Node index per joint (`joints[j]` is the node joint `j` follows). */
  joints: number[];
  /**
   * Inverse bind matrix per joint, 3×4 row-major, 12 floats each (`joints.length * 12`),
   * converted from the file's column-major 4×4; identity when the file has none.
   */
  inverseBind: Float32Array;
  /** The skeleton root node the file named, or null. */
  skeleton: number | null;
}

export type GltfAnimationPath = 'translation' | 'rotation' | 'scale' | 'weights';
export type GltfInterpolation = 'STEP' | 'LINEAR' | 'CUBICSPLINE';

/**
 * One animated property of one node, in the shape of the animation module's `AnimationChannel`
 * (`src/anim/clip.ts`; restated here so `assets` does not import `anim`). `times` holds `n`
 * ascending seconds; `values` holds `n` elements of 3 (`translation`, `scale`), 4 (`rotation`,
 * quaternion xyzw exactly as the file stored them) or `k` (`weights`, one per morph target)
 * floats, or `3 * n` elements for `CUBICSPLINE` (in-tangent, value, out-tangent per keyframe).
 */
export interface GltfAnimationChannel {
  /** Index into `GltfDocument.nodes`. */
  node: number;
  path: GltfAnimationPath;
  interpolation: GltfInterpolation;
  times: Float32Array;
  values: Float32Array;
}

/** One clip, in the shape of the animation module's `AnimationClip`. */
export interface GltfAnimation {
  /** The file's name, or `animation<i>`. */
  name: string;
  /** The last keyframe time over every channel (0 for an empty clip). */
  duration: number;
  channels: GltfAnimationChannel[];
}

export interface GltfDocument {
  /** `asset.version`. */
  version: string;
  /** Root node indices of the default scene. */
  scene: number[];
  /** Every node reachable from `scene`, parents before children. */
  sceneNodes: number[];
  nodes: GltfNode[];
  meshes: GltfMesh[];
  materials: GltfMaterial[];
  textures: GltfTexture[];
  images: GltfImage[];
  skins: GltfSkin[];
  animations: GltfAnimation[];
  /** External (non-`data:`) URIs the game must fetch: images here, buffers at parse time. */
  externalUris: string[];
  /**
   * `extensionsUsed` entries the parser does not read, and anything else it skipped. Read
   * (never warned): `KHR_texture_transform`, `KHR_materials_emissive_strength`,
   * `KHR_mesh_quantization`, `EXT_meshopt_compression`, `KHR_lights_punctual`,
   * `KHR_materials_variants`, plus those in `unsupportedExtensions`.
   */
  warnings: string[];
  /**
   * `extensionsUsed` entries the parser reads into the document but the renderer does not
   * draw yet, once each: `KHR_materials_clearcoat`, `_sheen`, `_transmission`, `_volume`,
   * `_ior`, `_specular` (`GltfMaterial.extensions`) and `KHR_texture_basisu`
   * (`GltfTexture.basisuSource`).
   */
  unsupportedExtensions: string[];
  /** `KHR_lights_punctual` lights of the default scene, one per carrying node, in scene order. */
  lights: GltfLight[];
  /** Cameras of the default scene, one per carrying node, in scene order. */
  cameras: GltfCamera[];
  /** `KHR_materials_variants` names, in file order (`GltfScene.setVariant` takes one). */
  variants: string[];
  /** World-space bounds of the default scene's meshes; radius 0 at the origin when empty. */
  bounds: GltfBounds;
}

/**
 * A `.gltf` whose JSON the game already parsed. `buffers[i]` supplies `json.buffers[i]` when
 * that buffer has an external `uri` (or none, as in a GLB); `data:` buffers decode themselves.
 */
export interface GltfJsonSource {
  json: GltfJson;
  buffers?: ArrayBuffer[];
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const MODE_TRIANGLES = 4;

const COMPONENTS: Record<GltfAccessorType, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const COMPONENT_BYTES: Record<GltfComponentType, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

/**
 * Parse a GLB (`ArrayBuffer`), the UTF-8 text of a `.gltf` (`ArrayBuffer`), or a parsed
 * `.gltf` with its buffers. Throws `GltfError` on anything this step does not support.
 */
export function parseGltf(source: ArrayBuffer | GltfJsonSource): GltfDocument {
  const { json, buffers } = source instanceof ArrayBuffer ? readContainer(source) : source;
  return parseJson(json, buffers ?? []);
}

/** Split a GLB into its JSON and BIN chunks; bytes that are not a GLB are parsed as `.gltf` text. */
function readContainer(bytes: ArrayBuffer): GltfJsonSource {
  const view = new DataView(bytes);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new GltfError('not a GLB (bad magic) and not UTF-8 JSON');
    }
    return { json: parseJsonText(text) };
  }
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GltfError(`GLB version ${version}, expected 2`);
  const length = Math.min(view.getUint32(8, true), bytes.byteLength);
  let json: GltfJson | null = null;
  let bin: ArrayBuffer | null = null;
  let offset = 12;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) throw new GltfError('GLB chunk runs past the file');
    if (chunkType === CHUNK_JSON) {
      json = parseJsonText(new TextDecoder().decode(new Uint8Array(bytes, start, chunkLength)));
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = bytes.slice(start, start + chunkLength);
    }
    offset = start + chunkLength;
  }
  if (!json) throw new GltfError('GLB has no JSON chunk');
  return { json, buffers: bin ? [bin] : [] };
}

function parseJsonText(text: string): GltfJson {
  try {
    return JSON.parse(text) as GltfJson;
  } catch (e) {
    throw new GltfError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------- JSON → document

interface Ctx {
  json: GltfJson;
  buffers: ArrayBuffer[];
}

/** Extensions the parser reads, so neither `extensionsRequired` nor `warnings` mention them. */
const HANDLED_EXTENSIONS = new Set([
  'KHR_texture_transform',
  'KHR_materials_emissive_strength',
  'KHR_mesh_quantization',
  'EXT_meshopt_compression',
  'KHR_lights_punctual',
  'KHR_materials_variants',
]);

/** Extensions parsed into the document but not rendered: listed in `unsupportedExtensions`. */
const PARSED_EXTENSIONS = new Set([
  'KHR_materials_clearcoat',
  'KHR_materials_sheen',
  'KHR_materials_transmission',
  'KHR_materials_volume',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_texture_basisu',
]);

/** `minFilter` values whose base filter is nearest (9728, 9984 nearest-mipmap-nearest, 9986 nearest-mipmap-linear). */
const MIN_NEAREST = new Set([9728, 9984, 9986]);

function mipmapFilterOf(minFilter: number | undefined): GltfFilter | null {
  switch (minFilter) {
    case 9984: // NEAREST_MIPMAP_NEAREST
    case 9985: // LINEAR_MIPMAP_NEAREST
      return 'nearest';
    case 9986: // NEAREST_MIPMAP_LINEAR
    case 9987: // LINEAR_MIPMAP_LINEAR
    case undefined: // the spec leaves it to the implementation: trilinear is the engine default
      return 'linear';
    default:
      return null;
  }
}

function wrapOf(wrap: number | undefined): GltfWrap {
  if (wrap === 33071) return 'clamp-to-edge';
  if (wrap === 33648) return 'mirror-repeat';
  return 'repeat';
}

function textureRef(
  info: GltfJsonTextureInfo | undefined,
  textureCount: number,
  where: string,
): TextureRef | null {
  if (!info) return null;
  if (!Number.isInteger(info.index) || info.index < 0 || info.index >= textureCount) {
    throw new GltfError(`${where}: texture ${info.index} does not exist`);
  }
  const x = info.extensions?.KHR_texture_transform;
  let transform: GltfTextureTransform | null = null;
  if (x) {
    transform = {
      offset: [x.offset?.[0] ?? 0, x.offset?.[1] ?? 0],
      rotation: x.rotation ?? 0,
      scale: [x.scale?.[0] ?? 1, x.scale?.[1] ?? 1],
    };
  }
  return { index: info.index, texCoord: x?.texCoord ?? info.texCoord ?? 0, transform };
}

function parseMaterial(m: GltfJsonMaterial, i: number, textureCount: number): GltfMaterial {
  const where = `material ${i}`;
  const pbr = m.pbrMetallicRoughness;
  const f = pbr?.baseColorFactor;
  const e = m.emissiveFactor;
  const strength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  const baseColor = textureRef(pbr?.baseColorTexture, textureCount, `${where} baseColorTexture`);
  return {
    name: m.name ?? null,
    baseColorFactor: f ? [f[0] ?? 1, f[1] ?? 1, f[2] ?? 1, f[3] ?? 1] : [1, 1, 1, 1],
    baseColor,
    metallicFactor: pbr?.metallicFactor ?? 1,
    roughnessFactor: pbr?.roughnessFactor ?? 1,
    metallicRoughness: textureRef(
      pbr?.metallicRoughnessTexture,
      textureCount,
      `${where} metallicRoughnessTexture`,
    ),
    normal: textureRef(m.normalTexture, textureCount, `${where} normalTexture`),
    normalScale: m.normalTexture?.scale ?? 1,
    occlusion: textureRef(m.occlusionTexture, textureCount, `${where} occlusionTexture`),
    occlusionStrength: m.occlusionTexture?.strength ?? 1,
    emissive: textureRef(m.emissiveTexture, textureCount, `${where} emissiveTexture`),
    emissiveFactor: [(e?.[0] ?? 0) * strength, (e?.[1] ?? 0) * strength, (e?.[2] ?? 0) * strength],
    doubleSided: m.doubleSided ?? false,
    alphaMode: m.alphaMode ?? 'OPAQUE',
    alphaCutoff: m.alphaCutoff ?? 0.5,
    extensions: parseMaterialExtensions(m, where, textureCount),
    baseColorTexture: baseColor?.index ?? null,
    texCoord: baseColor?.texCoord ?? 0,
  };
}

function vec3Of(v: number[] | undefined, fallback: number): Vec3 {
  return [v?.[0] ?? fallback, v?.[1] ?? fallback, v?.[2] ?? fallback];
}

function parseMaterialExtensions(
  m: GltfJsonMaterial,
  where: string,
  textureCount: number,
): GltfMaterialExtensions {
  const x = m.extensions;
  const ref = (info: GltfJsonTextureInfo | undefined, slot: string) =>
    textureRef(info, textureCount, `${where} ${slot}`);
  const cc = x?.KHR_materials_clearcoat;
  const sh = x?.KHR_materials_sheen;
  const tr = x?.KHR_materials_transmission;
  const vo = x?.KHR_materials_volume;
  const io = x?.KHR_materials_ior;
  const sp = x?.KHR_materials_specular;
  return {
    clearcoat: cc
      ? {
          clearcoatFactor: cc.clearcoatFactor ?? 0,
          clearcoatTexture: ref(cc.clearcoatTexture, 'clearcoatTexture'),
          clearcoatRoughnessFactor: cc.clearcoatRoughnessFactor ?? 0,
          clearcoatRoughnessTexture: ref(cc.clearcoatRoughnessTexture, 'clearcoatRoughnessTexture'),
          clearcoatNormalTexture: ref(cc.clearcoatNormalTexture, 'clearcoatNormalTexture'),
        }
      : null,
    sheen: sh
      ? {
          sheenColorFactor: vec3Of(sh.sheenColorFactor, 0),
          sheenColorTexture: ref(sh.sheenColorTexture, 'sheenColorTexture'),
          sheenRoughnessFactor: sh.sheenRoughnessFactor ?? 0,
          sheenRoughnessTexture: ref(sh.sheenRoughnessTexture, 'sheenRoughnessTexture'),
        }
      : null,
    transmission: tr
      ? {
          transmissionFactor: tr.transmissionFactor ?? 0,
          transmissionTexture: ref(tr.transmissionTexture, 'transmissionTexture'),
        }
      : null,
    volume: vo
      ? {
          thicknessFactor: vo.thicknessFactor ?? 0,
          thicknessTexture: ref(vo.thicknessTexture, 'thicknessTexture'),
          attenuationDistance: vo.attenuationDistance ?? Infinity,
          attenuationColor: vec3Of(vo.attenuationColor, 1),
        }
      : null,
    ior: io ? { ior: io.ior ?? 1.5 } : null,
    specular: sp
      ? {
          specularFactor: sp.specularFactor ?? 1,
          specularTexture: ref(sp.specularTexture, 'specularTexture'),
          specularColorFactor: vec3Of(sp.specularColorFactor, 1),
          specularColorTexture: ref(sp.specularColorTexture, 'specularColorTexture'),
        }
      : null,
  };
}

/**
 * Apply a `KHR_texture_transform` to one uv (`T · R · S · uv`): `out[0], out[1]` ← the
 * transformed `u, v`. Returns `out`.
 */
export function transformUv(
  t: GltfTextureTransform,
  u: number,
  v: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const su = u * t.scale[0];
  const sv = v * t.scale[1];
  out[0] = c * su - s * sv + t.offset[0];
  out[1] = s * su + c * sv + t.offset[1];
  return out;
}

/**
 * `EXT_meshopt_compression`: decode every compressed buffer view into its own buffer (appended
 * to `buffers`) and return a shallow copy of `json` whose views point at the decoded bytes. A
 * view without the extension, or a file without any, is read as written (`json` returned as is).
 */
function decodeMeshoptViews(json: GltfJson, buffers: ArrayBuffer[]): GltfJson {
  const views = json.bufferViews ?? [];
  if (!views.some((v) => v.extensions?.EXT_meshopt_compression)) return json;
  const out = views.map((bv, i): GltfJsonBufferView => {
    const x = bv.extensions?.EXT_meshopt_compression;
    if (!x) return bv;
    const where = `bufferView ${i} (EXT_meshopt_compression)`;
    const src = buffers[x.buffer];
    if (!src) throw new GltfError(`${where}: buffer ${x.buffer} does not exist`);
    const off = x.byteOffset ?? 0;
    if (off + x.byteLength > src.byteLength) {
      throw new GltfError(`${where}: stream runs past buffer ${x.buffer}`);
    }
    const target = new Uint8Array(x.count * x.byteStride);
    try {
      decodeMeshopt(
        target,
        x.count,
        x.byteStride,
        new Uint8Array(src, off, x.byteLength),
        x.mode,
        x.filter ?? 'NONE',
      );
    } catch (e) {
      throw new GltfError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    buffers.push(target.buffer);
    const view: GltfJsonBufferView = {
      buffer: buffers.length - 1,
      byteOffset: 0,
      byteLength: Math.min(bv.byteLength, target.byteLength),
    };
    if (bv.byteStride !== undefined) view.byteStride = bv.byteStride;
    return view;
  });
  return { ...json, bufferViews: out };
}

function parseJson(json: GltfJson, given: ArrayBuffer[]): GltfDocument {
  const version = json.asset?.version ?? '';
  if (!version.startsWith('2.')) throw new GltfError(`asset.version "${version}", expected 2.x`);
  const required = (json.extensionsRequired ?? []).filter(
    (e) => !HANDLED_EXTENSIONS.has(e) && !PARSED_EXTENSIONS.has(e),
  );
  if (required.length > 0) {
    throw new GltfError(`required extensions not supported: ${required.join(', ')}`);
  }
  const warnings: string[] = [];
  const unsupportedExtensions: string[] = [];
  for (const ext of new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])])) {
    if (PARSED_EXTENSIONS.has(ext)) unsupportedExtensions.push(ext);
    else if (!HANDLED_EXTENSIONS.has(ext)) warnings.push(`extension ignored: ${ext}`);
  }
  const externalUris: string[] = [];

  const buffers = (json.buffers ?? []).map((b, i) => {
    if (b.uri !== undefined && isDataUri(b.uri)) return decodeDataUri(b.uri).bytes.buffer;
    const bytes = given[i];
    if (!bytes && b.extensions?.EXT_meshopt_compression?.fallback) {
      // A meshopt fallback buffer with no data: only compressed views point at it.
      return new ArrayBuffer(0);
    }
    if (!bytes) {
      throw new GltfError(
        b.uri === undefined
          ? `buffer ${i} has no uri and no GLB BIN chunk`
          : `buffer ${i} needs external resource "${b.uri}" (pass it in buffers[${i}])`,
      );
    }
    if (b.uri !== undefined) externalUris.push(b.uri);
    return bytes;
  });
  const ctx: Ctx = { json: decodeMeshoptViews(json, buffers), buffers };

  const images: GltfImage[] = (json.images ?? []).map((img, i) => {
    const name = img.name ?? null;
    if (img.bufferView !== undefined) {
      const view = bufferViewBytes(ctx, img.bufferView, `image ${i}`);
      return { name, bytes: view, mimeType: img.mimeType ?? null, uri: null };
    }
    if (img.uri === undefined) throw new GltfError(`image ${i} has neither uri nor bufferView`);
    if (isDataUri(img.uri)) {
      const d = decodeDataUri(img.uri);
      return { name, bytes: d.bytes, mimeType: img.mimeType ?? d.mimeType, uri: null };
    }
    externalUris.push(img.uri);
    return { name, bytes: null, mimeType: img.mimeType ?? mimeFromUri(img.uri), uri: img.uri };
  });

  const textures: GltfTexture[] = (json.textures ?? []).map((t) => {
    const s = t.sampler !== undefined ? json.samplers?.[t.sampler] : undefined;
    return {
      name: t.name ?? null,
      source: t.source ?? null,
      basisuSource: t.extensions?.KHR_texture_basisu?.source ?? null,
      wrapS: s?.wrapS ?? 10497,
      wrapT: s?.wrapT ?? 10497,
      magFilter: s?.magFilter ?? null,
      sampler: {
        magFilter: s?.magFilter === 9728 ? 'nearest' : 'linear',
        minFilter: MIN_NEAREST.has(s?.minFilter ?? 0) ? 'nearest' : 'linear',
        mipmapFilter: mipmapFilterOf(s?.minFilter),
        wrapS: wrapOf(s?.wrapS),
        wrapT: wrapOf(s?.wrapT),
      },
    };
  });

  const materials: GltfMaterial[] = (json.materials ?? []).map((m, i) =>
    parseMaterial(m, i, textures.length),
  );

  const meshes: GltfMesh[] = (json.meshes ?? []).map((m, mi) => parseMesh(ctx, m, mi));

  const lightDefs = json.extensions?.KHR_lights_punctual?.lights ?? [];
  const nodes = parseNodes(
    json.nodes ?? [],
    meshes.length,
    (json.skins ?? []).length,
    (json.cameras ?? []).length,
    lightDefs.length,
  );
  const skins = (json.skins ?? []).map((s, i) => parseSkin(ctx, s, i, nodes.length));
  const animations = (json.animations ?? []).map((a, i) =>
    parseAnimation(ctx, a, i, nodes.length, warnings),
  );
  const roots = sceneRoots(json, nodes);
  const sceneNodes: number[] = [];
  const visit = (i: number) => {
    sceneNodes.push(i);
    for (const c of nodes[i]!.children) visit(c);
  };
  for (const r of roots) visit(r);

  const variants = (json.extensions?.KHR_materials_variants?.variants ?? []).map(
    (v, i) => v.name ?? `variant${i}`,
  );
  meshes.forEach((m, mi) => {
    m.primitives.forEach((p, pi) => {
      for (const map of p.variants) {
        for (const v of map.variants) {
          if (!Number.isInteger(v) || v < 0 || v >= variants.length) {
            throw new GltfError(`mesh ${mi} primitive ${pi}: variant ${v} does not exist`);
          }
        }
      }
    });
  });

  return {
    version,
    scene: roots,
    sceneNodes,
    nodes,
    meshes,
    materials,
    textures,
    images,
    skins,
    animations,
    externalUris,
    warnings,
    unsupportedExtensions,
    lights: placeLights(lightDefs, nodes, sceneNodes),
    cameras: placeCameras(json.cameras ?? [], nodes, sceneNodes),
    variants,
    bounds: sceneBounds(nodes, meshes, sceneNodes),
  };
}

/** The node's world -Z, normalised (the direction glTF lights shine and cameras look). */
function forwardOf(w: Float32Array): Vec3 {
  const x = -w[2]!;
  const y = -w[6]!;
  const z = -w[10]!;
  const l = Math.hypot(x, y, z) || 1;
  // `+ 0` turns the -0 of an axis-aligned node into 0.
  return [x / l + 0, y / l + 0, z / l + 0];
}

function placeLights(defs: GltfJsonLight[], nodes: GltfNode[], sceneNodes: number[]): GltfLight[] {
  const out: GltfLight[] = [];
  for (const ni of sceneNodes) {
    const n = nodes[ni]!;
    if (n.light === null) continue;
    const d = defs[n.light]!;
    const where = `light ${n.light}`;
    if (d.type !== 'directional' && d.type !== 'point' && d.type !== 'spot') {
      throw new GltfError(`${where}: type "${String(d.type)}" unknown`);
    }
    const light: GltfLight = {
      name: d.name ?? null,
      node: ni,
      light: n.light,
      type: d.type,
      color: vec3Of(d.color, 1),
      intensity: d.intensity ?? 1,
      position: [n.world[3]!, n.world[7]!, n.world[11]!],
      direction: forwardOf(n.world),
      world: n.world,
    };
    if (d.type !== 'directional' && d.range !== undefined) {
      if (!(d.range > 0)) throw new GltfError(`${where}: range ${d.range} must be > 0`);
      light.range = d.range;
    }
    if (d.type === 'spot') {
      const inner = d.spot?.innerConeAngle ?? 0;
      const outer = d.spot?.outerConeAngle ?? Math.PI / 4;
      if (!(inner >= 0 && inner < outer && outer <= Math.PI / 2)) {
        throw new GltfError(
          `${where}: cone angles ${inner}, ${outer} need 0 <= inner < outer <= π/2`,
        );
      }
      light.innerConeAngle = inner;
      light.outerConeAngle = outer;
    }
    out.push(light);
  }
  return out;
}

function placeCameras(
  defs: GltfJsonCamera[],
  nodes: GltfNode[],
  sceneNodes: number[],
): GltfCamera[] {
  const out: GltfCamera[] = [];
  for (const ni of sceneNodes) {
    const n = nodes[ni]!;
    if (n.camera === null) continue;
    const d = defs[n.camera]!;
    const where = `camera ${n.camera}`;
    const c: GltfCamera = {
      name: d.name ?? null,
      node: ni,
      camera: n.camera,
      type: d.type,
      yfov: 0,
      aspectRatio: null,
      znear: 0,
      zfar: null,
      xmag: 0,
      ymag: 0,
      position: [n.world[3]!, n.world[7]!, n.world[11]!],
      world: n.world,
      view: viewOf(n.world),
    };
    if (d.type === 'perspective') {
      const p = d.perspective;
      if (!p) throw new GltfError(`${where}: perspective camera without "perspective"`);
      c.yfov = p.yfov;
      c.aspectRatio = p.aspectRatio ?? null;
      c.znear = p.znear;
      c.zfar = p.zfar ?? null;
    } else if (d.type === 'orthographic') {
      const o = d.orthographic;
      if (!o) throw new GltfError(`${where}: orthographic camera without "orthographic"`);
      c.xmag = o.xmag;
      c.ymag = o.ymag;
      c.znear = o.znear;
      c.zfar = o.zfar;
    } else {
      throw new GltfError(`${where}: type "${String(d.type)}" unknown`);
    }
    out.push(c);
  }
  return out;
}

/** The inverse of a 3×4 row-major world matrix with its scale removed, as a column-major 4×4. */
function viewOf(w: Float32Array): Float32Array {
  const v = new Float32Array(16);
  // Column j of the world rotation is the node's local axis j; its length is that axis' scale.
  const len = [0, 1, 2].map((j) => Math.hypot(w[j]!, w[4 + j]!, w[8 + j]!) || 1);
  const t = [w[3]!, w[7]!, w[11]!];
  for (let r = 0; r < 3; r++) {
    // View rotation row r = world rotation column r, normalised; column-major index c * 4 + r.
    for (let c = 0; c < 3; c++) v[c * 4 + r] = w[c * 4 + r]! / len[r]!;
    v[12 + r] = -(v[r]! * t[0]! + v[4 + r]! * t[1]! + v[8 + r]! * t[2]!);
  }
  v[15] = 1;
  return v;
}

function sceneRoots(json: GltfJson, nodes: GltfNode[]): number[] {
  const scenes = json.scenes ?? [];
  if (scenes.length > 0) {
    const i = json.scene ?? 0;
    const s = scenes[i];
    if (!s) throw new GltfError(`scene ${i} does not exist`);
    for (const n of s.nodes ?? []) {
      if (!nodes[n]) throw new GltfError(`scene ${i} names node ${n}, which does not exist`);
    }
    return [...(s.nodes ?? [])];
  }
  return nodes.flatMap((n, i) => (n.parent === null ? [i] : []));
}

// ---------------------------------------------------------------- nodes and matrices

function parseNodes(
  src: GltfJsonNode[],
  meshCount: number,
  skinCount: number,
  cameraCount: number,
  lightCount: number,
): GltfNode[] {
  const nodes: GltfNode[] = src.map((n, i) => {
    if (n.camera !== undefined && !(n.camera >= 0 && n.camera < cameraCount)) {
      throw new GltfError(`node ${i} names camera ${n.camera}, which does not exist`);
    }
    const light = n.extensions?.KHR_lights_punctual?.light;
    if (light !== undefined && !(light >= 0 && light < lightCount)) {
      throw new GltfError(`node ${i} names light ${light}, which does not exist`);
    }
    if (n.mesh !== undefined && (n.mesh < 0 || n.mesh >= meshCount)) {
      throw new GltfError(`node ${i} names mesh ${n.mesh}, which does not exist`);
    }
    if (n.skin !== undefined && (n.skin < 0 || n.skin >= skinCount)) {
      throw new GltfError(`node ${i} names skin ${n.skin}, which does not exist`);
    }
    const node: GltfNode = {
      name: n.name ?? null,
      parent: null,
      children: [...(n.children ?? [])],
      mesh: n.mesh ?? null,
      skin: n.skin ?? null,
      camera: n.camera ?? null,
      light: light ?? null,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      local: new Float32Array(12),
      world: new Float32Array(12),
    };
    if (n.matrix) {
      if (n.matrix.length !== 16)
        throw new GltfError(`node ${i} matrix has ${n.matrix.length} values`);
      columnMajorToRows(n.matrix, node.local);
      decompose(node.local, node.translation, node.rotation, node.scale);
    } else {
      if (n.translation)
        node.translation = [n.translation[0]!, n.translation[1]!, n.translation[2]!];
      if (n.rotation) {
        node.rotation = [n.rotation[0]!, n.rotation[1]!, n.rotation[2]!, n.rotation[3]!];
      }
      if (n.scale) node.scale = [n.scale[0]!, n.scale[1]!, n.scale[2]!];
      composeTrs(node.translation, node.rotation, node.scale, node.local);
    }
    return node;
  });
  nodes.forEach((n, i) => {
    for (const c of n.children) {
      const child = nodes[c];
      if (!child) throw new GltfError(`node ${i} names child ${c}, which does not exist`);
      if (child.parent !== null) throw new GltfError(`node ${c} has two parents`);
      child.parent = i;
    }
  });
  // World matrices, parents first; a cycle would never reach a root, so detect it by depth.
  const done = new Uint8Array(nodes.length);
  const resolve = (i: number, depth: number): void => {
    if (done[i]) return;
    if (depth > nodes.length) throw new GltfError('node hierarchy has a cycle');
    const n = nodes[i]!;
    if (n.parent === null) {
      n.world.set(n.local);
    } else {
      resolve(n.parent, depth + 1);
      multiply3x4(n.world, nodes[n.parent]!.world, n.local);
    }
    done[i] = 1;
  };
  for (let i = 0; i < nodes.length; i++) resolve(i, 0);
  return nodes;
}

/** glTF column-major 4×4 at `m[from..]` → the engine's 3×4 row-major at `out[to..]` (last row dropped). */
function columnMajorToRows(m: ArrayLike<number>, out: Float32Array, from = 0, to = 0): void {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) out[to + r * 4 + c] = m[from + c * 4 + r]!;
  }
}

// ---------------------------------------------------------------- skins and animations

function parseSkin(ctx: Ctx, s: GltfJsonSkin, i: number, nodeCount: number): GltfSkin {
  const where = `skin ${i}`;
  if (!Array.isArray(s.joints) || s.joints.length === 0) {
    throw new GltfError(`${where} has no joints`);
  }
  for (const j of s.joints) {
    if (!Number.isInteger(j) || j < 0 || j >= nodeCount) {
      throw new GltfError(`${where} names joint node ${j}, which does not exist`);
    }
  }
  if (s.skeleton !== undefined && (s.skeleton < 0 || s.skeleton >= nodeCount)) {
    throw new GltfError(`${where} names skeleton node ${s.skeleton}, which does not exist`);
  }
  const n = s.joints.length;
  const inverseBind = new Float32Array(n * 12);
  if (s.inverseBindMatrices !== undefined) {
    const acc = accessor(ctx, s.inverseBindMatrices, where);
    if (acc.type !== 'MAT4') {
      throw new GltfError(`${where}: inverseBindMatrices is ${acc.type}, expected MAT4`);
    }
    if (acc.count !== n) {
      throw new GltfError(`${where}: ${acc.count} inverse bind matrices for ${n} joints`);
    }
    const m = readFloats(ctx, acc, 16, where);
    for (let j = 0; j < n; j++) columnMajorToRows(m, inverseBind, j * 16, j * 12);
  } else {
    for (let j = 0; j < n; j++) {
      inverseBind[j * 12] = 1;
      inverseBind[j * 12 + 5] = 1;
      inverseBind[j * 12 + 10] = 1;
    }
  }
  return { name: s.name ?? null, joints: [...s.joints], inverseBind, skeleton: s.skeleton ?? null };
}

/** Components per keyframe value; null for `weights` (one per morph target, any count). */
const PATH_COMPONENTS: Record<GltfAnimationPath, number | null> = {
  translation: 3,
  rotation: 4,
  scale: 3,
  weights: null,
};

function parseAnimation(
  ctx: Ctx,
  a: GltfJsonAnimation,
  i: number,
  nodeCount: number,
  warnings: string[],
): GltfAnimation {
  const where = `animation ${i}`;
  const channels: GltfAnimationChannel[] = [];
  let duration = 0;
  (a.channels ?? []).forEach((c, ci) => {
    const here = `${where} channel ${ci}`;
    const target = c.target;
    if (!target) throw new GltfError(`${here} has no target`);
    if (target.node === undefined) {
      warnings.push(`${here} ignored: no target node`);
      return;
    }
    if (target.node < 0 || target.node >= nodeCount) {
      throw new GltfError(`${here} targets node ${target.node}, which does not exist`);
    }
    const path = target.path as GltfAnimationPath;
    if (!(path in PATH_COMPONENTS)) throw new GltfError(`${here}: path "${target.path}" unknown`);
    const sampler = (a.samplers ?? [])[c.sampler];
    if (!sampler) throw new GltfError(`${here}: sampler ${c.sampler} does not exist`);
    const interpolation = sampler.interpolation ?? 'LINEAR';
    if (interpolation !== 'LINEAR' && interpolation !== 'STEP' && interpolation !== 'CUBICSPLINE') {
      throw new GltfError(`${here}: interpolation "${interpolation}" unknown`);
    }
    const inAcc = accessor(ctx, sampler.input, here);
    if (inAcc.type !== 'SCALAR') {
      throw new GltfError(`${here}: input is ${inAcc.type}, expected SCALAR`);
    }
    const times = readFloats(ctx, inAcc, 1, here);
    for (let k = 1; k < times.length; k++) {
      if (!(times[k]! >= times[k - 1]!)) {
        throw new GltfError(`${here}: keyframe times are not ascending`);
      }
    }
    const outAcc = accessor(ctx, sampler.output, here);
    const have = COMPONENTS[outAcc.type];
    const want = PATH_COMPONENTS[path];
    if (want !== null && have !== want) {
      throw new GltfError(`${here}: ${path} output is ${outAcc.type}, expected ${want} components`);
    }
    const perKey = interpolation === 'CUBICSPLINE' ? 3 : 1;
    const n = times.length;
    // `weights` holds one value per morph target per key; the TRS paths exactly one.
    const wrong =
      want === null
        ? outAcc.count === 0 || outAcc.count % (n * perKey) !== 0
        : outAcc.count !== n * perKey;
    if (n > 0 && wrong) {
      const hint = perKey === 3 ? ' (×3 for CUBICSPLINE)' : '';
      throw new GltfError(`${here}: ${outAcc.count} output values for ${n} keyframes${hint}`);
    }
    const values = readFloats(ctx, outAcc, have, here);
    if (n > 0) duration = Math.max(duration, times[n - 1]!);
    channels.push({ node: target.node, path, interpolation, times, values });
  });
  return { name: a.name ?? `animation${i}`, duration, channels };
}

/** `T · R · S` as 3×4 row-major (the same formula as `Transform.updateLocal`). */
export function composeTrs(t: Vec3, q: Vec4, s: Vec3, out: Float32Array): void {
  const [x, y, z, w] = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  out[0] = (1 - 2 * (yy + zz)) * s[0];
  out[1] = 2 * (xy - wz) * s[1];
  out[2] = 2 * (xz + wy) * s[2];
  out[3] = t[0];
  out[4] = 2 * (xy + wz) * s[0];
  out[5] = (1 - 2 * (xx + zz)) * s[1];
  out[6] = 2 * (yz - wx) * s[2];
  out[7] = t[1];
  out[8] = 2 * (xz - wy) * s[0];
  out[9] = 2 * (yz + wx) * s[1];
  out[10] = (1 - 2 * (xx + yy)) * s[2];
  out[11] = t[2];
}

/** TRS from a 3×4 affine matrix (glTF matrices are TRS by spec; shear is not preserved). */
function decompose(m: Float32Array, t: Vec3, q: Vec4, s: Vec3): void {
  t[0] = m[3]!;
  t[1] = m[7]!;
  t[2] = m[11]!;
  // Columns are the scaled basis vectors.
  s[0] = Math.hypot(m[0]!, m[4]!, m[8]!);
  s[1] = Math.hypot(m[1]!, m[5]!, m[9]!);
  s[2] = Math.hypot(m[2]!, m[6]!, m[10]!);
  // A negative determinant flips one axis.
  const det =
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) +
    m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
  if (det < 0) s[0] = -s[0];
  const sx = s[0] || 1;
  const sy = s[1] || 1;
  const sz = s[2] || 1;
  const r00 = m[0]! / sx;
  const r01 = m[1]! / sy;
  const r02 = m[2]! / sz;
  const r10 = m[4]! / sx;
  const r11 = m[5]! / sy;
  const r12 = m[6]! / sz;
  const r20 = m[8]! / sx;
  const r21 = m[9]! / sy;
  const r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  if (trace > 0) {
    const k = Math.sqrt(trace + 1) * 2;
    q[3] = k / 4;
    q[0] = (r21 - r12) / k;
    q[1] = (r02 - r20) / k;
    q[2] = (r10 - r01) / k;
  } else if (r00 > r11 && r00 > r22) {
    const k = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q[3] = (r21 - r12) / k;
    q[0] = k / 4;
    q[1] = (r01 + r10) / k;
    q[2] = (r02 + r20) / k;
  } else if (r11 > r22) {
    const k = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q[3] = (r02 - r20) / k;
    q[0] = (r01 + r10) / k;
    q[1] = k / 4;
    q[2] = (r12 + r21) / k;
  } else {
    const k = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q[3] = (r10 - r01) / k;
    q[0] = (r02 + r20) / k;
    q[1] = (r12 + r21) / k;
    q[2] = k / 4;
  }
}

/** `out = a · b` for 3×4 affine matrices (implicit last row `0 0 0 1`). */
function multiply3x4(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4]!;
    const a1 = a[r * 4 + 1]!;
    const a2 = a[r * 4 + 2]!;
    const a3 = a[r * 4 + 3]!;
    out[r * 4] = a0 * b[0]! + a1 * b[4]! + a2 * b[8]!;
    out[r * 4 + 1] = a0 * b[1]! + a1 * b[5]! + a2 * b[9]!;
    out[r * 4 + 2] = a0 * b[2]! + a1 * b[6]! + a2 * b[10]!;
    out[r * 4 + 3] = a0 * b[3]! + a1 * b[7]! + a2 * b[11]! + a3;
  }
}

function sceneBounds(nodes: GltfNode[], meshes: GltfMesh[], sceneNodes: number[]): GltfBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const ni of sceneNodes) {
    const n = nodes[ni]!;
    if (n.mesh === null) continue;
    const m = n.world;
    for (const p of meshes[n.mesh]!.primitives) {
      const b = p.bounds;
      for (let corner = 0; corner < 8; corner++) {
        const x = corner & 1 ? b.max[0] : b.min[0];
        const y = corner & 2 ? b.max[1] : b.min[1];
        const z = corner & 4 ? b.max[2] : b.min[2];
        for (let r = 0; r < 3; r++) {
          const v = m[r * 4]! * x + m[r * 4 + 1]! * y + m[r * 4 + 2]! * z + m[r * 4 + 3]!;
          if (v < min[r]!) min[r] = v;
          if (v > max[r]!) max[r] = v;
        }
      }
      any = true;
    }
  }
  if (!any) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0 };
  return boundsOf(min, max);
}

function boundsOf(min: Vec3, max: Vec3): GltfBounds {
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  return { min, max, center, radius };
}

// ---------------------------------------------------------------- primitives and accessors

function parseMesh(ctx: Ctx, m: GltfJsonMesh, mi: number): GltfMesh {
  const where = `mesh ${mi}`;
  const primitives = m.primitives.map((p, pi) =>
    parsePrimitive(ctx, p, `${where} primitive ${pi}`),
  );
  const targetCount = primitives[0]?.targets.length ?? 0;
  for (let pi = 1; pi < primitives.length; pi++) {
    const n = primitives[pi]!.targets.length;
    if (n !== targetCount) {
      throw new GltfError(
        `${where}: primitive ${pi} has ${n} morph targets, primitive 0 has ${targetCount}`,
      );
    }
  }
  let weights: Float32Array | null = null;
  if (m.weights !== undefined) {
    if (m.weights.length !== targetCount) {
      throw new GltfError(
        `${where}: ${m.weights.length} default weights for ${targetCount} morph targets`,
      );
    }
    weights = new Float32Array(m.weights);
  }
  return { name: m.name ?? null, primitives, weights };
}

/** The target attributes this parser reads; others are listed in `ignoredTargetAttributes`. */
const MORPH_ATTRIBUTES = new Set(['POSITION', 'NORMAL']);

/**
 * `primitive.targets`: `POSITION` and `NORMAL` deltas per target, each `vertexCount` vec3s.
 * Target accessors may be sparse (the usual encoding for deltas): the dense data (or zeros,
 * without a bufferView) is overlaid with `sparse.count` values at `sparse.indices`.
 */
function readTargets(
  ctx: Ctx,
  targets: Record<string, number>[] | undefined,
  vertexCount: number,
  where: string,
  ignored: string[],
): GltfMorphTarget[] {
  if (!targets) return [];
  return targets.map((t, ti) => {
    const here = `${where} target ${ti}`;
    for (const name of Object.keys(t)) {
      if (!MORPH_ATTRIBUTES.has(name) && !ignored.includes(name)) ignored.push(name);
    }
    return {
      position: readTargetDeltas(ctx, t.POSITION, vertexCount, `${here} POSITION`),
      normal: readTargetDeltas(ctx, t.NORMAL, vertexCount, `${here} NORMAL`),
    };
  });
}

function readTargetDeltas(
  ctx: Ctx,
  index: number | undefined,
  vertexCount: number,
  where: string,
): Float32Array | null {
  if (index === undefined) return null;
  const acc = accessor(ctx, index, where, true);
  if (acc.type !== 'VEC3') throw new GltfError(`${where}: ${acc.type}, expected VEC3`);
  if (acc.count !== vertexCount) {
    throw new GltfError(`${where}: ${acc.count} values for ${vertexCount} vertices`);
  }
  return readFloats(ctx, acc, 3, where);
}

function parsePrimitive(ctx: Ctx, p: GltfJsonPrimitive, where: string): GltfPrimitive {
  const mode = p.mode ?? MODE_TRIANGLES;
  if (mode !== MODE_TRIANGLES) {
    throw new GltfError(`${where}: mode ${mode} not supported (only 4, triangles)`);
  }
  const posIndex = p.attributes.POSITION;
  if (posIndex === undefined) throw new GltfError(`${where}: no POSITION attribute`);
  const posAcc = accessor(ctx, posIndex, where);
  if (posAcc.type !== 'VEC3')
    throw new GltfError(`${where}: POSITION is ${posAcc.type}, expected VEC3`);
  const vertexCount = posAcc.count;
  let position = readFloats(ctx, posAcc, 3, where);

  let indices: Uint16Array | Uint32Array;
  if (p.indices !== undefined) {
    const acc = accessor(ctx, p.indices, where);
    if (acc.type !== 'SCALAR')
      throw new GltfError(`${where}: indices are ${acc.type}, expected SCALAR`);
    indices = readIndices(ctx, acc, where);
    for (let i = 0; i < indices.length; i++) {
      if (indices[i]! >= vertexCount) {
        throw new GltfError(`${where}: index ${indices[i]} out of range (${vertexCount} vertices)`);
      }
    }
  } else {
    indices = vertexCount > 0xffff ? new Uint32Array(vertexCount) : new Uint16Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }
  if (indices.length % 3 !== 0) {
    throw new GltfError(`${where}: ${indices.length} indices is not a whole number of triangles`);
  }

  let uv0 = optionalFloats(ctx, p.attributes.TEXCOORD_0, vertexCount, 2, `${where} TEXCOORD_0`);
  let uv1 = optionalFloats(ctx, p.attributes.TEXCOORD_1, vertexCount, 2, `${where} TEXCOORD_1`);
  let color0 = optionalFloats(ctx, p.attributes.COLOR_0, vertexCount, 4, `${where} COLOR_0`, 1);
  if (!uv0) uv0 = new Float32Array(vertexCount * 2);
  if (!color0) color0 = new Float32Array(vertexCount * 4).fill(1);
  let tangent = readTangents(ctx, p.attributes.TANGENT, vertexCount, `${where} TANGENT`);

  let joints = readJoints(ctx, p.attributes.JOINTS_0, vertexCount, `${where} JOINTS_0`);
  let weights = optionalFloats(ctx, p.attributes.WEIGHTS_0, vertexCount, 4, `${where} WEIGHTS_0`);
  if (joints && !weights) throw new GltfError(`${where}: JOINTS_0 without WEIGHTS_0`);
  if (weights && !joints) throw new GltfError(`${where}: WEIGHTS_0 without JOINTS_0`);

  const ignoredTargetAttributes: string[] = [];
  let targets = readTargets(ctx, p.targets, vertexCount, where, ignoredTargetAttributes);

  let normal = optionalFloats(ctx, p.attributes.NORMAL, vertexCount, 3, `${where} NORMAL`);
  // KHR_mesh_quantization: a normalised byte or short normal is only near unit length.
  if (normal && ctx.json.accessors?.[p.attributes.NORMAL!]?.componentType !== 5126) {
    renormalize(normal, 3);
  }
  const hadNormals = normal !== null;
  let count = vertexCount;
  if (!normal) {
    // Flat normals need one normal per face: unweld so each triangle owns its vertices.
    const n = indices.length;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const col = new Float32Array(n * 4);
    const jnt = joints
      ? joints instanceof Uint8Array
        ? new Uint8Array(n * 4)
        : new Uint16Array(n * 4)
      : null;
    const wgt = weights ? new Float32Array(n * 4) : null;
    const uvb = uv1 ? new Float32Array(n * 2) : null;
    const tan = tangent ? new Float32Array(n * 4) : null;
    normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const src = indices[i]!;
      pos.set(position.subarray(src * 3, src * 3 + 3), i * 3);
      uv.set(uv0.subarray(src * 2, src * 2 + 2), i * 2);
      col.set(color0.subarray(src * 4, src * 4 + 4), i * 4);
      if (jnt && joints) jnt.set(joints.subarray(src * 4, src * 4 + 4), i * 4);
      if (wgt && weights) wgt.set(weights.subarray(src * 4, src * 4 + 4), i * 4);
      if (uvb && uv1) uvb.set(uv1.subarray(src * 2, src * 2 + 2), i * 2);
      if (tan && tangent) tan.set(tangent.subarray(src * 4, src * 4 + 4), i * 4);
    }
    joints = jnt;
    weights = wgt;
    uv1 = uvb;
    tangent = tan;
    targets = targets.map((t) => ({
      position: t.position ? unweld3(t.position, indices) : null,
      normal: t.normal ? unweld3(t.normal, indices) : null,
    }));
    for (let t = 0; t < n; t += 3) {
      const ax = pos[t * 3]!;
      const ay = pos[t * 3 + 1]!;
      const az = pos[t * 3 + 2]!;
      const ux = pos[t * 3 + 3]! - ax;
      const uy = pos[t * 3 + 4]! - ay;
      const uz = pos[t * 3 + 5]! - az;
      const vx = pos[t * 3 + 6]! - ax;
      const vy = pos[t * 3 + 7]! - ay;
      const vz = pos[t * 3 + 8]! - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        ny = 1;
      }
      for (let k = 0; k < 3; k++) {
        normal[(t + k) * 3] = nx;
        normal[(t + k) * 3 + 1] = ny;
        normal[(t + k) * 3 + 2] = nz;
      }
    }
    position = pos;
    uv0 = uv;
    color0 = col;
    count = n;
    indices = n > 0xffff ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
  }

  let bounds: GltfBounds;
  // A normalized (KHR_mesh_quantization) accessor's min / max are raw integers: measure instead.
  if (
    !posAcc.normalized &&
    posAcc.min &&
    posAcc.max &&
    posAcc.min.length >= 3 &&
    posAcc.max.length >= 3
  ) {
    bounds = boundsOf(
      [posAcc.min[0]!, posAcc.min[1]!, posAcc.min[2]!],
      [posAcc.max[0]!, posAcc.max[1]!, posAcc.max[2]!],
    );
  } else {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = position[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
    bounds = position.length ? boundsOf(min, max) : boundsOf([0, 0, 0], [0, 0, 0]);
  }

  if (p.material !== undefined && !(ctx.json.materials ?? [])[p.material]) {
    throw new GltfError(`${where}: material ${p.material} does not exist`);
  }
  const variants: GltfVariantMapping[] = [];
  for (const m of p.extensions?.KHR_materials_variants?.mappings ?? []) {
    if (!(ctx.json.materials ?? [])[m.material]) {
      throw new GltfError(
        `${where}: variant mapping names material ${m.material}, which does not exist`,
      );
    }
    variants.push({ material: m.material, variants: [...(m.variants ?? [])] });
  }
  return {
    vertexCount: count,
    position,
    normal,
    uv0,
    uv1,
    tangent,
    color0,
    indices,
    material: p.material ?? null,
    bounds,
    hadNormals,
    joints,
    weights,
    targets,
    ignoredTargetAttributes,
    variants,
  };
}

/** `TANGENT`: VEC4 floats, w the handedness (anything but -1 reads as +1). */
function readTangents(
  ctx: Ctx,
  index: number | undefined,
  vertexCount: number,
  where: string,
): Float32Array | null {
  if (index === undefined) return null;
  const acc = accessor(ctx, index, where);
  if (acc.type !== 'VEC4') throw new GltfError(`${where}: ${acc.type}, expected VEC4`);
  if (acc.count !== vertexCount) {
    throw new GltfError(`${where}: ${acc.count} values for ${vertexCount} vertices`);
  }
  const t = readFloats(ctx, acc, 4, where);
  for (let i = 3; i < t.length; i += 4) t[i] = t[i]! < 0 ? -1 : 1;
  if (acc.componentType !== 5126) renormalize(t, 4);
  return t;
}

/** Scale the xyz of each `stride`-float element to unit length (quantized normals, tangents). */
function renormalize(v: Float32Array, stride: number): void {
  for (let i = 0; i + 2 < v.length; i += stride) {
    const l = Math.hypot(v[i]!, v[i + 1]!, v[i + 2]!);
    if (l > 0) {
      v[i] = v[i]! / l;
      v[i + 1] = v[i + 1]! / l;
      v[i + 2] = v[i + 2]! / l;
    }
  }
}

/** One vec3 per index, in index order (the unwelding that flat normals need). */
function unweld3(src: Float32Array, indices: Uint16Array | Uint32Array): Float32Array {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const s = indices[i]! * 3;
    out[i * 3] = src[s]!;
    out[i * 3 + 1] = src[s + 1]!;
    out[i * 3 + 2] = src[s + 2]!;
  }
  return out;
}

/** `JOINTS_0`: any unsigned integer type, 4 per vertex → bytes when every index fits, else shorts. */
function readJoints(
  ctx: Ctx,
  index: number | undefined,
  vertexCount: number,
  where: string,
): Uint8Array | Uint16Array | null {
  if (index === undefined) return null;
  const acc = accessor(ctx, index, where);
  if (acc.type !== 'VEC4') throw new GltfError(`${where}: ${acc.type}, expected VEC4`);
  if (acc.count !== vertexCount) {
    throw new GltfError(`${where}: ${acc.count} values for ${vertexCount} vertices`);
  }
  const t = acc.componentType;
  if (t !== 5121 && t !== 5123 && t !== 5125) {
    throw new GltfError(`${where}: componentType ${t} must be unsigned byte, short or int`);
  }
  const wide = new Uint32Array(vertexCount * 4);
  const r = readerFor(ctx, acc, where);
  let max = 0;
  if (r) {
    const cb = COMPONENT_BYTES[t];
    for (let i = 0; i < vertexCount; i++) {
      const at = r.base + i * r.stride;
      for (let k = 0; k < 4; k++) {
        const v = readComponent(r.view, at + k * cb, t, false);
        wide[i * 4 + k] = v;
        if (v > max) max = v;
      }
    }
  }
  if (max > 0xffff) throw new GltfError(`${where}: joint index ${max} exceeds 65535`);
  return max <= 0xff ? Uint8Array.from(wide) : Uint16Array.from(wide);
}

/**
 * The accessor at `index`, checked. Sparse accessors are honoured only where `allowSparse` says
 * so (morph target attributes, read through `readFloats`); elsewhere they throw.
 */
function accessor(ctx: Ctx, index: number, where: string, allowSparse = false): GltfJsonAccessor {
  const acc = ctx.json.accessors?.[index];
  if (!acc) throw new GltfError(`${where}: accessor ${index} does not exist`);
  if (acc.sparse && !allowSparse) {
    throw new GltfError(
      `${where}: accessor ${index} is sparse (supported for morph target attributes only)`,
    );
  }
  if (!(acc.componentType in COMPONENT_BYTES)) {
    throw new GltfError(`${where}: accessor ${index} componentType ${acc.componentType} unknown`);
  }
  if (!(acc.type in COMPONENTS))
    throw new GltfError(`${where}: accessor ${index} type ${acc.type} unknown`);
  return acc;
}

/** An attribute that may be absent; `fill` pads a narrower accessor (a vec3 colour's alpha). */
function optionalFloats(
  ctx: Ctx,
  index: number | undefined,
  vertexCount: number,
  components: number,
  where: string,
  fill = 0,
): Float32Array | null {
  if (index === undefined) return null;
  const acc = accessor(ctx, index, where);
  if (acc.count !== vertexCount) {
    throw new GltfError(`${where}: ${acc.count} values for ${vertexCount} vertices`);
  }
  const have = COMPONENTS[acc.type];
  if (have > components)
    throw new GltfError(`${where}: ${acc.type} has more than ${components} components`);
  const data = readFloats(ctx, acc, have, where);
  if (have === components) return data;
  const out = new Float32Array(vertexCount * components).fill(fill);
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < have; k++) out[i * components + k] = data[i * have + k]!;
  }
  return out;
}

interface Reader {
  view: DataView;
  /** Byte offset of element `i`'s first component. */
  base: number;
  stride: number;
  elementBytes: number;
}

function readerFor(ctx: Ctx, acc: GltfJsonAccessor, where: string): Reader | null {
  const components = COMPONENTS[acc.type];
  const componentBytes = COMPONENT_BYTES[acc.componentType];
  const elementBytes = components * componentBytes;
  if (acc.bufferView === undefined) return null;
  const bv = ctx.json.bufferViews?.[acc.bufferView];
  if (!bv) throw new GltfError(`${where}: bufferView ${acc.bufferView} does not exist`);
  const buffer = ctx.buffers[bv.buffer];
  if (!buffer) throw new GltfError(`${where}: buffer ${bv.buffer} does not exist`);
  const stride = bv.byteStride ?? elementBytes;
  if (stride < elementBytes)
    throw new GltfError(`${where}: byteStride ${stride} < element size ${elementBytes}`);
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const needed = acc.count === 0 ? 0 : (acc.count - 1) * stride + elementBytes;
  if ((acc.byteOffset ?? 0) + needed > bv.byteLength) {
    throw new GltfError(`${where}: accessor runs past its bufferView`);
  }
  if ((bv.byteOffset ?? 0) + bv.byteLength > buffer.byteLength) {
    throw new GltfError(`${where}: bufferView ${acc.bufferView} runs past buffer ${bv.buffer}`);
  }
  return { view: new DataView(buffer), base, stride, elementBytes };
}

function readComponent(
  view: DataView,
  at: number,
  type: GltfComponentType,
  normalized: boolean,
): number {
  switch (type) {
    case 5126:
      return view.getFloat32(at, true);
    case 5120: {
      const v = view.getInt8(at);
      return normalized ? Math.max(v / 127, -1) : v;
    }
    case 5121: {
      const v = view.getUint8(at);
      return normalized ? v / 255 : v;
    }
    case 5122: {
      const v = view.getInt16(at, true);
      return normalized ? Math.max(v / 32767, -1) : v;
    }
    case 5123: {
      const v = view.getUint16(at, true);
      return normalized ? v / 65535 : v;
    }
    case 5125:
      return view.getUint32(at, true);
  }
}

/** Accessor → floats, `components` per element (an accessor without a bufferView reads zeros). */
function readFloats(
  ctx: Ctx,
  acc: GltfJsonAccessor,
  components: number,
  where: string,
): Float32Array {
  const out = new Float32Array(acc.count * components);
  const r = readerFor(ctx, acc, where);
  const cb = COMPONENT_BYTES[acc.componentType];
  const normalized = acc.normalized ?? false;
  if (r) {
    for (let i = 0; i < acc.count; i++) {
      const at = r.base + i * r.stride;
      for (let k = 0; k < components; k++) {
        out[i * components + k] = readComponent(r.view, at + k * cb, acc.componentType, normalized);
      }
    }
  }
  if (acc.sparse) applySparse(ctx, acc, acc.sparse, components, out, where);
  return out;
}

/** Overlay a sparse accessor's `count` values at its `indices` onto `out` (dense data or zeros). */
function applySparse(
  ctx: Ctx,
  acc: GltfJsonAccessor,
  sp: GltfJsonSparse,
  components: number,
  out: Float32Array,
  where: string,
): void {
  if (!Number.isInteger(sp.count) || sp.count < 0 || sp.count > acc.count) {
    throw new GltfError(`${where}: sparse count ${sp.count} for ${acc.count} elements`);
  }
  if (!sp.indices || !sp.values) throw new GltfError(`${where}: sparse without indices/values`);
  const it = sp.indices.componentType;
  if (it !== 5121 && it !== 5123 && it !== 5125) {
    throw new GltfError(`${where}: sparse index componentType ${it} must be unsigned`);
  }
  const ib = COMPONENT_BYTES[it];
  const idx = sparseView(ctx, sp.indices.bufferView, sp.indices.byteOffset, sp.count * ib, where);
  const cb = COMPONENT_BYTES[acc.componentType];
  const bytes = sp.count * components * cb;
  const vals = sparseView(ctx, sp.values.bufferView, sp.values.byteOffset, bytes, where);
  const normalized = acc.normalized ?? false;
  for (let i = 0; i < sp.count; i++) {
    const e = readComponent(idx.view, idx.base + i * ib, it, false);
    if (e >= acc.count) throw new GltfError(`${where}: sparse index ${e} out of range`);
    for (let k = 0; k < components; k++) {
      const at = vals.base + (i * components + k) * cb;
      out[e * components + k] = readComponent(vals.view, at, acc.componentType, normalized);
    }
  }
}

/** A tightly packed sparse `indices` or `values` block: its view and base byte offset. */
function sparseView(
  ctx: Ctx,
  bufferView: number,
  byteOffset: number | undefined,
  bytes: number,
  where: string,
): { view: DataView; base: number } {
  const bv = ctx.json.bufferViews?.[bufferView];
  if (!bv) throw new GltfError(`${where}: bufferView ${bufferView} does not exist`);
  const buffer = ctx.buffers[bv.buffer];
  if (!buffer) throw new GltfError(`${where}: buffer ${bv.buffer} does not exist`);
  const off = byteOffset ?? 0;
  if (off + bytes > bv.byteLength) {
    throw new GltfError(`${where}: sparse data runs past its bufferView`);
  }
  if ((bv.byteOffset ?? 0) + bv.byteLength > buffer.byteLength) {
    throw new GltfError(`${where}: bufferView ${bufferView} runs past buffer ${bv.buffer}`);
  }
  return { view: new DataView(buffer), base: (bv.byteOffset ?? 0) + off };
}

function readIndices(ctx: Ctx, acc: GltfJsonAccessor, where: string): Uint16Array | Uint32Array {
  const t = acc.componentType;
  if (t !== 5121 && t !== 5123 && t !== 5125) {
    throw new GltfError(`${where}: index componentType ${t} must be unsigned byte, short or int`);
  }
  const out = t === 5125 ? new Uint32Array(acc.count) : new Uint16Array(acc.count);
  const r = readerFor(ctx, acc, where);
  if (!r) return out;
  for (let i = 0; i < acc.count; i++) {
    out[i] = readComponent(r.view, r.base + i * r.stride, t, false);
  }
  return out;
}

function bufferViewBytes(ctx: Ctx, index: number, where: string): Uint8Array {
  const bv = ctx.json.bufferViews?.[index];
  if (!bv) throw new GltfError(`${where}: bufferView ${index} does not exist`);
  const buffer = ctx.buffers[bv.buffer];
  if (!buffer) throw new GltfError(`${where}: buffer ${bv.buffer} does not exist`);
  const offset = bv.byteOffset ?? 0;
  if (offset + bv.byteLength > buffer.byteLength) {
    throw new GltfError(`${where}: bufferView ${index} runs past buffer ${bv.buffer}`);
  }
  return new Uint8Array(buffer, offset, bv.byteLength);
}

// ---------------------------------------------------------------- URIs

function isDataUri(uri: string): boolean {
  return uri.startsWith('data:');
}

/** Decode a `data:[<mime>][;base64],<payload>` URI. */
export function decodeDataUri(uri: string): {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string | null;
} {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) throw new GltfError(`malformed data URI`);
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const parts = meta.split(';');
  const mimeType = parts[0] || null;
  const isBase64 = parts.includes('base64');
  if (isBase64) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mimeType };
  }
  const text = decodeURIComponent(payload);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return { bytes, mimeType };
}

function mimeFromUri(uri: string): string | null {
  const path = uri.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  return null;
}
