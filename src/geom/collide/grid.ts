/**
 * The 2D tile case: a grid of solid cells in the xz plane becomes boxes, `cellSize` wide and
 * deep, from `y` to `y + wallHeight`. Faces shared by two solid cells are left out, so a wall of
 * tiles is one flat run of quads and a circle sliding along it meets no interior edges (the
 * corridor case). Column `x` runs along +x, row `z` along +z, `solid[z * width + x]`.
 */

export interface GridSource {
  /** Cells along x. */
  width: number;
  /** Cells along z. */
  height: number;
  /** World size of one cell (x and z). */
  cellSize: number;
  /** World x, z of the corner of cell (0, 0). */
  origin: [number, number];
  /** Which cells are solid: a predicate over cell coordinates or a `width × height` array. */
  solid: ((x: number, z: number) => boolean) | Uint8Array;
  /** World y of the cells' bottom face. Default 0. */
  y?: number;
  /** Height of the cells' walls. Default `cellSize`. */
  wallHeight?: number;
}

/** Whether cell (x, z) is solid; out-of-range cells are open. */
export function gridSolid(grid: GridSource, x: number, z: number): boolean {
  if (x < 0 || z < 0 || x >= grid.width || z >= grid.height) return false;
  const s = grid.solid;
  return typeof s === 'function' ? s(x, z) : s[z * grid.width + x] !== 0;
}

/** The grid's exposed faces as triangles, nine floats each, counter-clockwise from outside. */
export function gridTriangles(grid: GridSource): Float32Array {
  const { width, height, cellSize } = grid;
  if (!(width >= 1 && height >= 1)) {
    throw new Error(`collide: a grid needs at least 1×1 cells, got ${width}×${height}`);
  }
  if (!(cellSize > 0)) throw new Error(`collide: grid cellSize must be positive, got ${cellSize}`);
  const y0 = grid.y ?? 0;
  const y1 = y0 + (grid.wallHeight ?? cellSize);
  const ox = grid.origin[0];
  const oz = grid.origin[1];
  // Count faces first so the array is allocated once.
  let faces = 0;
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      if (!gridSolid(grid, x, z)) continue;
      faces += 2; // top and bottom
      if (!gridSolid(grid, x - 1, z)) faces++;
      if (!gridSolid(grid, x + 1, z)) faces++;
      if (!gridSolid(grid, x, z - 1)) faces++;
      if (!gridSolid(grid, x, z + 1)) faces++;
    }
  }
  const out = new Float32Array(faces * 18);
  let o = 0;
  const quad = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
  ) => {
    out[o++] = ax;
    out[o++] = ay;
    out[o++] = az;
    out[o++] = bx;
    out[o++] = by;
    out[o++] = bz;
    out[o++] = cx;
    out[o++] = cy;
    out[o++] = cz;
    out[o++] = ax;
    out[o++] = ay;
    out[o++] = az;
    out[o++] = cx;
    out[o++] = cy;
    out[o++] = cz;
    out[o++] = dx;
    out[o++] = dy;
    out[o++] = dz;
  };
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      if (!gridSolid(grid, x, z)) continue;
      const x0 = ox + x * cellSize;
      const x1 = x0 + cellSize;
      const z0 = oz + z * cellSize;
      const z1 = z0 + cellSize;
      // Top (+y) and bottom (-y).
      quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0);
      quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
      // -x face
      if (!gridSolid(grid, x - 1, z)) quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
      // +x face
      if (!gridSolid(grid, x + 1, z)) quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);
      // -z face
      if (!gridSolid(grid, x, z - 1)) quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
      // +z face
      if (!gridSolid(grid, x, z + 1)) quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
    }
  }
  return out;
}
