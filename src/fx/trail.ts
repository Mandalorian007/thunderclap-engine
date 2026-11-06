import type { Camera } from '../render/camera';
import type { Frame, InstanceParams } from '../render/frame';
import type { Material } from '../render/material';
import { type Mesh, type MeshUpdate, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from '../render/mesh';
import type { Renderer } from '../render/renderer';
import type { TextureLike } from '../render/texture';
import { Transform } from '../render/transform';
import { TRAIL_TEXTURED_WGSL, TRAIL_WGSL } from './trail-wgsl';

/**
 * Which way the ribbon's face turns: `'camera'` (toward the camera passed to `update`; in 2D,
 * flat in the XY plane), `'up'` (the ribbon lies flat, its face along +y) or a fixed axis the
 * face is perpendicular to the motion and to.
 */
export type TrailFacing = 'camera' | 'up' | readonly [number, number, number];

/** `'additive'`: glows and sparks. `'alpha'`: straight alpha over the scene. */
export type TrailBlend = 'alpha' | 'additive';

export interface TrailOptions {
  /**
   * `'2d'` (default): points in logical px, z optional (the ribbon lies in the XY plane).
   * `'world'`: points in world units, y up, the ribbon facing the camera or a fixed axis.
   */
  space?: '2d' | 'world';
  /** Points kept (ring buffer; the oldest drops when full). Default 64, at least 2. */
  maxPoints?: number;
  /** Ribbon width (px in 2D, world units in world space). Default 12 / 0.2. */
  width?: number;
  /**
   * Width over age instead of `width`: stops from the newest point (age 0) to the oldest (age
   * `lifetime`), linearly interpolated. `width` still sets the tile length of `uvMode: 'tile'`.
   */
  widthCurve?: ArrayLike<number>;
  /** Linear RGBA (HDR ok). Default white. */
  color?: ArrayLike<number>;
  /** Colour over age instead of `color`: RGBA stops, newest to oldest. */
  colorCurve?: ArrayLike<number>;
  /**
   * Alpha multiplier over age: stops, newest to oldest, applied on top of `color` /
   * `colorCurve`. Default `[1, 0]` (a linear fade out); `null` for none.
   */
  fade?: ArrayLike<number> | null;
  /** Seconds a point lives. Default 0.5. */
  lifetime?: number;
  /**
   * Minimum distance between stored points. A push closer than this to the newest stored point
   * moves the ribbon's tip without storing a point. Default 2 px / 0.02 units.
   */
  minDistance?: number;
  /** Default `'camera'`. */
  facing?: TrailFacing;
  /** Default `'additive'`. */
  blend?: TrailBlend;
  /** Multiplied in, `u` along the ribbon and `v` across it. Default none (vertex colour only). */
  texture?: TextureLike;
  /**
   * `'stretch'` (default): `u` runs 0 at the tip to 1 at the tail, whatever the length.
   * `'tile'`: one repeat of the texture per `width` of ribbon length, anchored at the tip.
   */
  uvMode?: 'stretch' | 'tile';
  /** Share of the half width that fades toward each long edge, 0..1. Default 0.5. */
  softness?: number;
  label?: string;
}

/** The per-frame look of a ribbon, read by the geometry writer (public fields on `Trail`). */
interface TrailStyle {
  readonly space: '2d' | 'world';
  lifetime: number;
  width: number;
  facing: TrailFacing;
  readonly widthCurve: Float32Array | null;
  readonly color: Float32Array;
  readonly colorCurve: Float32Array | null;
  readonly fade: Float32Array | null;
  readonly uvMode: 'stretch' | 'tile';
}

/** Point stride in the ring: x, y, z, birth time. */
const PF = 4;
const VF = VERTEX3D_FLOATS;
const DEFAULT_FADE = new Float32Array([1, 0]);
const UP = new Float32Array([0, 1, 0]);
const Z = new Float32Array([0, 0, 1]);

/** Linear sample of channel `ch` of a table of `stride`-float stops at `t` in 0..1. */
function sampleCurve(table: Float32Array, stride: number, ch: number, t: number): number {
  const stops = table.length / stride;
  if (stops <= 1) return table[ch] ?? 0;
  const k = t * (stops - 1);
  const i = Math.min(Math.floor(k), stops - 2);
  const f = k - i;
  return table[i * stride + ch]! * (1 - f) + table[(i + 1) * stride + ch]! * f;
}

function toTable(src: ArrayLike<number> | null | undefined): Float32Array | null {
  if (!src || src.length === 0) return null;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i]!;
  return out;
}

