/**
 * `loadGltf`: a parsed `GltfDocument` → engine meshes (`VERTEX_LAYOUT_3D`, the tangent layout
 * for primitives with `TANGENT`, the skinned layout for skinned ones when a palette is given),
 * one `Transform` per node, one `Texture` per (image, colour space) a material reads, one
 * standard PBR `Material` per glTF material (every map, factor, sampler, alpha mode and
 * `KHR_texture_transform` carried over; `opts.lit: 'lit'` keeps the older base-colour-only
 * material), and a `GltfScene` whose `draw(frame)` pushes one instance per (node, primitive)
 * with no allocation. Images decode through `createImageBitmap` (or `opts.decodeImage`);
 * external URIs come from `opts.resources`, fetched by the game. The engine fetches nothing.
 *
 * Morph targets: a mesh with targets keeps its primitives' base vertex buffers on the CPU and
 * blends them through `anim`'s `createMorphBlender` into a second buffer `draw` uploads with
 * `Mesh.update` when `scene.morph(node).apply()` reported a change. Meshes without targets keep
 * nothing on the CPU.
 *
 * Lights and cameras: `scene.lights` holds the file's `KHR_lights_punctual` lights as the
 * render module's `SunLight` / `PointLight` / `SpotLight` records (push them into
 * `frame.lights`); `scene.cameras` the file's cameras, which `applyGltfCamera` sets on a
 * `Camera`. Material variants (`KHR_materials_variants`): every material is created at load;
 * `scene.setVariant(name)` swaps the material of each mapped draw in place.
 */
import { createMorphBlender, type MorphBlender } from '../anim/morph';
import { mat4 } from '../core/math';
import type { Camera } from '../render/camera';
import type { Frame, InstanceParams } from '../render/frame';
import type { PointLight, SpotLight, SunLight } from '../render/lights';
import type { Material } from '../render/material';
import {
  Mesh,
  type MeshUpdate,
  VERTEX_LAYOUT_3D,
  VERTEX_LAYOUT_3D_TANGENT,
  VERTEX_LAYOUT_SKINNED,
  VERTEX3D_FLOATS,
  type VertexLayout,
} from '../render/mesh';
import { generateMipmaps } from '../render/mipmap';
import type { Renderer } from '../render/renderer';
import type { SkinPalette } from '../render/skin';
import { createStandardMaterial, type StandardMaterialDesc } from '../render/standard';
import type { SamplerKind, Texture } from '../render/texture';
import { Transform } from '../render/transform';
import {
  type GltfAnimation,
  type GltfCamera,
  type GltfDocument,
  GltfError,
  type GltfImage,
  type GltfMaterial,
  type GltfPrimitive,
  type GltfSampler,
  type GltfSkin,
  type GltfTextureTransform,
  type GltfVariantMapping,
  type TextureRef,
} from './gltf';
import { interleaveSkinned } from './gltf-skin';

/** Floats per vertex of `VERTEX_LAYOUT_3D_TANGENT`. */
const TANGENT_FLOATS = VERTEX_LAYOUT_3D_TANGENT.floats;

/** Which material the loader builds per glTF material. */
export type GltfLitMode = 'standard' | 'lit';

