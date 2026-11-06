/**
 * glTF 2.0 parser: bytes in, an engine-free `GltfDocument` out. Pure data, no DOM, no GPU, no
 * fetch (the game fetches the file and any external resource; VISION rule: the engine never
 * makes a network call). `gltf-load.ts` turns the document into meshes, textures and transforms.
 *
 * Handles the GLB container, `.gltf` JSON (as text bytes or a parsed object), `data:` URIs in
 * buffers and images, and every accessor component type (float, normalised and unnormalised
 * integers, interleaved strides). Static geometry only: `triangles` primitives, base colour
 * materials, node hierarchies, plus skins (joints, inverse bind matrices, `JOINTS_0`/`WEIGHTS_0`)
 * and animations (every sampler interpolation, cubic-spline tangents kept). Sparse accessors,
 * other primitive modes and required extensions throw a `GltfError`; `extensionsUsed` is listed
 * in `warnings`. `gltf-skin.ts` turns skins into the animation module's `Skeleton` shape and
 * skinned primitives into the skinned vertex layout.
 *
 * Matrices follow the engine's `Transform` convention: 3×4 row-major, `local = T · R · S`,
 * `world = parent.world · local`.
 */

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
  sparse?: unknown;
}

export interface GltfJsonBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

export interface GltfJsonPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
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
}

export interface GltfJsonMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: { index: number; texCoord?: number };
  };
  doubleSided?: boolean;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
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
  meshes?: { name?: string; primitives: GltfJsonPrimitive[] }[];
  accessors?: GltfJsonAccessor[];
  bufferViews?: GltfJsonBufferView[];
  buffers?: { uri?: string; byteLength: number }[];
  materials?: GltfJsonMaterial[];
  textures?: { name?: string; source?: number; sampler?: number }[];
  images?: { name?: string; uri?: string; mimeType?: string; bufferView?: number }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  skins?: GltfJsonSkin[];
  animations?: GltfJsonAnimation[];
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
}

export interface GltfMesh {
  name: string | null;
  primitives: GltfPrimitive[];
}

export interface GltfNode {
  name: string | null;
  parent: number | null;
  children: number[];
  mesh: number | null;
  /** Index into `GltfDocument.skins`, or null. */
  skin: number | null;
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

export interface GltfMaterial {
  name: string | null;
  /** Linear RGBA multiplier (default 1, 1, 1, 1). */
  baseColorFactor: Vec4;
  /** Index into `GltfDocument.textures`, or null. */
  baseColorTexture: number | null;
  /** Which `TEXCOORD_n` the base colour texture reads (only 0 is loaded). */
  texCoord: number;
  doubleSided: boolean;
  alphaMode: GltfAlphaMode;
  /** For `MASK` (default 0.5). */
  alphaCutoff: number;
}

export interface GltfTexture {
  name: string | null;
  /** Index into `GltfDocument.images`, or null (an extension-only texture). */
  source: number | null;
  /** `wrapS`/`wrapT` are 10497 repeat (default), 33071 clamp, 33648 mirror. */
  wrapS: number;
  wrapT: number;
  /** 9728 nearest or 9729 linear, when the sampler gave one. */
  magFilter: number | null;
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
  /** `extensionsUsed` entries (ignored), and anything else the parser skipped. */
  warnings: string[];
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

function parseJson(json: GltfJson, given: ArrayBuffer[]): GltfDocument {
  const version = json.asset?.version ?? '';
  if (!version.startsWith('2.')) throw new GltfError(`asset.version "${version}", expected 2.x`);
  if (json.extensionsRequired && json.extensionsRequired.length > 0) {
    throw new GltfError(`required extensions not supported: ${json.extensionsRequired.join(', ')}`);
  }
  const warnings: string[] = [];
  for (const ext of json.extensionsUsed ?? []) warnings.push(`extension ignored: ${ext}`);
  const externalUris: string[] = [];

  const buffers = (json.buffers ?? []).map((b, i) => {
    if (b.uri !== undefined && isDataUri(b.uri)) return decodeDataUri(b.uri).bytes.buffer;
    const bytes = given[i];
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
  const ctx: Ctx = { json, buffers };

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
      wrapS: s?.wrapS ?? 10497,
      wrapT: s?.wrapT ?? 10497,
      magFilter: s?.magFilter ?? null,
    };
  });

