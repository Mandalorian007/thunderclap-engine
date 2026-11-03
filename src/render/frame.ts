import type { Material } from './material';
import type { Mesh } from './mesh';

/** Parameters for one instanced draw. Reuse the object across frames to avoid garbage. */
export interface DrawParams {
  /** Position (logical px). For the built-in quad this is the centre. */
  x: number;
  y: number;
  /** Scale. For the quad: size in logical px. Default 1. */
  w?: number;
  h?: number;
  /** Radians, clockwise on screen (y is down). */
  rotation?: number;
  /** Linear RGBA multiplier (HDR allowed). Default white. */
  tint?: ArrayLike<number>;
  /** Sub-rectangle of the texture: u0, v0, u1, v1. Default 0,0,1,1. */
  uv?: ArrayLike<number>;
  /** Free per-instance vec4 for custom materials (`in.params`). */
  params?: ArrayLike<number>;
  /** Emissive strength (`in.emissive`); the built-in sprite writes colour × this to bloom. */
  emissive?: number;
  /**
   * This draw's own uniform block (f32s, copied at call time) for a material created with
   * `perDrawUniforms`. Lets many instances share one material, each with its own uniforms.
   */
  uniforms?: ArrayLike<number>;
}

/**
 * Something that draws itself inside the scene pass (particles, custom pipelines).
 * `prepare` runs once per frame before the scene pass (compute work, uploads);
 * `draw` runs in submission order inside the scene pass, which has two colour targets
 * (HDR colour, HDR emissive) in `renderer.sceneFormats` and `@group(0)` = engine globals.
 */
export interface Drawable {
  prepare?(encoder: GPUCommandEncoder, frame: Frame): void;
  draw(pass: GPURenderPassEncoder, frame: Frame): void;
}

/** Hooks the renderer exposes to Frame (kept internal). */
export interface FrameSink {
  pushInstance(material: Material, mesh: Mesh, p: DrawParams): void;
  pushDrawable(d: Drawable): void;
  pushPrePass(fn: (encoder: GPUCommandEncoder) => void): void;
  readonly defaultSprite: Material;
  readonly quad: Mesh;
}

/**
 * Per-frame draw recorder. Obtained from `renderer.beginFrame()`; the same object is reused
 * every frame. Draws are rendered in call order; consecutive draws with the same material
 * and mesh merge into one instanced draw call.
 */
export class Frame {
  /** Seconds since renderer start (or whatever the caller passed to beginFrame). */
  time = 0;
  /** Seconds since last frame. */
  dt = 0;
  /** Linear clear colour for the HDR colour target. */
  readonly clearColor: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };

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

  /** Draw a quad with `material` (default: built-in white sprite). */
  sprite(material: Material | null, p: DrawParams): void {
    this.sink.pushInstance(material ?? this.sink.defaultSprite, this.sink.quad, p);
  }

  /** Draw `mesh` with `material`, transformed by `p` (x, y, w, h, rotation). */
  mesh(mesh: Mesh, material: Material, p: DrawParams): void {
    this.sink.pushInstance(material, mesh, p);
  }

  /** Insert a custom drawable (e.g. a particle system) at this point in the draw order. */
  drawable(d: Drawable): void {
    this.sink.pushDrawable(d);
  }

  /** Run `fn` before the scene pass (offscreen passes, compute). Pass a stable function. */
  prePass(fn: (encoder: GPUCommandEncoder) => void): void {
    this.sink.pushPrePass(fn);
  }
}
