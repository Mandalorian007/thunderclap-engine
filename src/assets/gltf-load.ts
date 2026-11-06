/**
 * `loadGltf`: a parsed `GltfDocument` → engine meshes (`VERTEX_LAYOUT_3D`), one `Transform` per
 * node, one `Texture` per image a base colour texture reads, one lit `Material` per glTF
 * material, and a `GltfScene` whose `draw(frame)` pushes one instance per (node, primitive)
 * with no allocation. Images decode through `createImageBitmap` (or `opts.decodeImage`);
 * external URIs come from `opts.resources`, fetched by the game. The engine fetches nothing.
 */
import type { Frame, InstanceParams } from '../render/frame';
import type { Material } from '../render/material';
import { Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from '../render/mesh';
import { generateMipmaps } from '../render/mipmap';
import type { Renderer } from '../render/renderer';
import type { Texture } from '../render/texture';
import { Transform } from '../render/transform';
import {
  type GltfDocument,
  GltfError,
  type GltfImage,
  type GltfMaterial,
  type GltfPrimitive,
} from './gltf';

/** A decoded image the loader can upload: an `ImageBitmap` or anything `copyExternalImageToTexture` takes. */
export type GltfImageSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface LoadGltfOptions {
  /**
   * External resources by the URI the file names (`GltfDocument.externalUris`): encoded image
   * bytes, or an already decoded image. A URI the document needs and this lacks throws.
   */
  resources?: Record<string, ArrayBuffer | GltfImageSource>;
  /**
   * Draw every primitive with this material instead of the built-in lit one. The scene's
   * textures are still created (`scene.textures`) for the game to bind as it likes.
   */
  material?: Material;
  /** Label prefix for GPU objects (default `'gltf'`). */
  label?: string;
  /** Build mip chains for the textures (default true; `generateMipmaps` on the GPU). */
  mips?: boolean;
  /**
   * How encoded image bytes become an image (default: `createImageBitmap` on a `Blob`). Tests
   * and Workers without image decoding pass their own.
   */
  decodeImage?: (bytes: Uint8Array, mimeType: string | null) => Promise<GltfImageSource>;
}

/** One draw of the scene: a primitive's mesh placed by its node's transform. */
export interface GltfSceneNode {
  /** Index into `GltfDocument.nodes` / `GltfScene.transforms`. */
  node: number;
  transform: Transform;
  mesh: Mesh;
  material: Material;
  /** Base colour factor as `tint`, alpha cutoff as `params.x`; mutate to recolour the draw. */
  params: InstanceParams;
}

/**
 * Built-in material: base colour texture × factor × vertex colour, lit by the engine's lighting
 * block (`engine_lambert`) plus a faint sky term from above. `params.x` > 0 is a `MASK` cutoff.
 */
export const GLTF_LIT_WGSL = /* wgsl */ `
@group(1) @binding(1) var baseSampler: sampler;
@group(1) @binding(2) var baseTex: texture_2d<f32>;

@fragment fn fs_main(in: VSOut) -> FragOut {
  let c = textureSample(baseTex, baseSampler, in.uv) * in.color;
  if (in.params.x > 0.0 && c.a < in.params.x) { discard; }
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(c.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky), c.a);
  o.emissive = vec4f(0.0);
  return o;
}
`;

/** The GPU side of one glTF document. Owns what it created; `destroy()` frees it. */
export class GltfScene {
  /** One per primitive, in document order (mesh 0's primitives, then mesh 1's, …). */
  readonly meshes: Mesh[] = [];
  /** One per distinct image a glTF texture reads, in first-use order. */
  readonly textures: Texture[] = [];
  /** One per glTF material, built by the loader (empty when `opts.material` was given). */
  readonly materials: Material[] = [];
  /** One per document node, parented like the file (`doc.nodes[i]` → `transforms[i]`). */
  readonly transforms: Transform[] = [];
  /** Every draw: one per (node in the default scene, primitive of its mesh). */
  readonly nodes: GltfSceneNode[] = [];
  /** World-space bounds of the default scene (from the document). */
  readonly bounds: { center: [number, number, number]; radius: number };
  /** Whether the default material or textures were created here (and so destroyed here). */
  private readonly ownsMaterials: boolean;

  constructor(doc: GltfDocument, ownsMaterials: boolean) {
    this.bounds = { center: [...doc.bounds.center], radius: doc.bounds.radius };
    this.ownsMaterials = ownsMaterials;
  }

  /** Record every draw into `frame`. Allocation-free. */
  draw(frame: Frame): void {
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      frame.mesh(n.mesh, n.material, n.transform, n.params);
    }
  }

  destroy(): void {
    for (const m of this.meshes) m.destroy();
    for (const t of this.textures) t.destroy();
    if (this.ownsMaterials) for (const m of this.materials) m.destroy();
  }
}