  const materials: GltfMaterial[] = (json.materials ?? []).map((m) => {
    const pbr = m.pbrMetallicRoughness;
    const f = pbr?.baseColorFactor;
    return {
      name: m.name ?? null,
      baseColorFactor: f ? [f[0] ?? 1, f[1] ?? 1, f[2] ?? 1, f[3] ?? 1] : [1, 1, 1, 1],
      baseColorTexture: pbr?.baseColorTexture?.index ?? null,
      texCoord: pbr?.baseColorTexture?.texCoord ?? 0,
      doubleSided: m.doubleSided ?? false,
      alphaMode: m.alphaMode ?? 'OPAQUE',
      alphaCutoff: m.alphaCutoff ?? 0.5,
    };
  });

  const meshes: GltfMesh[] = (json.meshes ?? []).map((m, mi) => ({
    name: m.name ?? null,
    primitives: m.primitives.map((p, pi) => parsePrimitive(ctx, p, `mesh ${mi} primitive ${pi}`)),
  }));

  const nodes = parseNodes(json.nodes ?? [], meshes.length, (json.skins ?? []).length);
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
    bounds: sceneBounds(nodes, meshes, sceneNodes),
  };
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

function parseNodes(src: GltfJsonNode[], meshCount: number, skinCount: number): GltfNode[] {
  const nodes: GltfNode[] = src.map((n, i) => {
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
  let color0 = optionalFloats(ctx, p.attributes.COLOR_0, vertexCount, 4, `${where} COLOR_0`, 1);
  if (!uv0) uv0 = new Float32Array(vertexCount * 2);
  if (!color0) color0 = new Float32Array(vertexCount * 4).fill(1);

  let joints = readJoints(ctx, p.attributes.JOINTS_0, vertexCount, `${where} JOINTS_0`);
  let weights = optionalFloats(ctx, p.attributes.WEIGHTS_0, vertexCount, 4, `${where} WEIGHTS_0`);
  if (joints && !weights) throw new GltfError(`${where}: JOINTS_0 without WEIGHTS_0`);
  if (weights && !joints) throw new GltfError(`${where}: WEIGHTS_0 without JOINTS_0`);

  let normal = optionalFloats(ctx, p.attributes.NORMAL, vertexCount, 3, `${where} NORMAL`);
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
    normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const src = indices[i]!;
      pos.set(position.subarray(src * 3, src * 3 + 3), i * 3);
      uv.set(uv0.subarray(src * 2, src * 2 + 2), i * 2);
      col.set(color0.subarray(src * 4, src * 4 + 4), i * 4);
      if (jnt && joints) jnt.set(joints.subarray(src * 4, src * 4 + 4), i * 4);
      if (wgt && weights) wgt.set(weights.subarray(src * 4, src * 4 + 4), i * 4);
    }
    joints = jnt;
    weights = wgt;
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
  if (posAcc.min && posAcc.max && posAcc.min.length >= 3 && posAcc.max.length >= 3) {
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
  return {
    vertexCount: count,
    position,
    normal,
    uv0,
    color0,
    indices,
    material: p.material ?? null,
    bounds,
    hadNormals,
    joints,
    weights,
  };
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

function accessor(ctx: Ctx, index: number, where: string): GltfJsonAccessor {
  const acc = ctx.json.accessors?.[index];
  if (!acc) throw new GltfError(`${where}: accessor ${index} does not exist`);
  if (acc.sparse) throw new GltfError(`${where}: accessor ${index} is sparse (not supported)`);
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
  if (!r) return out;
  const cb = COMPONENT_BYTES[acc.componentType];
  const normalized = acc.normalized ?? false;
  for (let i = 0; i < acc.count; i++) {
    const at = r.base + i * r.stride;
    for (let k = 0; k < components; k++) {
      out[i * components + k] = readComponent(r.view, at + k * cb, acc.componentType, normalized);
    }
  }
  return out;
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