/** Index buffer for `quads` ribbon quads over vertices 0.. (two per point). */
function ribbonIndices(quads: number, vertices: number): Uint16Array | Uint32Array {
  const idx = vertices > 0xffff ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  writeQuads(idx, 0, 0, quads);
  return idx;
}

/** Write `quads` quads starting at vertex `base` into `idx` at `at`; returns the next index. */
function writeQuads(idx: Uint16Array | Uint32Array, at: number, base: number, quads: number) {
  let o = at;
  for (let q = 0; q < quads; q++) {
    const a = base + q * 2;
    idx[o++] = a;
    idx[o++] = a + 1;
    idx[o++] = a + 2;
    idx[o++] = a + 1;
    idx[o++] = a + 3;
    idx[o++] = a + 2;
  }
  return o;
}

/**
 * The points of one ribbon: a ring of stored points (x, y, z, birth time) plus the tip, the
 * latest pushed position, which is drawn as an extra, age-0 point when it sits apart from the
 * newest stored point. Nothing here touches the GPU.
 */
class Ring {
  readonly pts: Float32Array;
  tail = 0;
  /** Stored points. */
  n = 0;
  readonly tip = new Float32Array(3);
  hasTip = false;

  constructor(readonly cap: number) {
    this.pts = new Float32Array(cap * PF);
  }

  /** Store or move the tip; true when a point was stored. */
  push(x: number, y: number, z: number, now: number, minDistance: number): boolean {
    const tip = this.tip;
    tip[0] = x;
    tip[1] = y;
    tip[2] = z;
    this.hasTip = true;
    if (this.n > 0) {
      const o = ((this.tail + this.n - 1) % this.cap) * PF;
      const p = this.pts;
      const dx = x - p[o]!;
      const dy = y - p[o + 1]!;
      const dz = z - p[o + 2]!;
      if (dx * dx + dy * dy + dz * dz < minDistance * minDistance) return false;
    }
    if (this.n === this.cap) {
      this.tail = (this.tail + 1) % this.cap;
      this.n--;
    }
    const o = ((this.tail + this.n) % this.cap) * PF;
    const p = this.pts;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
    p[o + 3] = now;
    this.n++;
    return true;
  }

  /** Drop stored points older than `lifetime`. */
  expire(now: number, lifetime: number): void {
    const p = this.pts;
    while (this.n > 0 && now - p[this.tail * PF + 3]! > lifetime) {
      this.tail = (this.tail + 1) % this.cap;
      this.n--;
    }
  }

  /** Does the tip sit apart from the newest stored point (so it is drawn)? */
  tipApart(): boolean {
    if (!this.hasTip) return false;
    if (this.n === 0) return true;
    const o = ((this.tail + this.n - 1) % this.cap) * PF;
    const p = this.pts;
    const t = this.tip;
    return p[o] !== t[0] || p[o + 1] !== t[1] || p[o + 2] !== t[2];
  }

  /** Points drawn: stored points plus the tip when apart. */
  count(): number {
    return this.n + (this.tipApart() ? 1 : 0);
  }

  /** Point `i` (0 = newest, the tip when apart) into `out` (x, y, z, birth time). */
  read(i: number, now: number, out: Float32Array): void {
    let k = i;
    if (this.tipApart()) {
      if (k === 0) {
        out[0] = this.tip[0]!;
        out[1] = this.tip[1]!;
        out[2] = this.tip[2]!;
        out[3] = now;
        return;
      }
      k--;
    }
    const o = ((this.tail + this.n - 1 - k) % this.cap) * PF;
    const p = this.pts;
    out[0] = p[o]!;
    out[1] = p[o + 1]!;
    out[2] = p[o + 2]!;
    out[3] = p[o + 3]!;
  }

  clear(): void {
    this.tail = 0;
    this.n = 0;
    this.hasTip = false;
  }
}