/**
 * Upload a document to the GPU. Resolves once every image is decoded; everything else is
 * synchronous. Throws `GltfError` for a missing external resource or an undecodable image.
 */
export async function loadGltf(
  renderer: Renderer,
  doc: GltfDocument,
  opts: LoadGltfOptions = {},
): Promise<GltfScene> {
  const label = opts.label ?? 'gltf';
  const mips = opts.mips ?? true;
  const scene = new GltfScene(doc, !opts.material);

  // Textures: decode every image a texture reads, in parallel, then upload.
  const imageSources = await Promise.all(doc.images.map((img, i) => decodeImage(img, i, opts)));
  const uploaded = new Map<number, Texture>();
  for (let ti = 0; ti < doc.textures.length; ti++) {
    const t = doc.textures[ti]!;
    if (t.source === null) continue;
    let tex = uploaded.get(t.source);
    if (!tex) {
      const src = imageSources[t.source]!;
      tex = renderer.createTexture({
        width: src.width,
        height: src.height,
        mips,
        format: 'rgba8unorm-srgb',
        label: `${label}:image${t.source}`,
      });
      renderer.device.queue.copyExternalImageToTexture({ source: src }, { texture: tex.texture }, [
        src.width,
        src.height,
      ]);
      if (tex.mipLevels > 1) generateMipmaps(renderer.device, tex);
      uploaded.set(t.source, tex);
      scene.textures.push(tex);
    }
  }
  for (const src of imageSources) if ('close' in src) src.close();

  // Materials: one engine material per glTF material (textures are bound per material).
  const materialFor = new Map<number | null, Material>();
  const defaultMaterial = (): Material => {
    let m = materialFor.get(null);
    if (!m) {
      m = opts.material ?? createLitMaterial(renderer, `${label}:default`, 'opaque', mips);
      materialFor.set(null, m);
      if (!opts.material) scene.materials.push(m);
    }
    return m;
  };
  if (!opts.material) {
    doc.materials.forEach((gm, i) => {
      const m = createLitMaterial(
        renderer,
        `${label}:material${i}`,
        gm.alphaMode === 'BLEND' ? 'alpha' : 'opaque',
        mips,
      );
      const tex = gm.baseColorTexture !== null ? doc.textures[gm.baseColorTexture] : undefined;
      if (tex && tex.source !== null) {
        const t = uploaded.get(tex.source);
        if (t) m.setTexture(0, t);
      }
      materialFor.set(i, m);
      scene.materials.push(m);
    });
  }

  // Meshes: one per primitive, interleaved into VERTEX_LAYOUT_3D.
  const meshIndex: Mesh[][] = doc.meshes.map((gm, mi) =>
    gm.primitives.map((p, pi) => {
      const mesh = new Mesh(renderer.device, {
        label: `${label}:mesh${mi}.${pi}`,
        layout: VERTEX_LAYOUT_3D,
        vertices: interleave3d(p),
        indices: p.indices,
      });
      scene.meshes.push(mesh);
      return mesh;
    }),
  );

  // Transforms: one per node, parented like the file.
  for (const n of doc.nodes) {
    const t = new Transform();
    t.setPosition(n.translation[0], n.translation[1], n.translation[2]);
    t.setQuaternion(n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]);
    t.setScale(n.scale[0], n.scale[1], n.scale[2]);
    scene.transforms.push(t);
  }
  doc.nodes.forEach((n, i) => {
    if (n.parent !== null) scene.transforms[i]!.parent = scene.transforms[n.parent]!;
  });

  // Draws: every node in the default scene with a mesh, one per primitive.
  for (const ni of doc.sceneNodes) {
    const n = doc.nodes[ni]!;
    if (n.mesh === null) continue;
    const mi = n.mesh;
    doc.meshes[mi]!.primitives.forEach((p, pi) => {
      const gm = p.material !== null ? doc.materials[p.material] : undefined;
      const material =
        opts.material ??
        (p.material !== null ? materialFor.get(p.material) : undefined) ??
        defaultMaterial();
      scene.nodes.push({
        node: ni,
        transform: scene.transforms[ni]!,
        mesh: meshIndex[mi]![pi]!,
        material,
        params: paramsFor(gm),
      });
    });
  }
  return scene;
}