/** A decoded image the loader can upload: an `ImageBitmap` or anything `copyExternalImageToTexture` takes. */
export type GltfImageSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface LoadGltfOptions {
  /**
   * External resources by the URI the file names (`GltfDocument.externalUris`): encoded image
   * bytes, or an already decoded image. A URI the document needs and this lacks throws.
   */
  resources?: Record<string, ArrayBuffer | GltfImageSource>;
  /**
   * Draw every primitive with this material instead of the built-in ones. The scene's
   * textures are still created (`scene.textures`) for the game to bind as it likes; `lit`
   * and `palette` only pick the mesh layouts.
   */
  material?: Material;
  /**
   * `'standard'` (default): one `createStandardMaterial` per glTF material with every map,
   * factor, sampler, alpha mode and texture transform the file gives (`scene.materials[i]`
   * for `doc.materials[i]`, `scene.materialNames[i]` its name). `'lit'`: the older
   * base-colour-only `GLTF_LIT_WGSL` material (base colour factor as `tint`, mask cutoff as
   * `params.x`).
   */
  lit?: GltfLitMode;
  /**
   * Skinned primitives (`JOINTS_0`) become `VERTEX_LAYOUT_SKINNED` meshes bound to this
   * palette: the standard materials are created with `skin: palette`, and a skinned draw's
   * `params.params[3]` picks its palette slot (`SKIN_PARAM`). Without one, skinned primitives
   * are built in the 3D layout at their bind pose (their joints and weights stay on the
   * document); a material cannot take a palette later, so give it here.
   */
  palette?: SkinPalette;
  /** Label prefix for GPU objects (default `'gltf'`). */
  label?: string;
  /** Build mip chains for the textures (default true; `generateMipmaps` on the GPU). */
  mips?: boolean;
  /**
   * How encoded image bytes become an image (default: `createImageBitmap` on a `Blob`). Tests
   * and Workers without image decoding pass their own.
   */
  decodeImage?: (bytes: Uint8Array, mimeType: string | null) => Promise<GltfImageSource>;
  /**
   * Multiplies glTF light intensity on its way into `scene.lights` (default 1). The engine's
   * light colours are unitless linear RGB; a file's candela (point, spot) and lux
   * (directional) usually want a scale well below 1.
   */
  lightScale?: number;
}

/**
 * The file's `KHR_lights_punctual` lights as the render module's records, in scene order
 * (`GltfDocument.lights` keeps glTF's units). `color` is glTF `color × intensity × lightScale`;
 * `radius` is `range`, or `16·√(intensity × lightScale)` without one (where an inverse-square
 * light has fallen to 1/256); spot `innerAngle` / `outerAngle` are the cone half-angles.
 * A directional light is a `SunLight` (ws/assets-4): `direction` is the node's world -Z,
 * normalised, the way the light travels (the engine's convention, as `SpotLight.direction`),
 * and the deprecated `dir` reads and replaces the same array. Push the points and spots into
 * `frame.lights.points` / `.spots`, or copy a sun's `direction` and `color` into
 * `frame.lights.sun`.
 */
export interface GltfSceneLights {
  directional: SunLight[];
  points: PointLight[];
  spots: SpotLight[];
}

/** One draw of the scene: a primitive's mesh placed by its node's transform. */
export interface GltfSceneNode {
  /** Index into `GltfDocument.nodes` / `GltfScene.transforms`. */
  node: number;
  transform: Transform;
  mesh: Mesh;
  material: Material;
  /**
   * Mutate to recolour the draw. `lit: 'standard'`: `tint` white, `params` zero (the factors
   * live in the material); a skinned draw sets `params[3]` to its palette slot. `lit: 'lit'`:
   * base colour factor as `tint`, alpha cutoff as `params.x`.
   */
  params: InstanceParams;
  /** The node's skin (index into `GltfScene.skins`), or null for a static draw. */
  skin: number | null;
  /**
   * The glTF material the draw uses (index into `GltfDocument.materials` and
   * `GltfScene.materials`), or null for the default; `setVariant` changes it.
   */
  materialIndex: number | null;
}

/** One draw whose primitive has `KHR_materials_variants` mappings. */
interface VariantDraw {
  draw: GltfSceneNode;
  /** The primitive's own material (no variant, or a variant no mapping names). */
  base: number | null;
  mappings: readonly GltfVariantMapping[];
}

/**
 * The morph state of one glTF mesh (shared by every node drawing it): one `weights` array for
 * all its primitives, blended by one `MorphBlender` per primitive. Write `weights` (by hand or
 * with `anim`'s `sampleWeights`), call `apply()`; the scene uploads changed primitives on its
 * next `draw`.
 */
export interface GltfMorph {
  /** Index into `GltfDocument.meshes`. */
  readonly mesh: number;
  /** One weight per target, starting at the file's `mesh.weights` (or zeros). */
  readonly weights: Float32Array;
  readonly targetCount: number;
  /** One per primitive of the mesh, all reading `weights`. */
  readonly blenders: readonly MorphBlender[];
  /** Blend every primitive; true when any vertex buffer changed (and so will be uploaded). */
  apply(): boolean;
}