const prev = new Float32Array(4);
const cur = new Float32Array(4);
const next = new Float32Array(4);
const side = new Float32Array(3);
const axis = new Float32Array(3);

/**
 * Build the ribbon of `ring` into `verts` (3D layout, two vertices per point, oldest first)
 * from float `at`; returns the vertices written (0 when fewer than two points). Allocates
 * nothing. `camera` drives `facing: 'camera'`: in world space the face turns toward the eye at
 * each point, in 2D (or without a camera) it lies in the XY plane.
 */
function writeRibbon(
  ring: Ring,
  style: TrailStyle,
  now: number,
  camera: Camera | null,
  verts: Float32Array,
  at: number,
): number {
  const m = ring.count();
  if (m < 2) return 0;
  const facing = style.facing;
  const toEye = facing === 'camera' && style.space === 'world' && camera !== null;
  let eye: Float32Array | null = null;
  if (facing === 'camera') {
    if (toEye) eye = camera.position;
    else if (camera) {
      const v = camera.view;
      axis[0] = v[2]!;
      axis[1] = v[6]!;
      axis[2] = v[10]!;
    } else axis.set(Z);
  } else if (facing === 'up') axis.set(UP);
  else {
    axis[0] = facing[0];
    axis[1] = facing[1];
    axis[2] = facing[2];
  }
  const lifetime = style.lifetime;
  const inv = lifetime > 0 ? 1 / lifetime : 0;
  const tile = style.uvMode === 'tile';
  const tileLen = style.width > 0 ? style.width : 1;
  const color = style.color;
  side[0] = 1;
  side[1] = 0;
  side[2] = 0;
  let dist = 0;
  ring.read(0, now, cur);
  for (let j = 0; j < m; j++) {
    if (j + 1 < m) ring.read(j + 1, now, next);
    let dx: number;
    let dy: number;
    let dz: number;
    if (j === 0) {
      dx = cur[0]! - next[0]!;
      dy = cur[1]! - next[1]!;
      dz = cur[2]! - next[2]!;
    } else if (j + 1 < m) {
      dx = prev[0]! - next[0]!;
      dy = prev[1]! - next[1]!;
      dz = prev[2]! - next[2]!;
    } else {
      dx = prev[0]! - cur[0]!;
      dy = prev[1]! - cur[1]!;
      dz = prev[2]! - cur[2]!;
    }
    if (eye) {
      axis[0] = eye[0]! - cur[0]!;
      axis[1] = eye[1]! - cur[1]!;
      axis[2] = eye[2]! - cur[2]!;
    }
    // side = normalize(dir × axis); a degenerate pair keeps the previous side.
    const sx = dy * axis[2]! - dz * axis[1]!;
    const sy = dz * axis[0]! - dx * axis[2]!;
    const sz = dx * axis[1]! - dy * axis[0]!;
    const sl = Math.hypot(sx, sy, sz);
    if (sl > 1e-12) {
      side[0] = sx / sl;
      side[1] = sy / sl;
      side[2] = sz / sl;
    }
    // normal = side × dir, the face direction (toward the eye / the axis).
    let nx = side[1]! * dz - side[2]! * dy;
    let ny = side[2]! * dx - side[0]! * dz;
    let nz = side[0]! * dy - side[1]! * dx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-12) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      nx = axis[0]!;
      ny = axis[1]!;
      nz = axis[2]!;
    }
    const t = Math.min(Math.max((now - cur[3]!) * inv, 0), 1);
    const hw = (style.widthCurve ? sampleCurve(style.widthCurve, 1, 0, t) : style.width) / 2;
    let a = style.colorCurve ? sampleCurve(style.colorCurve, 4, 3, t) : color[3]!;
    if (style.fade) a *= sampleCurve(style.fade, 1, 0, t);
    const r = style.colorCurve ? sampleCurve(style.colorCurve, 4, 0, t) : color[0]!;
    const g = style.colorCurve ? sampleCurve(style.colorCurve, 4, 1, t) : color[1]!;
    const b = style.colorCurve ? sampleCurve(style.colorCurve, 4, 2, t) : color[2]!;
    if (j > 0) dist += Math.hypot(cur[0]! - prev[0]!, cur[1]! - prev[1]!, cur[2]! - prev[2]!);
    const u = tile ? dist / tileLen : j / (m - 1);
    const px = cur[0]!;
    const py = cur[1]!;
    const pz = cur[2]!;
    const ox = side[0]! * hw;
    const oy = side[1]! * hw;
    const oz = side[2]! * hw;
    // Oldest first in the buffer so the index buffer is static.
    let o = at + (m - 1 - j) * 2 * VF;
    verts[o++] = px + ox;
    verts[o++] = py + oy;
    verts[o++] = pz + oz;
    verts[o++] = nx;
    verts[o++] = ny;
    verts[o++] = nz;
    verts[o++] = u;
    verts[o++] = 0;
    verts[o++] = r;
    verts[o++] = g;
    verts[o++] = b;
    verts[o++] = a;
    verts[o++] = px - ox;
    verts[o++] = py - oy;
    verts[o++] = pz - oz;
    verts[o++] = nx;
    verts[o++] = ny;
    verts[o++] = nz;
    verts[o++] = u;
    verts[o++] = 1;
    verts[o++] = r;
    verts[o++] = g;
    verts[o++] = b;
    verts[o++] = a;
    prev.set(cur);
    cur.set(next);
  }
  return m * 2;
}

