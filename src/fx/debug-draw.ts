import type { Drawable, Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { auxSuffix, ScenePipelineCache, sceneVariant } from '../render/scene-pipelines';
import type { ReadonlyQuat, ReadonlyVec3, Transform } from '../render/transform';
import { createShaderModule } from '../render/wgsl';
import { DEBUG_DRAW_WGSL } from './debug-wgsl';

/** `[r, g, b, a]` in linear 0..1 (alpha defaults to 1), or a packed `0xRRGGBBAA` (each 0..255). */
export type DebugColor = ArrayLike<number> | number;
/** A point or direction: `[x, y, z]`, a typed array, or an `{ x, y, z }` (a `Transform.position`). */
export type DebugVec3 = ArrayLike<number> | ReadonlyVec3;
/** A unit quaternion: `[x, y, z, w]` or `{ x, y, z, w }` (a `Transform.quaternion`). */
export type DebugQuat = ArrayLike<number> | ReadonlyQuat;

export interface DebugDrawOptions {
  /** Segments the CPU array and GPU buffer hold before growing by 1.5×. Default 16384. */
  capacity?: number;
  /**
   * `'test'` (default): lines hide behind geometry already drawn (depth tested, never written).
   * `'always'`: no depth test at all, for overlays that must show through walls.
   */
  depth?: 'test' | 'always';
  /** Keep the segments after `draw` instead of clearing them (static scenes). Default false. */
  retain?: boolean;
  label?: string;
}

/** Floats per line vertex: x, y, z, r, g, b, a. */
export const DEBUG_VERTEX_FLOATS = 7;
/** Floats per segment (two vertices). */
const SF = DEBUG_VERTEX_FLOATS * 2;
const STRIDE = DEBUG_VERTEX_FLOATS * 4;
const DEFAULT_CAPACITY = 16384;
const GROWTH = 1.5;

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

// Scratch vectors shared by the shape writers (never handed out).
const p1 = new Float32Array(3);
const p2 = new Float32Array(3);
const ax = new Float32Array(3);
const ay = new Float32Array(3);
const az = new Float32Array(3);
const corners = new Float32Array(24);

function vx(v: DebugVec3): number {
  return typeof (v as ReadonlyVec3).x === 'number'
    ? (v as ReadonlyVec3).x
    : (v as ArrayLike<number>)[0]!;
}
function vy(v: DebugVec3): number {
  return typeof (v as ReadonlyVec3).y === 'number'
    ? (v as ReadonlyVec3).y
    : (v as ArrayLike<number>)[1]!;
}
function vz(v: DebugVec3): number {
  return typeof (v as ReadonlyVec3).z === 'number'
    ? (v as ReadonlyVec3).z
    : (v as ArrayLike<number>)[2]!;
}
function qw(q: DebugQuat): number {
  return typeof (q as ReadonlyQuat).w === 'number'
    ? (q as ReadonlyQuat).w
    : (q as ArrayLike<number>)[3]!;
}

/** `out` = unit vectors `a`, `b` perpendicular to `d` (any length). Degenerate `d` gives x, y. */
function basis(dx: number, dy: number, dz: number, a: Float32Array, b: Float32Array): void {
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-12) {
    a[0] = 1;
    a[1] = 0;
    a[2] = 0;
    b[0] = 0;
    b[1] = 1;
    b[2] = 0;
    return;
  }
  const nx = dx / l;
  const ny = dy / l;
  const nz = dz / l;
  // Cross with the axis least aligned to d.
  if (Math.abs(ny) < 0.9) {
    a[0] = -nz;
    a[1] = 0;
    a[2] = nx;
  } else {
    a[0] = 0;
    a[1] = nz;
    a[2] = -ny;
  }
  const al = Math.hypot(a[0]!, a[1]!, a[2]!);
  a[0]! /= al;
  a[1]! /= al;
  a[2]! /= al;
  b[0] = ny * a[2]! - nz * a[1]!;
  b[1] = nz * a[0]! - nx * a[2]!;
  b[2] = nx * a[1]! - ny * a[0]!;
}