/** One morphed primitive: its blender, the buffer it writes and the mesh that uploads it. */
interface MorphEntry {
  blender: MorphBlender;
  mesh: Mesh;
  update: MeshUpdate;
  dirty: boolean;
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
  /**
   * One per (image, colour space) a material reads, in first-use order: base colour and
   * emissive maps are sRGB, the rest linear, so an image used both ways is uploaded twice.
   */
  readonly textures: Texture[] = [];
  /** One per glTF material, built by the loader (empty when `opts.material` was given). */
  readonly materials: Material[] = [];
  /** The file's `material.name` per glTF material (null when unnamed). */
  readonly materialNames: (string | null)[] = [];
  /** The palette skinned meshes are bound to (`opts.palette`), or null. */
  readonly palette: SkinPalette | null;
  /** One per document node, parented like the file (`doc.nodes[i]` → `transforms[i]`). */
  readonly transforms: Transform[] = [];
  /** Every draw: one per (node in the default scene, primitive of its mesh). */
  readonly nodes: GltfSceneNode[] = [];
  /** World-space bounds of the default scene (from the document). */
  readonly bounds: { center: [number, number, number]; radius: number };
  /** The document's skins (`skeletonFromSkin(doc, i)` builds the animation module's skeleton). */
  readonly skins: readonly GltfSkin[];
  /** The document's clips, in the animation module's `AnimationClip` shape. */
  readonly animations: readonly GltfAnimation[];
  /** One per mesh that carries morph targets, in mesh order. */
  readonly morphs: readonly GltfMorph[] = [];
  /** The file's lights as render records (`GltfSceneLights`; empty lists when it has none). */
  readonly lights: GltfSceneLights = { directional: [], points: [], spots: [] };
  /** The file's cameras placed by their nodes (`applyGltfCamera` sets one on a `Camera`). */
  readonly cameras: readonly GltfCamera[];
  /** The file's `KHR_materials_variants` names (`setVariant` takes one). */
  readonly variants: readonly string[];
  /** Whether the default material or textures were created here (and so destroyed here). */
  private readonly ownsMaterials: boolean;
  private readonly morphByMesh = new Map<number, GltfMorph>();
  private readonly morphEntries: MorphEntry[] = [];
  private readonly doc: GltfDocument;
  private readonly variantDraws: VariantDraw[] = [];
  private resolveMaterial: ((index: number | null) => Material) | null = null;
  private litParams = false;
  private activeVariant: string | null = null;

  constructor(doc: GltfDocument, ownsMaterials: boolean, palette: SkinPalette | null = null) {
    this.doc = doc;
    this.bounds = { center: [...doc.bounds.center], radius: doc.bounds.radius };
    this.skins = doc.skins;
    this.animations = doc.animations;
    this.ownsMaterials = ownsMaterials;
    this.palette = palette;
    for (const m of doc.materials) this.materialNames.push(m.name);
    this.cameras = doc.cameras;
    this.variants = doc.variants;
  }

  /** The active material variant, or null for each primitive's own material. */
  get variant(): string | null {
    return this.activeVariant;
  }

  /**
   * Switch every draw with `KHR_materials_variants` mappings to the material `name` binds (a
   * draw no mapping of `name` covers goes back to its own material); null restores every
   * draw's own material. Swaps `material` (and `materialIndex`) in place: no material is
   * created. Throws `GltfError` listing the file's variants for an unknown name.
   */
  setVariant(name: string | null): this {
    let v = -1;
    if (name !== null) {
      v = this.variants.indexOf(name);
      if (v < 0) {
        const known = this.variants.length > 0 ? this.variants.join(', ') : 'none';
        throw new GltfError(`variant "${name}" unknown (variants: ${known})`);
      }
    }
    for (const vd of this.variantDraws) {
      let mi = vd.base;
      if (v >= 0) {
        for (const m of vd.mappings) {
          if (m.variants.includes(v)) {
            mi = m.material;
            break;
          }
        }
      }
      vd.draw.materialIndex = mi;
      if (this.resolveMaterial) vd.draw.material = this.resolveMaterial(mi);
      if (this.litParams)
        writeLitParams(vd.draw.params, mi === null ? undefined : this.doc.materials[mi]);
    }
    this.activeVariant = name;
    return this;
  }