/** Untextured trail materials, one per renderer and blend mode (textured ones are per trail). */
const sharedMaterials = new WeakMap<Renderer, Map<string, Material>>();

function trailMaterial(renderer: Renderer, opts: TrailOptions, label: string): Material {
  const blend = opts.blend ?? 'additive';
  if (opts.texture) {
    const m = renderer.createMaterial({
      label: `${label}-textured`,
      wgsl: TRAIL_TEXTURED_WGSL,
      blend,
      textures: 1,
      sampler: opts.uvMode === 'tile' ? 'linear-repeat' : 'linear-clamp',
    });
    m.setTexture(0, opts.texture);
    return m;
  }
  let byBlend = sharedMaterials.get(renderer);
  if (!byBlend) {
    byBlend = new Map();
    sharedMaterials.set(renderer, byBlend);
  }
  let m = byBlend.get(blend);
  if (!m) {
    m = renderer.createMaterial({ label: `trail-${blend}`, wgsl: TRAIL_WGSL, blend });
    byBlend.set(blend, m);
  }
  return m;
}

/** Fields `Trail` and `TrailBatch` share; `TrailStyle` plus the GPU side. */
abstract class RibbonBase implements TrailStyle {
  readonly space: '2d' | 'world';
  /** Seconds a point lives. Mutable. */
  lifetime: number;
  /** Ribbon width (or the tile length under `widthCurve`). Mutable. */
  width: number;
  /** See `TrailOptions.minDistance`. Mutable. */
  minDistance: number;
  /** See `TrailFacing`. Mutable. */
  facing: TrailFacing;
  readonly widthCurve: Float32Array | null;
  /** Linear RGBA; mutate in place. */
  readonly color: Float32Array;
  readonly colorCurve: Float32Array | null;
  readonly fade: Float32Array | null;
  readonly uvMode: 'stretch' | 'tile';
  /** The mesh the ribbon is written into (3D vertex layout; two vertices per point). */
  readonly mesh: Mesh;
  /** The unlit soft-edged material (shared per renderer and blend unless textured). */
  readonly material: Material;
  /**
   * Places the ribbon: identity by default (points are already in trail space). Parent it or
   * move it like any `Transform`.
   */
  readonly transform = new Transform();
  /**
   * Per-draw instance fields (`tint`, `emissive`, `order`, `layers`, ...); `params.x` is the
   * edge softness and is owned by the trail (`softness`).
   */
  readonly instance: InstanceParams;
  protected readonly params = new Float32Array(4);
  protected readonly ownsMaterial: boolean;
  protected time = 0;
  /** Vertices the last `update` wrote. */
  protected written = 0;
  private readonly vertexUpdate: MeshUpdate = { vertexCount: 0, indexCount: 0 };