/** Rotate `(x, y, z)` by the unit quaternion `q` into `out`. */
function rotate(q: DebugQuat, x: number, y: number, z: number, out: Float32Array): void {
  const qx = vx(q);
  const qy = vy(q);
  const qz = vz(q);
  const w = qw(q);
  // t = 2 (q.xyz × v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + w * tx + (qy * tz - qz * ty);
  out[1] = y + w * ty + (qz * tx - qx * tz);
  out[2] = z + w * tz + (qx * ty - qy * tx);
}

/**
 * World-space line drawing without a mesh: wire boxes and spheres, axes, arrows, grids, paths,
 * frustums. Every call appends segments to one CPU `Float32Array` (xyz + rgba per vertex);
 * `draw` uploads the used range in one `writeBuffer` and issues one `'line-list'` draw, so a
 * frame of debug lines costs one draw call however many shapes it holds. Lines are 1 px wide
 * (WebGPU `line-list`), unlit, alpha blended, never written to depth.
 *
 * ```ts
 * const debug = createDebugDraw(renderer);          // once
 * debug.axes(transform, 1);                        // every frame, from any system
 * debug.wireSphere(pos, radius, 0x00ff00ff);
 * frame.drawable(debug);                           // draw(pass, frame) runs in the scene pass
 * ```
 *
 * Segments clear after `draw` (unless `retain`). The array and GPU buffer grow by 1.5× when
 * full; after that nothing allocates per frame.
 */
export class DebugDraw implements Drawable {
  private readonly device: GPUDevice;
  private readonly label: string;
  private readonly depth: 'test' | 'always';
  private readonly retain: boolean;
  private readonly renderer: Renderer;
  /**
   * Pipelines per depth format (null: none) × the view target's aux key, built on first use
   * from `renderer.sceneTargets` (ws/render-10).
   */
  private readonly pipelines = new ScenePipelineCache();
  private readonly desc: GPURenderPipelineDescriptor;
  private verts: Float32Array<ArrayBuffer>;
  private buffer: GPUBuffer | null = null;
  private segments = 0;
  private cap: number;
  private _uploads = 0;
  // The current colour, set once per shape call.
  private cr = 1;
  private cg = 1;
  private cb = 1;
  private ca = 1;