  /** @internal The loader: how `setVariant` finds a material, and which draws it touches. */
  bindVariants(
    resolve: ((index: number | null) => Material) | null,
    litParams: boolean,
    draws: VariantDraw[],
  ): void {
    this.resolveMaterial = resolve;
    this.litParams = litParams;
    for (const d of draws) this.variantDraws.push(d);
  }

  /**
   * The morph state of the mesh `nodeIndex` (into `GltfDocument.nodes`) draws, or null when the
   * node has no mesh or the mesh no targets. Nodes sharing a mesh share the object.
   */
  morph(nodeIndex: number): GltfMorph | null {
    const mi = this.doc.nodes[nodeIndex]?.mesh;
    if (mi === null || mi === undefined) return null;
    return this.morphByMesh.get(mi) ?? null;
  }

  /** @internal Register a mesh's morph state (the loader). */
  addMorph(morph: GltfMorph, entries: MorphEntry[]): void {
    (this.morphs as GltfMorph[]).push(morph);
    this.morphByMesh.set(morph.mesh, morph);
    for (const e of entries) this.morphEntries.push(e);
  }

  /**
   * Upload every morphed primitive whose `apply()` changed it, then record every draw into
   * `frame`. Allocation-free.
   */
  draw(frame: Frame): void {
    const entries = this.morphEntries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (!e.dirty) continue;
      e.dirty = false;
      e.mesh.update(e.update);
    }
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
  const lit = opts.lit ?? 'standard';
  const standard = lit === 'standard' && !opts.material;
  const palette = opts.palette ?? null;
  const scene = new GltfScene(doc, !opts.material, palette);

  // Textures: decode every image a material reads, in parallel, then upload one texture per
  // (image, colour space): base colour and emissive maps are sRGB, the rest linear. The older
  // lit material reads base colour only.
  const srgbSlots: (keyof GltfMaterial)[] = ['baseColor', 'emissive'];
  const linearSlots: (keyof GltfMaterial)[] = standard
    ? ['metallicRoughness', 'normal', 'occlusion']
    : [];
  const wanted = new Set<string>();
  const imageOf = (ref: TextureRef | null): number | null =>
    ref ? (doc.textures[ref.index]?.source ?? null) : null;
  for (const gm of doc.materials) {
    for (const slot of srgbSlots) {
      const img = imageOf(gm[slot] as TextureRef | null);
      if (img !== null) wanted.add(`${img}:srgb`);
    }
    for (const slot of linearSlots) {
      const img = imageOf(gm[slot] as TextureRef | null);
      if (img !== null) wanted.add(`${img}:linear`);
    }
  }
  const needed = new Set<number>();
  for (const key of wanted) needed.add(Number(key.split(':')[0]));
  const imageSources = await Promise.all(
    doc.images.map((img, i) => (needed.has(i) ? decodeImage(img, i, opts) : null)),
  );
  const uploaded = new Map<string, Texture>();
  for (let img = 0; img < doc.images.length; img++) {
    const src = imageSources[img];
    if (!src) continue;
    for (const srgb of [true, false]) {
      const key = `${img}:${srgb ? 'srgb' : 'linear'}`;
      if (!wanted.has(key)) continue;
      const tex = renderer.createTexture({
        width: src.width,
        height: src.height,
        mips,
        format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
        label: srgb ? `${label}:image${img}` : `${label}:image${img}:linear`,
      });
      renderer.device.queue.copyExternalImageToTexture({ source: src }, { texture: tex.texture }, [
        src.width,
        src.height,
      ]);
      if (tex.mipLevels > 1) generateMipmaps(renderer.device, tex);
      uploaded.set(key, tex);
      scene.textures.push(tex);
    }
  }
  for (const src of imageSources) if (src && 'close' in src) src.close();
  const textureFor = (ref: TextureRef | null, srgb: boolean): Texture | undefined => {
    const img = imageOf(ref);
    return img === null ? undefined : uploaded.get(`${img}:${srgb ? 'srgb' : 'linear'}`);
  };

