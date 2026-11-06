/**
 * Procedural geometry for the arena, in the renderer's 3D and skinned vertex layouts. Setup-time
 * code: it allocates freely and runs once. (`@thunderclap/engine/geom` would replace most of it.)
 */
import { setVertexSkin, VERTEX_SKINNED_FLOATS, VERTEX3D_FLOATS } from '@thunderclap/engine/render';

export interface MeshData {
  vertices: Float32Array;
  indices: Uint16Array;
}

export type Rgb = readonly [number, number, number];

/**
 * Appends boxes, cylinders and quads to one vertex list: flat normals, per-face uv, a vertex
 * colour per primitive and, for a skinned mesh, one rigid joint per primitive.
 */
export class MeshBuilder {
  private readonly verts: number[] = [];
  private readonly idx: number[] = [];
  private readonly joints: number[] = [];
  private count = 0;

  constructor(private readonly skinned = false) {}

  private vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    c: Rgb,
    joint: number,
  ): number {
    this.verts.push(x, y, z, nx, ny, nz, u, v, c[0], c[1], c[2], 1);
    if (this.skinned) this.verts.push(0, 0);
    this.joints.push(joint);
    return this.count++;
  }

  /** An axis-aligned box: centre and half extents. `uvScale` repeats the texture per unit. */
  box(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    color: Rgb,
    joint = 0,
    uvScale = 1,
  ): this {
    const faces: [Rgb, Rgb, Rgb][] = [
      [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, -1],
        [-1, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
      ],
      [
        [-1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, -1],
      ],
      [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
    ];
    const h = [hx, hy, hz];
    for (const [n, r, u] of faces) {
      const base = this.count;
      const ru = Math.abs(r[0]) * hx + Math.abs(r[1]) * hy + Math.abs(r[2]) * hz;
      const uu = Math.abs(u[0]) * hx + Math.abs(u[1]) * hy + Math.abs(u[2]) * hz;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const p = [0, 0, 0];
        for (let k = 0; k < 3; k++) p[k] = n[k] * h[k]! + sx * r[k] * h[k]! + sy * u[k] * h[k]!;
        this.vertex(
          cx + p[0]!,
          cy + p[1]!,
          cz + p[2]!,
          n[0],
          n[1],
          n[2],
          ((sx + 1) / 2) * ru * 2 * uvScale,
          ((1 - sy) / 2) * uu * 2 * uvScale,
          color,
          joint,
        );
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  /** A cylinder along +y from `y0` to `y0 + height`, smooth sides, flat caps. */
  cylinder(
    cx: number,
    y0: number,
    cz: number,
    radius: number,
    height: number,
    segments: number,
    color: Rgb,
    joint = 0,
  ): this {
    const ring0 = this.count;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      const u = s / segments;
      this.vertex(cx + nx * radius, y0, cz + nz * radius, nx, 0, nz, u * 4, 0, color, joint);
      this.vertex(
        cx + nx * radius,
        y0 + height,
        cz + nz * radius,
        nx,
        0,
        nz,
        u * 4,
        height,
        color,
        joint,
      );
    }
    for (let s = 0; s < segments; s++) {
      const a = ring0 + s * 2;
      this.idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
    for (const [y, ny] of [
      [y0 + height, 1],
      [y0, -1],
    ] as const) {
      const centre = this.vertex(cx, y, cz, 0, ny, 0, 0.5, 0.5, color, joint);
      const first = this.count;
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const nx = Math.cos(a);
        const nz = Math.sin(a);
        this.vertex(
          cx + nx * radius,
          y,
          cz + nz * radius,
          0,
          ny,
          0,
          0.5 + nx / 2,
          0.5 + nz / 2,
          color,
          joint,
        );
      }
      for (let s = 0; s < segments; s++) {
        const b = first + s;
        const c = first + ((s + 1) % segments);
        if (ny > 0) this.idx.push(centre, c, b);
        else this.idx.push(centre, b, c);
      }
    }
    return this;
  }

  /** A quad in the XZ plane at y = 0 facing +y, `size` wide, the texture repeated `repeat` times. */
  ground(size: number, repeat: number, color: Rgb): this {
    const h = size / 2;
    const base = this.count;
    this.vertex(-h, 0, h, 0, 1, 0, 0, repeat, color, 0);
    this.vertex(h, 0, h, 0, 1, 0, repeat, repeat, color, 0);
    this.vertex(h, 0, -h, 0, 1, 0, repeat, 0, color, 0);
    this.vertex(-h, 0, -h, 0, 1, 0, 0, 0, color, 0);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  get vertexCount(): number {
    return this.count;
  }

  build(): MeshData {
    const vertices = new Float32Array(this.verts);
    if (this.skinned) {
      const bytes = new Uint8Array(vertices.buffer);
      for (let v = 0; v < this.count; v++) setVertexSkin(bytes, v, [this.joints[v]!], [1]);
    }
    return { vertices, indices: new Uint16Array(this.idx) };
  }
}

/** Floats per vertex of the layout a builder writes (a sanity check for the two layouts). */
export const BUILDER_FLOATS = { plain: VERTEX3D_FLOATS, skinned: VERTEX_SKINNED_FLOATS } as const;

/** Deterministic hash noise in [0, 1). */
export function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface TilePixelsOptions {
  size: number;
  /** Tiles across the texture. */
  tiles: number;
  /** Grout width, texels. */
  grout: number;
  base: Rgb;
  groutColor: Rgb;
  /** Per-tile and per-texel brightness jitter, 0..1. */
  jitter: number;
  seed: number;
}

/** sRGB RGBA8 texels of a tiled stone pattern: dark grout, each tile its own shade, grain. */
export function tilePixels(o: TilePixelsOptions): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(o.size * o.size * 4));
  const tile = o.size / o.tiles;
  for (let y = 0; y < o.size; y++) {
    for (let x = 0; x < o.size; x++) {
      const tx = Math.floor(x / tile);
      const ty = Math.floor(y / tile);
      const inGrout = x % tile < o.grout || y % tile < o.grout;
      const shade =
        1 -
        o.jitter * (hash(tx, ty, o.seed) - 0.5) -
        o.jitter * 0.5 * (hash(x, y, o.seed + 7) - 0.5);
      const c = inGrout ? o.groutColor : o.base;
      const i = (y * o.size + x) * 4;
      out[i] = Math.max(0, Math.min(255, Math.round(c[0] * 255 * shade)));
      out[i + 1] = Math.max(0, Math.min(255, Math.round(c[1] * 255 * shade)));
      out[i + 2] = Math.max(0, Math.min(255, Math.round(c[2] * 255 * shade)));
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Linear RGBA8 texels of a scorch mark for the hit decals: a dark disc, soft edge, hashed grain. */
export function scorchPixels(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
      const a = Math.max(0, 1 - r * r) * (0.6 + 0.4 * hash(x, y, seed));
      const o = (y * size + x) * 4;
      out[o] = 28;
      out[o + 1] = 22;
      out[o + 2] = 18;
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}