  constructor(renderer: Renderer, opts: DebugDrawOptions = {}) {
    this.device = renderer.device;
    this.renderer = renderer;
    this.label = opts.label ?? 'debug-draw';
    this.depth = opts.depth ?? 'test';
    this.retain = opts.retain ?? false;
    this.cap = Math.max(1, Math.floor(opts.capacity ?? DEFAULT_CAPACITY));
    this.verts = new Float32Array(this.cap * SF);
    const module = createShaderModule(this.device, DEBUG_DRAW_WGSL, this.label);
    this.desc = {
      label: this.label,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [renderer.globalsLayout] }),
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: renderer.sceneTargets(ALPHA_BLEND),
      },
      primitive: { topology: 'line-list' },
    };
  }

  /** Segments appended since the last clear. */
  get count(): number {
    return this.segments;
  }

  /** Segments the array holds before the next growth. */
  get capacity(): number {
    return this.cap;
  }

  /** `writeBuffer` calls so far (one per `draw` with segments). */
  get uploads(): number {
    return this._uploads;
  }

  // ------------------------------------------------------------------ primitives

  private color(c: DebugColor): void {
    if (typeof c === 'number') {
      const u = c >>> 0;
      this.cr = ((u >>> 24) & 255) / 255;
      this.cg = ((u >>> 16) & 255) / 255;
      this.cb = ((u >>> 8) & 255) / 255;
      this.ca = (u & 255) / 255;
    } else {
      this.cr = c[0]!;
      this.cg = c[1]!;
      this.cb = c[2]!;
      this.ca = c.length > 3 ? c[3]! : 1;
    }
  }

  /** Make room for `n` more segments (grows the CPU array by 1.5×; the buffer follows at draw). */
  private reserve(n: number): void {
    const need = this.segments + n;
    if (need <= this.cap) return;
    let cap = this.cap;
    while (cap < need) cap = Math.ceil(cap * GROWTH);
    const next = new Float32Array(cap * SF);
    next.set(this.verts.subarray(0, this.segments * SF));
    this.verts = next;
    this.cap = cap;
  }

  /** Append one segment in the current colour. Callers `reserve` first. */
  private seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const v = this.verts;
    let o = this.segments * SF;
    v[o++] = ax;
    v[o++] = ay;
    v[o++] = az;
    v[o++] = this.cr;
    v[o++] = this.cg;
    v[o++] = this.cb;
    v[o++] = this.ca;
    v[o++] = bx;
    v[o++] = by;
    v[o++] = bz;
    v[o++] = this.cr;
    v[o++] = this.cg;
    v[o++] = this.cb;
    v[o] = this.ca;
    this.segments++;
  }

  // ------------------------------------------------------------------ shapes

  /** One segment from `a` to `b`. */
  line(a: DebugVec3, b: DebugVec3, color: DebugColor): void {
    this.color(color);
    this.reserve(1);
    this.seg(vx(a), vy(a), vz(a), vx(b), vy(b), vz(b));
  }

  /** A segment of `length` from `origin` along `dir` (normalised here; a zero `dir` draws nothing). */
  ray(origin: DebugVec3, dir: DebugVec3, length: number, color: DebugColor): void {
    const dx = vx(dir);
    const dy = vy(dir);
    const dz = vz(dir);
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-12) return;
    const s = length / l;
    const ox = vx(origin);
    const oy = vy(origin);
    const oz = vz(origin);
    this.color(color);
    this.reserve(1);
    this.seg(ox, oy, oz, ox + dx * s, oy + dy * s, oz + dz * s);
  }

  /**
   * A segment from `a` to `b` with a four-line head at `b`. `headSize` is the head's length
   * along the shaft (default 15% of the arrow, at most the whole shaft); five segments.
   */
  arrow(a: DebugVec3, b: DebugVec3, color: DebugColor, headSize?: number): void {
    const ax0 = vx(a);
    const ay0 = vy(a);
    const az0 = vz(a);
    const bx = vx(b);
    const by = vy(b);
    const bz = vz(b);
    const dx = bx - ax0;
    const dy = by - ay0;
    const dz = bz - az0;
    const l = Math.hypot(dx, dy, dz);
    this.color(color);
    if (l < 1e-12) {
      this.reserve(1);
      this.seg(ax0, ay0, az0, bx, by, bz);
      return;
    }
    const h = Math.min(headSize ?? l * 0.15, l);
    const hw = h * 0.5;
    basis(dx, dy, dz, p1, p2);
    // The head's base point on the shaft.
    const cx = bx - (dx / l) * h;
    const cy = by - (dy / l) * h;
    const cz = bz - (dz / l) * h;
    this.reserve(5);
    this.seg(ax0, ay0, az0, bx, by, bz);
    this.seg(bx, by, bz, cx + p1[0]! * hw, cy + p1[1]! * hw, cz + p1[2]! * hw);
    this.seg(bx, by, bz, cx - p1[0]! * hw, cy - p1[1]! * hw, cz - p1[2]! * hw);
    this.seg(bx, by, bz, cx + p2[0]! * hw, cy + p2[1]! * hw, cz + p2[2]! * hw);
    this.seg(bx, by, bz, cx - p2[0]! * hw, cy - p2[1]! * hw, cz - p2[2]! * hw);
  }

  /** The twelve edges of a box of `halfExtents` about `center`, optionally rotated by `rotation`. */
  box(center: DebugVec3, halfExtents: DebugVec3, color: DebugColor, rotation?: DebugQuat): void {
    const hx = vx(halfExtents);
    const hy = vy(halfExtents);
    const hz = vz(halfExtents);
    if (rotation) {
      rotate(rotation, hx, 0, 0, ax);
      rotate(rotation, 0, hy, 0, ay);
      rotate(rotation, 0, 0, hz, az);
    } else {
      ax[0] = hx;
      ax[1] = 0;
      ax[2] = 0;
      ay[0] = 0;
      ay[1] = hy;
      ay[2] = 0;
      az[0] = 0;
      az[1] = 0;
      az[2] = hz;
    }
    const cx = vx(center);
    const cy = vy(center);
    const cz = vz(center);
    // Corner i: bit 0 = +x, bit 1 = +y, bit 2 = +z.
    for (let i = 0; i < 8; i++) {
      const sx = i & 1 ? 1 : -1;
      const sy = i & 2 ? 1 : -1;
      const sz = i & 4 ? 1 : -1;
      corners[i * 3] = cx + sx * ax[0]! + sy * ay[0]! + sz * az[0]!;
      corners[i * 3 + 1] = cy + sx * ax[1]! + sy * ay[1]! + sz * az[1]!;
      corners[i * 3 + 2] = cz + sx * ax[2]! + sy * ay[2]! + sz * az[2]!;
    }
    this.color(color);
    this.reserve(12);
    this.edges();
  }

  /** The twelve edges of the cube whose corners sit in `corners` (bit 0 = +x, 1 = +y, 2 = +z). */
  private edges(): void {
    for (let i = 0; i < 8; i++) {
      for (let bit = 1; bit < 8; bit <<= 1) {
        if (i & bit) continue;
        const j = i | bit;
        this.seg(
          corners[i * 3]!,
          corners[i * 3 + 1]!,
          corners[i * 3 + 2]!,
          corners[j * 3]!,
          corners[j * 3 + 1]!,
          corners[j * 3 + 2]!,
        );
      }
    }
  }

  /**
   * Three great circles (XY, XZ and YZ planes) of `radius` about `center`, each of `2 × rings`
   * segments (`rings` at least 3): `6 × rings` segments.
   */
  wireSphere(center: DebugVec3, radius: number, color: DebugColor, rings = 12): void {
    const n = Math.max(3, Math.floor(rings)) * 2;
    const cx = vx(center);
    const cy = vy(center);
    const cz = vz(center);
    this.color(color);
    this.reserve(n * 3);
    const step = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const a0 = i * step;
      const a1 = (i + 1) * step;
      const c0 = Math.cos(a0) * radius;
      const s0 = Math.sin(a0) * radius;
      const c1 = Math.cos(a1) * radius;
      const s1 = Math.sin(a1) * radius;
      this.seg(cx + c0, cy + s0, cz, cx + c1, cy + s1, cz);
      this.seg(cx + c0, cy, cz + s0, cx + c1, cy, cz + s1);
      this.seg(cx, cy + c0, cz + s0, cx, cy + c1, cz + s1);
    }
  }

  /**
   * The frame of a `Transform` (its world matrix) or of a 3×4 row-major matrix: x red, y green,
   * z blue, each axis normalised to `size`. Three segments.
   */
  axes(transform: Transform | ArrayLike<number>, size: number): void {
    const m =
      'world' in (transform as object)
        ? (transform as Transform).world
        : (transform as ArrayLike<number>);
    const ox = m[3]!;
    const oy = m[7]!;
    const oz = m[11]!;
    this.reserve(3);
    for (let c = 0; c < 3; c++) {
      const x = m[c]!;
      const y = m[4 + c]!;
      const z = m[8 + c]!;
      const l = Math.hypot(x, y, z);
      const s = l > 1e-12 ? size / l : 0;
      this.cr = c === 0 ? 1 : 0;
      this.cg = c === 1 ? 1 : 0;
      this.cb = c === 2 ? 1 : 0;
      this.ca = 1;
      this.seg(ox, oy, oz, ox + x * s, oy + y * s, oz + z * s);
    }
  }

  /**
   * A square grid in the XZ plane (y = `center.y`) of `size` on a side about `center`, a line
   * every `step` along both axes: `2 × (floor(size / step) + 1)` segments.
   */
  grid(center: DebugVec3, size: number, step: number, color: DebugColor): void {
    if (!(step > 0) || !(size >= 0)) return;
    const n = Math.floor(size / step + 1e-9);
    const half = (n * step) / 2;
    const cx = vx(center);
    const cy = vy(center);
    const cz = vz(center);
    this.color(color);
    this.reserve((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const t = -half + i * step;
      this.seg(cx - half, cy, cz + t, cx + half, cy, cz + t);
      this.seg(cx + t, cy, cz - half, cx + t, cy, cz + half);
    }
  }

  /** A circle of `radius` about `center` in the plane perpendicular to `normal`. */
  circle(
    center: DebugVec3,
    normal: DebugVec3,
    radius: number,
    color: DebugColor,
    segments = 32,
  ): void {
    const n = Math.max(3, Math.floor(segments));
    basis(vx(normal), vy(normal), vz(normal), p1, p2);
    const cx = vx(center);
    const cy = vy(center);
    const cz = vz(center);
    this.color(color);
    this.reserve(n);
    const step = (Math.PI * 2) / n;
    let px = cx + p1[0]! * radius;
    let py = cy + p1[1]! * radius;
    let pz = cz + p1[2]! * radius;
    for (let i = 1; i <= n; i++) {
      const c = Math.cos(i * step) * radius;
      const s = Math.sin(i * step) * radius;
      const x = cx + p1[0]! * c + p2[0]! * s;
      const y = cy + p1[1]! * c + p2[1]! * s;
      const z = cz + p1[2]! * c + p2[2]! * s;
      this.seg(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
  }

  /**
   * A polyline through `count` points read from `points` (`stride` floats apart, from float
   * `offset`; default every point in the array): `count - 1` segments.
   */
  path(
    points: Float32Array | ArrayLike<number>,
    color: DebugColor,
    stride = 3,
    offset = 0,
    count?: number,
  ): void {
    const n = count ?? Math.floor((points.length - offset) / stride);
    if (n < 2) return;
    this.color(color);
    this.reserve(n - 1);
    let o = offset;
    let px = points[o]!;
    let py = points[o + 1]!;
    let pz = points[o + 2]!;
    for (let i = 1; i < n; i++) {
      o += stride;
      const x = points[o]!;
      const y = points[o + 1]!;
      const z = points[o + 2]!;
      this.seg(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
  }

  /**
   * The twelve edges of the view volume of a camera, from the inverse of its view-projection
   * (column-major 4×4, as `Camera.viewProjection` is stored): the clip-space cube x, y in
   * -1..1 and z in 0..1 (WebGPU depth) unprojected and divided by w.
   */
  frustum(invViewProj: ArrayLike<number>, color: DebugColor): void {
    const m = invViewProj;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? 1 : -1;
      const y = i & 2 ? 1 : -1;
      const z = i & 4 ? 1 : 0;
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      const iw = Math.abs(w) > 1e-12 ? 1 / w : 0;
      corners[i * 3] = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw;
      corners[i * 3 + 1] = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw;
      corners[i * 3 + 2] = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw;
    }
    this.color(color);
    this.reserve(12);
    this.edges();
  }

  // ------------------------------------------------------------------ draw

  /** Drop every segment (implicit after `draw` unless `retain`). */
  clear(): void {
    this.segments = 0;
  }

  /**
   * Upload the used range and draw it as one `'line-list'` inside the scene pass, with the
   * pipeline for `frame.depthFormat` (built on first use). Nothing is recorded when empty.
   */
  draw(pass: GPURenderPassEncoder, frame: Frame): void {
    const n = this.segments;
    if (n > 0) {
      const bytes = this.cap * SF * 4;
      let buffer = this.buffer;
      if (!buffer || buffer.size < bytes) {
        buffer?.destroy();
        buffer = this.device.createBuffer({
          label: this.label,
          size: bytes,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.buffer = buffer;
      }
      this.device.queue.writeBuffer(buffer, 0, this.verts, 0, n * SF);
      this._uploads++;
      pass.setPipeline(this.pipeline(frame.depthFormat, frame.auxKey));
      pass.setVertexBuffer(0, buffer, 0, n * SF * 4);
      pass.draw(n * 2);
    }
    if (!this.retain) this.segments = 0;
  }

  private pipeline(format: GPUTextureFormat | null, aux: number): GPURenderPipeline {
    const p = this.pipelines.get(format, aux);
    if (p) return p;
    return this.pipelines.set(
      format,
      aux,
      this.device.createRenderPipeline(
        sceneVariant(
          this.desc,
          this.renderer.sceneTargets(ALPHA_BLEND, aux),
          `${this.label}${format ? `:${format}:${this.depth}` : ''}${auxSuffix(aux)}`,
          format
            ? {
                format,
                depthWriteEnabled: false,
                depthCompare: this.depth === 'always' ? 'always' : 'less-equal',
              }
            : undefined,
        ),
      ),
    );
  }

  /** Free the GPU buffer. The object draws nothing afterwards until segments are appended. */
  destroy(): void {
    this.buffer?.destroy();
    this.buffer = null;
    this.segments = 0;
  }
}

/** Make a `DebugDraw` for `renderer`; see the class. */
export function createDebugDraw(renderer: Renderer, opts: DebugDrawOptions = {}): DebugDraw {
  return new DebugDraw(renderer, opts);
}