  // Materials: one engine material per glTF material (textures are bound per material).
  const materialFor = new Map<number | null, Material>();
  const defaultMaterial = (): Material => {
    let m = materialFor.get(null);
    if (!m) {
      m =
        opts.material ??
        (standard
          ? createStandardMaterial(renderer, {
              label: `${label}:default`,
              metallic: 1,
              roughness: 1,
              ...(palette ? { skin: palette } : {}),
            })
          : createLitMaterial(renderer, `${label}:default`, 'opaque', mips));
      materialFor.set(null, m);
      if (!opts.material) scene.materials.push(m);
    }
    return m;
  };
  if (!opts.material) {
    doc.materials.forEach((gm, i) => {
      let m: Material;
      if (standard) {
        const d = standardDesc(doc, gm, `${label}:material${i}`, textureFor, mips);
        if (palette) d.skin = palette;
        m = createStandardMaterial(renderer, d);
      } else {
        m = createLitMaterial(
          renderer,
          `${label}:material${i}`,
          gm.alphaMode === 'BLEND' ? 'alpha' : 'opaque',
          mips,
        );
        const t = textureFor(gm.baseColor, true);
        if (t) m.setTexture(0, t);
      }
      materialFor.set(i, m);
      scene.materials.push(m);
    });
  }

  // Meshes: one per primitive, interleaved into VERTEX_LAYOUT_3D, the tangent layout (TANGENT)
  // or the skinned layout (JOINTS_0 and a palette; it has no tangent slot).
  const meshIndex: Mesh[][] = doc.meshes.map((gm, mi) => {
    const targetCount = gm.primitives[0]?.targets.length ?? 0;
    const weights = gm.weights ? new Float32Array(gm.weights) : new Float32Array(targetCount);
    const entries: MorphEntry[] = [];
    const meshes = gm.primitives.map((p, pi) => {
      const skinned = palette !== null && p.joints instanceof Uint8Array;
      const tangent = p.tangent !== null;
      let layout: VertexLayout = VERTEX_LAYOUT_3D;
      let vertices: Float32Array;
      if (skinned) {
        layout = VERTEX_LAYOUT_SKINNED;
        vertices = new Float32Array(interleaveSkinned(p).vertices);
      } else if (tangent) {
        layout = VERTEX_LAYOUT_3D_TANGENT;
        vertices = interleave3dTangent(p);
      } else {
        vertices = interleave3d(p);
      }
      const mesh = new Mesh(renderer.device, {
        label: `${label}:mesh${mi}.${pi}`,
        layout,
        vertices,
        indices: p.indices,
        bounds: { center: [...p.bounds.center], radius: p.bounds.radius },
      });
      scene.meshes.push(mesh);
      if (targetCount > 0) {
        // Keep the base on the CPU only here; the blender writes into a second buffer.
        const blender = createMorphBlender(
          vertices,
          p.targets,
          { floats: layout.stride / 4 },
          weights,
        );
        entries.push({
          blender,
          mesh,
          update: { vertices: new Float32Array(vertices.length) },
          dirty: false,
        });
      }
      return mesh;
    });
    if (targetCount > 0) {
      scene.addMorph(
        {
          mesh: mi,
          weights,
          targetCount,
          blenders: entries.map((e) => e.blender),
          apply(): boolean {
            let any = false;
            for (let i = 0; i < entries.length; i++) {
              const e = entries[i]!;
              if (e.blender.apply(e.update.vertices as Float32Array)) {
                e.dirty = true;
                any = true;
              }
            }
            return any;
          },
        },
        entries,
      );
    }
    return meshes;
  });

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
  const variantDraws: VariantDraw[] = [];
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
      const draw: GltfSceneNode = {
        node: ni,
        transform: scene.transforms[ni]!,
        mesh: meshIndex[mi]![pi]!,
        material,
        params: standard ? paramsStandard() : paramsFor(gm),
        skin: n.skin,
        materialIndex: p.material,
      };
      scene.nodes.push(draw);
      if (p.variants.length > 0) {
        variantDraws.push({ draw, base: p.material, mappings: p.variants });
      }
    });
  }
  scene.bindVariants(
    opts.material
      ? null
      : (i) => (i !== null ? materialFor.get(i) : undefined) ?? defaultMaterial(),
    !standard && !opts.material,
    variantDraws,
  );

  // Lights: glTF units → the render module's records.
  const scale = opts.lightScale ?? 1;
  for (const l of doc.lights) {
    const k = l.intensity * scale;
    const color = new Float32Array([l.color[0] * k, l.color[1] * k, l.color[2] * k]);
    const radius = l.range ?? 16 * Math.sqrt(Math.max(k, 0));
    if (l.type === 'directional') {
      scene.lights.directional.push(sunLight(new Float32Array(l.direction), color));
    } else if (l.type === 'point') {
      scene.lights.points.push({ position: new Float32Array(l.position), color, radius });
    } else {
      scene.lights.spots.push({
        position: new Float32Array(l.position),
        direction: new Float32Array(l.direction),
        color,
        radius,
        innerAngle: l.innerConeAngle ?? 0,
        outerAngle: l.outerConeAngle ?? Math.PI / 4,
      });
    }
  }
  return scene;
}

