/**
 * The stones as a static collider (`geom`'s BVH): one triangle set from the blocks in
 * `ground.ts`, baked at build time by `pnpm bake` (`bake.config.json` → `public/baked/stones.coll`
 * from `assets/stones.json`, which `stoneGeometryJson` writes) and loaded at boot; when the baked
 * file is missing (a cold `pnpm dev`) the same triangles are built here at runtime, so the game
 * runs either way. `stoneGeometry` is pure; `loadStoneCollider` is the one `fetch` of this game.
 */
import {
  box,
  createStaticCollider,
  GEOMETRY_FLOATS,
  type Geometry,
  importCollider,
  mergeGeometry,
  type StaticCollider,
  transformGeometry,
} from '@thunderclap-engine/engine/geom';
import type { Ground } from './ground';

/** Every block as one merged `Geometry` (world space; `box` is built in place with a 3×4 translation). */
export function stoneGeometry(g: Ground): Geometry {
  return mergeGeometry(
    ...g.blocks.map((b) => {
      const sx = b.max[0] - b.min[0];
      const sy = b.max[1] - b.min[1];
      const sz = b.max[2] - b.min[2];
      const cx = (b.min[0] + b.max[0]) / 2;
      const cy = (b.min[1] + b.max[1]) / 2;
      const cz = (b.min[2] + b.max[2]) / 2;
      return transformGeometry(
        box({ size: [sx, sy, sz], color: [0.5, 0.49, 0.47, 1] }),
        new Float32Array([1, 0, 0, cx, 0, 1, 0, cy, 0, 0, 1, cz]),
      );
    }),
  );
}

/** The bake script's geometry JSON for `stoneGeometry`: bare xyz positions and triangle indices. */
export function stoneGeometryJson(g: Ground): { positions: number[]; indices: number[] } {
  const geo = stoneGeometry(g);
  const positions: number[] = [];
  for (let v = 0; v < geo.vertices.length; v += GEOMETRY_FLOATS) {
    positions.push(geo.vertices[v]!, geo.vertices[v + 1]!, geo.vertices[v + 2]!);
  }
  return { positions, indices: Array.from(geo.indices) };
}

/** The runtime bake: the collider the baked file would hold. */
export function createStoneCollider(g: Ground): StaticCollider {
  return createStaticCollider([{ geometry: stoneGeometry(g) }]);
}

/**
 * The baked collider from `url` (`/baked/stones.coll`), or the runtime bake when the file is
 * missing or not a collider (Vite's dev server answers a missing path with the page).
 */
export async function loadStoneCollider(g: Ground, url: string): Promise<StaticCollider> {
  try {
    const r = await fetch(url);
    if (r.ok) return importCollider(await r.arrayBuffer());
  } catch {
    // Fall through to the runtime bake.
  }
  return createStoneCollider(g);
}
