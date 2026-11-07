/**
 * Procedural helpers for the ARPG (copied from demos/arena): the skinned box builder the bodies
 * use (`@thunderclap-engine/engine/geom` writes the 3D layout only) and the textures, whose per-texel
 * rolls are core's positional `hash2f`. Setup-time code: it allocates freely and runs once.
 */
import { hash2f } from '@thunderclap-engine/engine/core';
import { setVertexSkin } from '@thunderclap-engine/engine/render';

export interface MeshData {
  vertices: Float32Array;
  indices: Uint16Array;
}

export type Rgb = readonly [number, number, number];

/**
 * Appends boxes to one vertex list: flat normals, per-face uv, a vertex
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
        o.jitter * (hash2f(o.seed, tx, ty) - 0.5) -
        o.jitter * 0.5 * (hash2f(o.seed + 7, x, y) - 0.5);
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

/**
 * sRGB RGBA8 texels of rune bands for the gilded gear's emissive map: black, with rows of
 * hashed glyph strokes that glow once multiplied by `emissiveFactor`.
 */
export function runePixels(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size * size * 4));
  const cell = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const lx = x % cell;
      const ly = y % cell;
      // Every other row of cells is a band; each glyph lights a few of its 3×3 strokes.
      const band = cy % 2 === 0;
      const sx = Math.min(2, Math.floor((lx - 1) / 2));
      const sy = Math.min(2, Math.floor((ly - 1) / 2));
      const stroke =
        band &&
        lx > 0 &&
        ly > 0 &&
        lx < cell - 1 &&
        ly < cell - 1 &&
        (lx % 2 === 1 || ly % 2 === 1);
      const lit = stroke && hash2f(seed, cx * 3 + sx, cy * 3 + sy) > 0.45;
      const o = (y * size + x) * 4;
      const v = lit ? 255 : 0;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** `size × size` opaque white texels (an emissive map that leaves `emissiveFactor` as is). */
export function whitePixels(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size * size * 4)).fill(255);
}