function createLitMaterial(
  renderer: Renderer,
  label: string,
  blend: 'opaque' | 'alpha',
  mips: boolean,
): Material {
  return renderer.createMaterial({
    label,
    wgsl: GLTF_LIT_WGSL,
    textures: 1,
    blend,
    sampler: mips ? 'linear-mip-repeat' : 'linear-repeat',
  });
}

function paramsFor(gm: GltfMaterial | undefined): InstanceParams {
  const tint = gm ? gm.baseColorFactor : [1, 1, 1, 1];
  const cutoff = gm?.alphaMode === 'MASK' ? gm.alphaCutoff : 0;
  return { tint: new Float32Array(tint), params: new Float32Array([cutoff, 0, 0, 0]) };
}

/** `x, y, z, nx, ny, nz, u, v, r, g, b, a` per vertex (the `VERTEX_LAYOUT_3D` float order). */
export function interleave3d(p: GltfPrimitive): Float32Array {
  const n = p.vertexCount;
  const out = new Float32Array(n * VERTEX3D_FLOATS);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX3D_FLOATS;
    out[o] = p.position[i * 3]!;
    out[o + 1] = p.position[i * 3 + 1]!;
    out[o + 2] = p.position[i * 3 + 2]!;
    out[o + 3] = p.normal[i * 3]!;
    out[o + 4] = p.normal[i * 3 + 1]!;
    out[o + 5] = p.normal[i * 3 + 2]!;
    out[o + 6] = p.uv0[i * 2]!;
    out[o + 7] = p.uv0[i * 2 + 1]!;
    out[o + 8] = p.color0[i * 4]!;
    out[o + 9] = p.color0[i * 4 + 1]!;
    out[o + 10] = p.color0[i * 4 + 2]!;
    out[o + 11] = p.color0[i * 4 + 3]!;
  }
  return out;
}

async function decodeImage(
  img: GltfImage,
  index: number,
  opts: LoadGltfOptions,
): Promise<GltfImageSource> {
  let bytes: Uint8Array | null = img.bytes;
  if (img.uri !== null) {
    const res = opts.resources?.[img.uri];
    if (res === undefined)
      throw new GltfError(`image ${index}: missing external resource "${img.uri}"`);
    if (!(res instanceof ArrayBuffer)) return res;
    bytes = new Uint8Array(res);
  }
  if (!bytes) throw new GltfError(`image ${index}: no bytes to decode`);
  const decode = opts.decodeImage ?? defaultDecode;
  try {
    return await decode(bytes, img.mimeType);
  } catch (e) {
    throw new GltfError(
      `image ${index}: decode failed (${img.mimeType ?? 'unknown type'}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function defaultDecode(bytes: Uint8Array, mimeType: string | null): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new GltfError('createImageBitmap is not available; pass opts.decodeImage');
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], mimeType ? { type: mimeType } : undefined);
  return createImageBitmap(blob, { colorSpaceConversion: 'none' });
}