  protected constructor(
    renderer: Renderer,
    opts: TrailOptions,
    vertices: number,
    indices: Uint16Array | Uint32Array | undefined,
    label: string,
  ) {
    const world = opts.space === 'world';
    this.space = world ? 'world' : '2d';
    this.lifetime = opts.lifetime ?? 0.5;
    this.width = opts.width ?? (world ? 0.2 : 12);
    this.minDistance = opts.minDistance ?? (world ? 0.02 : 2);
    this.facing = opts.facing ?? 'camera';
    this.widthCurve = toTable(opts.widthCurve);
    this.color = new Float32Array(4);
    const c = opts.color;
    this.color[0] = c ? c[0]! : 1;
    this.color[1] = c ? c[1]! : 1;
    this.color[2] = c ? c[2]! : 1;
    this.color[3] = c ? (c[3] ?? 1) : 1;
    this.colorCurve = toTable(opts.colorCurve);
    this.fade = opts.fade === null ? null : (toTable(opts.fade) ?? DEFAULT_FADE);
    this.uvMode = opts.uvMode ?? 'stretch';
    this.params[0] = opts.softness ?? 0.5;
    this.instance = { params: this.params };
    this.ownsMaterial = !!opts.texture;
    this.material = trailMaterial(renderer, opts, label);
    this.mesh = renderer.createMesh({
      label,
      layout: VERTEX_LAYOUT_3D,
      capacity: { vertices, indices: indices ? indices.length : 0 },
      indices,
    });
    this.mesh.update({ vertexCount: 0, indexCount: 0 });
  }

  /** Share of the half width that fades toward each long edge, 0..1. */
  get softness(): number {
    return this.params[0]!;
  }
  set softness(v: number) {
    this.params[0] = v;
  }

  /** Upload `count` vertices of `verts` and set the index range (allocation-free). */
  protected upload(verts: Float32Array, count: number, indexCount: number): void {
    const u = this.vertexUpdate;
    u.vertices = verts;
    u.vertexCount = count;
    u.indexCount = indexCount;
    this.written = count;
    this.mesh.update(u);
  }

  /** Record the ribbon into `frame` (nothing when it has fewer than two points). */
  draw(frame: Frame): void {
    if (this.written < 4) return;
    frame.mesh(this.mesh, this.material, this.transform, this.instance);
  }

  destroy(): void {
    this.mesh.destroy();
    if (this.ownsMaterial) this.material.destroy();
  }
}

/**
 * A ribbon trail: a strip that follows a moving point, with width, colour and alpha over age,
 * camera-facing or fixed-axis, in 2D or world space.
 *
 * ```ts
 * const trail = new Trail(renderer, { space: 'world', width: 0.15, lifetime: 0.4 });
 * trail.push(tip.x, tip.y, tip.z);   // every update, wherever the point is
 * trail.update(dt, camera);          // ages points and rebuilds the ribbon
 * trail.draw(frame);                 // inside the scene's render
 * ```
 *
 * Geometry is built on the CPU into one preallocated array (two vertices per point, the
 * oldest first, over a static index buffer) and uploaded through `Mesh.update` each frame;
 * nothing allocates after construction.
 */
export class Trail extends RibbonBase {
  readonly maxPoints: number;
  private readonly ring: Ring;
  private readonly verts: Float32Array;

  constructor(renderer: Renderer, opts: TrailOptions = {}) {
    const cap = Math.max(2, Math.floor(opts.maxPoints ?? 64));
    const vertices = (cap + 1) * 2;
    super(renderer, opts, vertices, ribbonIndices(cap, vertices), opts.label ?? 'trail');
    this.maxPoints = cap;
    this.ring = new Ring(cap);
    this.verts = new Float32Array(vertices * VF);
  }

  /** Points the ribbon currently has (stored points plus the tip when it sits apart). */
  get count(): number {
    return this.ring.count();
  }

  /**
   * Point `i` (0 = newest) into `out` as `x, y, z`. Out of range leaves `out` untouched and
   * returns false.
   */
  pointAt(i: number, out: { x: number; y: number; z: number }): boolean {
    if (i < 0 || i >= this.ring.count()) return false;
    this.ring.read(i, this.time, cur);
    out.x = cur[0]!;
    out.y = cur[1]!;
    out.z = cur[2]!;
    return true;
  }

