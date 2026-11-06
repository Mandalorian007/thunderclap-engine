import { Lights } from './lights';
import type { Material } from './material';
import type { Mesh } from './mesh';
import { Transform } from './transform';

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
  /** `t` places the draw when given; otherwise `p` is a `DrawParams`. */
  pushInstance(
    material: Material,
    mesh: Mesh,
    t: Transform | null,
    p: DrawParams | InstanceParams,
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
 * with the same material, mesh and uniforms merge into one instanced draw call.
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
    if (a instanceof Transform) this.sink.pushInstance(m, this.sink.quad, a, b ?? NO_PARAMS);
    else this.sink.pushInstance(m, this.sink.quad, null, a);
  }

  /** Draw `mesh` with `material`, placed by `DrawParams` (x, y, w, h, rotation) or a `Transform`. */
  mesh(mesh: Mesh, material: Material, p: DrawParams): void;
  mesh(mesh: Mesh, material: Material, t: Transform, p?: InstanceParams): void;
  mesh(mesh: Mesh, material: Material, a: DrawParams | Transform, b?: InstanceParams): void {
    if (a instanceof Transform) this.sink.pushInstance(material, mesh, a, b ?? NO_PARAMS);
    else this.sink.pushInstance(material, mesh, null, a);
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
