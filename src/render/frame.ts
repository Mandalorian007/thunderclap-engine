import type { InstanceList } from './instance-list';
import { Lights, packInstanceFlags } from './lights';
import type { Material } from './material';
import type { Mesh, MeshBounds } from './mesh';
import { Transform } from './transform';

/**
 * Floats per instance in `InstanceBatch.params`: the instance format after its 3×4 matrix
 * (`INSTANCE_FLOATS` − 12): `uvRect` (4), `tint` (4), `params` (4), `emissive`, `flags`,
 * `size.x`, `size.y`. `writeInstanceParams` fills one from an `InstanceParams`.
 */
export const INSTANCE_PARAM_FLOATS = 16;

/**
 * Many instances of one mesh and material submitted at once (`frame.meshes`): `count` 3×4
 * row-major world matrices in `matrices` (12 floats each, `Transform.world`'s layout) and,
 * optionally, their `INSTANCE_PARAM_FLOATS` of params each in `params` (null or absent: the
 * defaults, white tint, full uv, the mesh's shadow flags, size from the matrix columns). The
 * renderer copies both straight into its instance upload. `bounds`, when given, is one
 * world-space sphere for the whole batch: the camera culls the batch with one test and never
 * per instance; without it each instance is culled by `mesh.bounds` through its matrix. The
 * batch is one sort key (its `order`, then its first instance's depth) and one draw. An
 * `InstanceList` is one.
 */
export interface InstanceBatch {
  /** Instances to draw (the first `count` of `matrices` / `params`). */
  count: number;
  /** `count` × 12 floats (at least). */
  matrices: Float32Array;
  /** `count` × `INSTANCE_PARAM_FLOATS` floats, or null for the defaults. */
  params?: Float32Array | null;
  /** One world-space sphere for the batch, or null to cull per instance. */
  bounds?: MeshBounds | null;
  /** Layer mask of every instance, matched against `camera.layers`. Default 1. */
  layerBits?: number;
  /** Sort key, as `InstanceParams.order`. Default 0. */
  order?: number;
  /** Draw into the sun's shadow map; default: the mesh is not in `VERTEX_LAYOUT_2D`. */
  castShadow?: boolean;
}

/**
 * Write the `INSTANCE_PARAM_FLOATS` of one instance (its fields after the matrix) at float
 * `o` of `dst` from `p`, with `sizeX`, `sizeY` as its `size` (`VSOut.size`: a transform's
 * scale.xy). Same defaults as `frame.mesh`: uv 0,0,1,1, white tint, zero params and emissive,
 * `packInstanceFlags(receiveShadow, layers)`.
 */
export function writeInstanceParams(
  dst: Float32Array,
  o: number,
  p: InstanceParams,
  sizeX = 1,
  sizeY = 1,
): void {
  const uv = p.uv;
  dst[o++] = uv ? uv[0]! : 0;
  dst[o++] = uv ? uv[1]! : 0;
  dst[o++] = uv ? uv[2]! : 1;
  dst[o++] = uv ? uv[3]! : 1;
  const t = p.tint;
  dst[o++] = t ? t[0]! : 1;
  dst[o++] = t ? t[1]! : 1;
  dst[o++] = t ? t[2]! : 1;
  dst[o++] = t ? (t[3] ?? 1) : 1;
  const q = p.params;
  dst[o++] = q ? q[0]! : 0;
  dst[o++] = q ? (q[1] ?? 0) : 0;
  dst[o++] = q ? (q[2] ?? 0) : 0;
  dst[o++] = q ? (q[3] ?? 0) : 0;
  dst[o++] = p.emissive ?? 0;
  dst[o++] = packInstanceFlags(p.receiveShadow !== false, p.layers ?? 1);
  dst[o++] = sizeX;
  dst[o] = sizeY;
}

/**
 * Per-draw instance fields other than placement. A draw placed by a `Transform` takes these;
 * `DrawParams` adds the 2D placement (x, y, w, h, rotation). Reuse the object across frames.
 */