  /**
   * Move the trail's tip to a point. A point farther than `minDistance` from the newest stored
   * one is stored (true); a closer one only moves the tip (false). When `maxPoints` are stored
   * the oldest drops.
   */
  push(x: number, y: number, z = 0): boolean {
    return this.ring.push(x, y, z, this.time, this.minDistance);
  }

  /**
   * Advance time, drop points older than `lifetime` and rebuild the ribbon. `camera` turns a
   * `facing: 'camera'` ribbon (needed in world space; in 2D the ribbon lies flat without it).
   */
  update(dt: number, camera?: Camera | null): void {
    this.time += dt;
    const ring = this.ring;
    ring.expire(this.time, this.lifetime);
    const n = writeRibbon(ring, this, this.time, camera ?? null, this.verts, 0);
    this.upload(this.verts, n, n >= 4 ? (n / 2 - 1) * 6 : 0);
  }

  /** Forget every point; the ribbon is empty until the next `push` and `update`. */
  clear(): void {
    this.ring.clear();
    this.upload(this.verts, 0, 0);
  }
}

/**
 * Many ribbons of one style in one mesh and one draw (projectiles, a flock). Each ribbon is
 * addressed by its index; `update` rebuilds the shared vertex and index arrays in place.
 */
export class TrailBatch extends RibbonBase {
  /** Ribbons in the batch. */
  readonly size: number;
  readonly maxPoints: number;
  private readonly rings: Ring[];
  private readonly verts: Float32Array;
  private readonly indices: Uint16Array | Uint32Array;
  private readonly indexUpdate: { indices: Uint16Array | Uint32Array; indexCount: number };

  constructor(renderer: Renderer, size: number, opts: TrailOptions = {}) {
    const cap = Math.max(2, Math.floor(opts.maxPoints ?? 64));
    const count = Math.max(1, Math.floor(size));
    const vertices = (cap + 1) * 2 * count;
    super(renderer, opts, vertices, ribbonIndices(cap * count, vertices), opts.label ?? 'trails');
    this.size = count;
    this.maxPoints = cap;
    this.rings = [];
    for (let i = 0; i < count; i++) this.rings.push(new Ring(cap));
    this.verts = new Float32Array(vertices * VF);
    this.indices =
      vertices > 0xffff ? new Uint32Array(cap * count * 6) : new Uint16Array(cap * count * 6);
    this.indexUpdate = { indices: this.indices, indexCount: 0 };
  }

  /** Points ribbon `i` currently has. */
  count(i: number): number {
    return this.rings[i]?.count() ?? 0;
  }

  /** `Trail.pointAt` for ribbon `i`: point `j` (0 = newest) into `out`. */
  pointAt(i: number, j: number, out: { x: number; y: number; z: number }): boolean {
    const r = this.rings[i];
    if (!r || j < 0 || j >= r.count()) return false;
    r.read(j, this.time, cur);
    out.x = cur[0]!;
    out.y = cur[1]!;
    out.z = cur[2]!;
    return true;
  }

  /** `Trail.push` for ribbon `i`. */
  push(i: number, x: number, y: number, z = 0): boolean {
    const r = this.rings[i];
    return r ? r.push(x, y, z, this.time, this.minDistance) : false;
  }

  /** `Trail.update` for every ribbon, packed into one mesh. */
  update(dt: number, camera?: Camera | null): void {
    this.time += dt;
    const cam = camera ?? null;
    let vb = 0;
    let ib = 0;
    for (const ring of this.rings) {
      ring.expire(this.time, this.lifetime);
      const n = writeRibbon(ring, this, this.time, cam, this.verts, vb * VF);
      if (n < 4) continue;
      ib = writeQuads(this.indices, ib, vb, n / 2 - 1);
      vb += n;
    }
    const u = this.indexUpdate;
    u.indexCount = ib;
    this.mesh.update(u);
    this.upload(this.verts, vb, ib);
  }

  /** Forget ribbon `i`'s points, or every ribbon's without an index. */
  clear(i?: number): void {
    if (i === undefined) for (const r of this.rings) r.clear();
    else this.rings[i]?.clear();
    if (i === undefined) this.upload(this.verts, 0, 0);
  }
}