/** A `SunLight` record whose deprecated `dir` is an accessor over `direction`, as `Lights.sun`. */
function sunLight(dir: Float32Array, color: Float32Array): SunLight {
  let direction: ArrayLike<number> = dir;
  return {
    get direction(): ArrayLike<number> {
      return direction;
    },
    set direction(v: ArrayLike<number>) {
      direction = v;
    },
    get dir(): ArrayLike<number> {
      return direction;
    },
    set dir(v: ArrayLike<number>) {
      direction = v;
    },
    color,
  };
}

const orthoScratch = new Float32Array(16);

/**
 * Set `camera` to a glTF camera: its projection (perspective `yfov`, the file's `aspectRatio`
 * or `aspect`, `znear`, `zfar` or an infinite far plane; orthographic `xmag` / `ymag` half
 * extents and its depth range) and its node's view (`GltfCamera.view`). Turns depth test,
 * depth write and culling on. Allocation-free; returns `camera`.
 */
export function applyGltfCamera(camera: Camera, c: GltfCamera, aspect: number): Camera {
  if (c.type === 'perspective') {
    camera.setPerspective(c.yfov, c.aspectRatio ?? aspect, c.znear, c.zfar ?? Infinity);
  } else {
    const far = c.zfar ?? c.znear + 1;
    camera.setProjection(mat4.ortho(orthoScratch, -c.xmag, c.xmag, -c.ymag, c.ymag, c.znear, far));
    camera.depthTest = true;
    camera.depthWrite = true;
    camera.cull = true;
  }
  camera.setView(c.view);
  return camera;
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

/**
 * A `StandardMaterialDesc` for one glTF material: maps through `textureFor` (sRGB for base
 * colour and emissive, linear otherwise), factors, alpha mode, double-sidedness, the sampler
 * of the base colour texture (else the first slot with one; `gltfSamplerKind`) and the
 * `KHR_texture_transform` of the base colour slot (else the first slot with one): the
 * standard material has one sampler and one uv transform for every map, and reads
 * `TEXCOORD_0` only.
 */
function standardDesc(
  doc: GltfDocument,
  gm: GltfMaterial,
  label: string,
  textureFor: (ref: TextureRef | null, srgb: boolean) => Texture | undefined,
  mips: boolean,
): StandardMaterialDesc {
  const d: StandardMaterialDesc = {
    label,
    baseColorFactor: gm.baseColorFactor,
    metallic: gm.metallicFactor,
    roughness: gm.roughnessFactor,
    normalScale: gm.normalScale,
    emissiveFactor: gm.emissiveFactor,
    alphaMode: gm.alphaMode === 'BLEND' ? 'blend' : gm.alphaMode === 'MASK' ? 'mask' : 'opaque',
    alphaCutoff: gm.alphaCutoff,
    doubleSided: gm.doubleSided,
  };
  const base = textureFor(gm.baseColor, true);
  const mr = textureFor(gm.metallicRoughness, false);
  const normal = textureFor(gm.normal, false);
  const occlusion = textureFor(gm.occlusion, false);
  const emissive = textureFor(gm.emissive, true);
  if (base) d.baseColor = base;
  if (mr) d.metallicRoughness = mr;
  if (normal) d.normal = normal;
  if (occlusion) d.occlusion = occlusion;
  if (emissive) d.emissive = emissive;
  const slots = [gm.baseColor, gm.metallicRoughness, gm.normal, gm.occlusion, gm.emissive];
  let sampler: GltfSampler | undefined;
  let transform: GltfTextureTransform | null = null;
  for (const ref of slots) {
    if (!ref) continue;
    if (!sampler) sampler = doc.textures[ref.index]?.sampler;
    if (!transform) transform = ref.transform;
  }
  if (sampler) d.sampler = gltfSamplerKind(sampler, mips);
  if (transform) d.uvTransform = uvTransformOf(transform);
  // Per-map texCoord and transform, and the occlusion strength (ws/render-4).
  if (gm.name) d.name = gm.name;
  if (gm.occlusionStrength !== 1) d.occlusionStrength = gm.occlusionStrength;
  const names = ['baseColor', 'metallicRoughness', 'normal', 'occlusion', 'emissive'] as const;
  for (let k = 0; k < slots.length; k++) {
    const ref = slots[k];
    if (!ref) continue;
    const texCoord = ref.texCoord === 1 ? 1 : 0;
    const own = ref.transform && ref.transform !== transform;
    if (texCoord === 0 && !own) continue;
    d.maps ??= {};
    d.maps[names[k]!] = {
      texCoord,
      ...(own ? { uvTransform: uvTransformOf(ref.transform!) } : {}),
    };
  }
  return d;
}

function uvTransformOf(t: GltfTextureTransform): number[] {
  return [t.scale[0], t.scale[1], t.offset[0], t.offset[1], t.rotation];
}

/**
 * The engine sampler nearest a glTF one: nearest magnification → `nearest-mip-clamp` (or
 * `nearest-clamp` without mips; the engine has no nearest-repeat), linear → `linear-clamp`
 * when both wraps clamp, else `linear-mip-repeat` (`linear-repeat` without mips; mirrored
 * repeat is treated as repeat). `mips` false, or a glTF `minFilter` without a mipmap mode,
 * picks the level-0 sampler.
 */
export function gltfSamplerKind(sampler: GltfSampler, mips: boolean): SamplerKind {
  const mip = mips && sampler.mipmapFilter !== null;
  if (sampler.magFilter === 'nearest') return mip ? 'nearest-mip-clamp' : 'nearest-clamp';
  const clamp = sampler.wrapS === 'clamp-to-edge' && sampler.wrapT === 'clamp-to-edge';
  if (clamp) return 'linear-clamp';
  return mip ? 'linear-mip-repeat' : 'linear-repeat';
}

function paramsStandard(): InstanceParams {
  return { tint: new Float32Array([1, 1, 1, 1]), params: new Float32Array(4) };
}

function paramsFor(gm: GltfMaterial | undefined): InstanceParams {
  const p = { tint: new Float32Array(4), params: new Float32Array(4) };
  writeLitParams(p, gm);
  return p;
}

/** The lit material's per-draw values for `gm`: base colour factor as tint, cutoff as `x`. */
function writeLitParams(p: InstanceParams, gm: GltfMaterial | undefined): void {
  // The loader made both arrays (`paramsFor`); a game that replaced them keeps its own.
  const tint = gm ? gm.baseColorFactor : [1, 1, 1, 1];
  if (p.tint instanceof Float32Array) p.tint.set(tint);
  if (p.params instanceof Float32Array) p.params[0] = gm?.alphaMode === 'MASK' ? gm.alphaCutoff : 0;
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

/**
 * `VERTEX_LAYOUT_3D_TANGENT`: the 12 floats of `interleave3d` then `tangent.xyzw` per vertex.
 * A primitive without `TANGENT` gets `(1, 0, 0, 1)`.
 */
export function interleave3dTangent(p: GltfPrimitive): Float32Array {
  const n = p.vertexCount;
  const out = new Float32Array(n * TANGENT_FLOATS);
  const t = p.tangent;
  for (let i = 0; i < n; i++) {
    const o = i * TANGENT_FLOATS;
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
    if (t) {
      out[o + 12] = t[i * 4]!;
      out[o + 13] = t[i * 4 + 1]!;
      out[o + 14] = t[i * 4 + 2]!;
      out[o + 15] = t[i * 4 + 3]!;
    } else {
      out[o + 12] = 1;
      out[o + 15] = 1;
    }
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