export interface InstanceParams {
  /** Linear RGBA multiplier (HDR allowed). Default white. */
  tint?: ArrayLike<number>;
  /** Sub-rectangle of the texture: u0, v0, u1, v1. Default 0,0,1,1. */
  uv?: ArrayLike<number>;
  /** Free per-instance vec4 for custom materials (`in.params`). */
  params?: ArrayLike<number>;
  /** Emissive strength (`in.emissive`); the built-in sprite writes colour × this to bloom. */
  emissive?: number;
  /**
   * Draw this instance into the sun's shadow map when `frame.lights.sun.shadow` is set and the
   * material is opaque. Default: true for meshes in a 3D vertex layout, false for 2D sprites
   * and quads (`VERTEX_LAYOUT_2D`), so a 2D scene never renders a shadow pass.
   */
  castShadow?: boolean;
  /**
   * Set false to mark the instance as not receiving the sun's shadow: instance flag bit 0
   * (`in.flags & 1u`) is set and a material may skip `engine_shadow` for it. The engine's
   * `engine_lambert` does not read the flag. Default true (flag bit clear).
   */
  receiveShadow?: boolean;
  /**
   * This draw's own uniform block (f32s, copied at call time) for a material created with
   * `perDrawUniforms`. Lets many instances share one material, each with its own uniforms.
   */
  uniforms?: ArrayLike<number>;
  /**
   * Layer membership mask (u32). The draw is skipped when `layers & camera.layers` is 0.
   * Default 1. A camera without `layers` sees every layer.
   */
  layers?: number;
  /**
   * Sort key. Draws render by `order`, then submission order, so leaving it at the default 0
   * keeps plain submission order. With depth on it is still the first key (see the renderer).
   */
  order?: number;
}

/** Parameters for one instanced draw. Reuse the object across frames to avoid garbage. */
export interface DrawParams extends InstanceParams {
  /** Position (logical px). For the built-in quad this is the centre. */
  x: number;
  y: number;
  /** Scale. For the quad: size in logical px. Default 1. */
  w?: number;
  h?: number;
  /** Radians, clockwise on screen (y is down). */
  rotation?: number;
}

/**
 * Something that draws itself inside the scene pass (particles, custom pipelines).
 * `prepare` runs once per frame before the scene pass (compute work, uploads);
 * `draw` runs in draw order inside the scene pass, which has two colour targets
 * (HDR colour, HDR emissive) in `renderer.sceneFormats` and `@group(0)` = engine globals.
 * When the camera asks for depth the pass also has a depth attachment
 * (`frame.depthFormat`), and the drawable's pipeline must declare a matching `depthStencil`.
 */
export interface Drawable {
  prepare?(encoder: GPUCommandEncoder, frame: Frame): void;
  draw(pass: GPURenderPassEncoder, frame: Frame): void;
}

/** Hooks the renderer exposes to Frame (kept internal). */
export interface FrameSink {
  /**
   * `t` places the draw when given; otherwise `p` is a `DrawParams`. `bounds` is the mesh-space
   * sphere the draw is frustum-culled by (through its instance matrix), or null for a draw that
   * is never culled (sprites).
   */
  pushInstance(
    material: Material,
    mesh: Mesh,
    t: Transform | null,
    p: DrawParams | InstanceParams,
    bounds: MeshBounds | null,
  ): void;
  /**
   * A batch of `mesh` with `material` (`frame.meshes` / `frame.list`); `bounds` is the mesh's
   * sphere for per-instance culling when the batch gives none. `list` is the retained list
   * the batch is, if any (its instances live in its own buffer).
   */
  pushBatch(
    material: Material,
    mesh: Mesh,
    batch: InstanceBatch,
    bounds: MeshBounds | null,
    list: InstanceList | null,
  ): void;
  pushDrawable(d: Drawable, order: number, layers: number): void;
  pushPrePass(fn: (encoder: GPUCommandEncoder) => void): void;
  readonly defaultSprite: Material;
  readonly quad: Mesh;
}

const NO_PARAMS: InstanceParams = Object.freeze({});

/**
 * Per-frame draw recorder. Obtained from `renderer.beginFrame()`; the same object is reused
 * every frame. Draws render sorted by `order` (default 0), then call order; consecutive draws
 * with the same material, mesh and uniforms merge into one instanced draw call. `meshes` draws
 * a typed-array batch and `list` a retained `InstanceList`, each as one unit.
 */
export class Frame {
  /** Seconds since renderer start (or whatever the caller passed to beginFrame). */
  time = 0;
  /** Seconds since last frame. */
  dt = 0;
  /** Linear clear colour for the HDR colour target. */
  readonly clearColor: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };
  /**
   * Depth attachment format of this frame's scene pass, or null when the camera has no depth
   * (the 2D path). Set by the renderer before `prepare`/`draw` run.
   */
  depthFormat: GPUTextureFormat | null = null;
  /**
   * The frame's lights, uploaded as `EngineLights` (`@group(0) @binding(2)`) with every view.
   * Defaults to an unlit block (ambient 1, no sun, no points), so materials that read it draw
   * their albedo unchanged until the game sets it. Mutate it or assign another `Lights`; the
   * object persists across frames (it is not reset by `beginFrame`).
   */
  lights: Lights = new Lights();

  constructor(
    private readonly sink: FrameSink,
    readonly logicalWidth: number,
    readonly logicalHeight: number,
  ) {}

  clear(r: number, g: number, b: number, a = 1): void {
    const c = this.clearColor;
    c.r = r;
    c.g = g;
    c.b = b;
    c.a = a;
  }

  /**
   * Draw a quad with `material` (default: built-in white sprite), placed by `DrawParams`
   * (x, y = centre, w, h = size, rotation) or by a `Transform` (the quad spans -0.5..0.5 in
   * its local space, so the transform's scale is the size).
   */
  sprite(material: Material | null, p: DrawParams): void;
  sprite(material: Material | null, t: Transform, p?: InstanceParams): void;
  sprite(material: Material | null, a: DrawParams | Transform, b?: InstanceParams): void {
    const m = material ?? this.sink.defaultSprite;
    const q = this.sink.quad;
    if (a instanceof Transform) this.sink.pushInstance(m, q, a, b ?? NO_PARAMS, null);
    else this.sink.pushInstance(m, q, null, a, null);
  }

  /**
   * Draw `mesh` with `material`, placed by `DrawParams` (x, y, w, h, rotation) or a `Transform`.
   * The draw carries `mesh.bounds` through its instance matrix, so a camera with `cull` on
   * skips it when the sphere is outside the frustum (sprites are never culled).
   */
  mesh(mesh: Mesh, material: Material, p: DrawParams): void;
  mesh(mesh: Mesh, material: Material, t: Transform, p?: InstanceParams): void;
  mesh(mesh: Mesh, material: Material, a: DrawParams | Transform, b?: InstanceParams): void {
    const bounds = mesh.bounds;
    if (a instanceof Transform) this.sink.pushInstance(material, mesh, a, b ?? NO_PARAMS, bounds);
    else this.sink.pushInstance(material, mesh, null, a, bounds);
  }

  /**
   * Draw `batch.count` instances of `mesh` with `material` from typed arrays (`InstanceBatch`):
   * the bulk path for many things that change every frame. One sort key and one draw call;
   * culled as one sphere when `batch.bounds` is given, else per instance by `mesh.bounds`.
   * Throws when `matrices` or `params` are too short for `count`.
   */
  meshes(mesh: Mesh, material: Material, batch: InstanceBatch): void {
    if (batch.count <= 0) return;
    if (batch.matrices.length < batch.count * 12) {
      throw new Error(
        `frame.meshes: matrices holds ${batch.matrices.length} floats for ${batch.count} instances`,
      );
    }
    if (batch.params && batch.params.length < batch.count * INSTANCE_PARAM_FLOATS) {
      throw new Error(
        `frame.meshes: params holds ${batch.params.length} floats for ${batch.count} instances`,
      );
    }
    this.sink.pushBatch(material, mesh, batch, mesh.bounds, null);
  }

  /**
   * Draw a retained `InstanceList` (`renderer.createInstanceList`): its instances live in their
   * own GPU buffer, uploaded only where `set` / `remove` changed them since the last frame.
   * Culled as one sphere (`list.bounds`), one draw call.
   */
  list(list: InstanceList): void {
    if (list.count <= 0) return;
    this.sink.pushBatch(list.material, list.mesh, list, null, list);
  }

  /**
   * Insert a custom drawable (e.g. a particle system) at this point in the draw order, with
   * sort key `order` (default 0) and layer mask `layers` (default 1).
   */
  drawable(d: Drawable, order = 0, layers = 1): void {
    this.sink.pushDrawable(d, order, layers);
  }

  /** Run `fn` before the scene pass (offscreen passes, compute). Pass a stable function. */
  prePass(fn: (encoder: GPUCommandEncoder) => void): void {
    this.sink.pushPrePass(fn);
  }
}
