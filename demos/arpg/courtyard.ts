/**
 * The ruined courtyard: a 60 × 60 m floor of stone tiles inside broken perimeter walls, two
 * colonnades with fallen pillars, a raised dais reached by a flight of stairs under an arch,
 * rubble and six braziers. Every prop kind is one `InstanceList` built from `geom` meshes;
 * walls, pillars and drums are lists on a `MeshLod` chain (ws/render-6: each instance picks its
 * level, one draw per non-empty level). The same placements feed the navmesh bake as triangle
 * soup. Setup-time code: allocates freely. The layout is fixed
 * (its `hash2f` seed is not `?seed`).
 */

import { hash2f } from '@thunderclap/engine/core';
import {
  arch,
  box,
  cylinder,
  type Geometry,
  icosphere,
  mergeGeometry,
  stairs,
  transformGeometry,
} from '@thunderclap/engine/geom';
import type { NavBakeSource } from '@thunderclap/engine/nav';
import {
  type InstanceList,
  type InstanceParams,
  type Material,
  type MeshLod,
  type Renderer,
  Transform,
} from '@thunderclap/engine/render';

/** `hash2f` under the courtyard's fixed seed plus `k` (the old `hash(x, y, SEED + k)` call sites). */
const roll = (x: number, y: number, k = 0) => hash2f(SEED + k, x, y);

export const HALF = 30;
const TILE = 2;
/** The floor tiling's offset on x and z: a quarter tile, so no seam runs along an axis. */
const TILE_SHIFT = TILE / 4;
const WALL_LEN = 4;
const WALL_H = 3.6;
const WALL_T = 1;
export const DAIS = { x: 0, z: -21.5, w: 14, d: 9, h: 1.2 } as const;
const STEPS = 6;
const STEP_RUN = 0.45;
const SEED = 17;

/** A brazier: where its bowl's flame sits, world units. */
export interface Brazier {
  x: number;
  y: number;
  z: number;
}

/** On-screen sphere heights (target px) at which a pillar keeps 16, then 8 sides; below, 5. */
export const PILLAR_LOD_PX = [300, 170] as const;
/** On-screen sphere height (target px) at which a wall keeps its coping and chunks. */
export const WALL_LOD_PX = [200] as const;
const PILLAR_SIDES = [16, 8, 5] as const;

export interface Courtyard {
  /** Static prop lists, drawn with `frame.list` in this order. */
  lists: InstanceList[];
  /**
   * Walls, broken walls, pillars, broken pillars and drums: one `InstanceList` per kind on a
   * `MeshLod` chain (each instance picks its level; one draw per non-empty level), drawn with
   * `frame.list` after `lists`.
   */
  lods: InstanceList[];
  /** The flame cores (one per brazier; the demo rescales them as they flicker). */
  flames: InstanceList;
  braziers: Brazier[];
  /** Walkable and blocking triangles for `bakeNavMesh`. */
  nav: NavBakeSource;
}

export interface CourtyardMaterials {
  floor: Material;
  wall: Material;
  pillar: Material;
  dark: Material;
  metal: Material;
  flame: Material;
}

/** Placement: position, yaw about +y, uniform scale or per axis, optional tilt about x. */
interface Put {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  s?: number;
  sy?: number;
  tilt?: number;
  tint?: readonly [number, number, number];
}

const tmp = new Transform({});
function matrixOf(p: Put): Float32Array {
  const s = p.s ?? 1;
  tmp.setPosition(p.x, p.y, p.z);
  tmp.setScale(s, p.sy ?? s, s);
  const yaw = p.yaw ?? 0;
  const tilt = p.tilt ?? 0;
  if (tilt !== 0) {
    // yaw then tilt: q = qYaw * qTilt about the local x.
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const ct = Math.cos(tilt / 2);
    const st = Math.sin(tilt / 2);
    tmp.setQuaternion(cy * st, sy * ct, -sy * st, cy * ct);
  } else tmp.setAxisAngle(0, 1, 0, yaw);
  return new Float32Array(tmp.world);
}

export function buildCourtyard(renderer: Renderer, mats: CourtyardMaterials): Courtyard {
  const navPos: number[] = [];
  const navIdx: number[] = [];
  /** Append `g` through `m` (3×4 row-major) to the nav soup. */
  const addNav = (g: Geometry, m: ArrayLike<number>) => {
    const base = navPos.length / 3;
    const f = g.layout.floats;
    const v = g.vertices;
    for (let i = 0; i < v.length; i += f) {
      const x = v[i]!;
      const y = v[i + 1]!;
      const z = v[i + 2]!;
      navPos.push(
        m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
        m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
        m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
      );
    }
    for (let i = 0; i < g.indices.length; i++) navIdx.push(base + g.indices[i]!);
  };

  const lists: InstanceList[] = [];
  /** One list of `g` under `mat` at `puts`; `nav` adds them (or `navGeom` in their place) to the soup. */
  const list = (
    label: string,
    g: Geometry,
    mat: Material,
    puts: Put[],
    opts: { nav?: boolean; navGeom?: Geometry; castShadow?: boolean; emissive?: number } = {},
  ): InstanceList => {
    const mesh = renderer.createMesh({ ...g, label });
    const l = renderer.createInstanceList(mesh, mat, Math.max(1, puts.length));
    if (opts.castShadow === false) l.castShadow = false;
    for (let i = 0; i < puts.length; i++) {
      const p = puts[i]!;
      const m = matrixOf(p);
      const params: InstanceParams = {
        tint: p.tint ? [p.tint[0], p.tint[1], p.tint[2], 1] : undefined,
        castShadow: opts.castShadow !== false,
        receiveShadow: true,
        emissive: opts.emissive,
      };
      l.set(i, m, params);
      if (opts.nav) addNav(opts.navGeom ?? g, m);
    }
    lists.push(l);
    return l;
  };

  const lods: InstanceList[] = [];
  /** A prop kind on a LOD chain (`levels[0]` the full mesh) at `puts`, as one LOD `InstanceList`; `navGeom` (or level 0) feeds the bake. */
  const lodProp = (
    label: string,
    levels: Geometry[],
    thresholdsPx: readonly number[],
    mat: Material,
    puts: Put[],
    navGeom?: Geometry,
  ) => {
    const meshes = levels.map((g, i) => renderer.createMesh({ ...g, label: `${label}-lod${i}` }));
    const lod: MeshLod = { meshes, thresholdsPx: [...thresholdsPx] };
    const l = renderer.createInstanceList(lod, mat, Math.max(1, puts.length));
    const params: InstanceParams = { castShadow: true, receiveShadow: true };
    for (let i = 0; i < puts.length; i++) {
      const m = matrixOf(puts[i]!);
      l.set(i, m, params);
      addNav(navGeom ?? levels[0]!, m);
    }
    lods.push(l);
  };

  // ── Floor: 29 × 29 tiles, each its own shade; a few cracked dark ones ───
  // The stone texture is 2 × 2 slabs per tile, so a grout line runs through each tile's middle
  // as well as the gap at its edge: every metre of the floor carries a seam. The tiling is
  // offset a quarter tile (TILE_SHIFT) on both axes, so the courtyard's axes (the hero's spawn
  // at x = 0) fall half a metre from the nearest gap and the nearest grout line. The last
  // row and column slide under the far walls; a strip of half-width tiles fills the near side.
  const tiles: Put[] = [];
  const n = (HALF * 2) / TILE - 1;
  const at = (i: number) => -HALF + TILE + TILE_SHIFT + i * TILE;
  const tint = (i: number, j: number, k: number): readonly [number, number, number] => {
    const shade = 0.78 + 0.26 * roll(i, j, k + 1);
    const dark = roll(i, j, k) < 0.1 ? 0.55 : 1;
    return [shade * dark * 1.02, shade * dark * 0.96, shade * dark * 1.04];
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h = roll(i, j);
      tiles.push({
        x: at(i),
        y: -0.15,
        z: at(j),
        tint: tint(i, j, 0),
        yaw: (Math.floor(h * 4) * Math.PI) / 2,
      });
    }
  }
  list('floor-tile', box({ size: [TILE - 0.06, 0.3, TILE - 0.06] }), mats.floor, tiles, {
    castShadow: false,
  });
  // The near strip: half-width tiles (half the texture across) centred a tile and a half
  // before the first, along x and, turned a quarter, along z; each runs from under the wall to
  // the usual gap. Their 0.5 × 0.5 m corner inside the walls shows the grout bed.
  const edge: Put[] = [];
  const near = at(0) - TILE * 0.75;
  for (let i = 0; i < n; i++) {
    edge.push({ x: near, y: -0.15, z: at(i), tint: tint(-1, i, 6) });
    edge.push({ x: at(i), y: -0.15, z: near, yaw: Math.PI / 2, tint: tint(i, -1, 6) });
  }
  list(
    'floor-edge',
    box({ size: [TILE / 2 - 0.06, 0.3, TILE - 0.06], uvScale: [0.5, 1] }),
    mats.floor,
    edge,
    { castShadow: false },
  );
  // The grout bed under the tiles (the gaps show it, not the clear colour).
  list(
    'grout-bed',
    box({ size: [HALF * 2, 0.1, HALF * 2] }),
    mats.dark,
    [{ x: 0, y: -0.2, z: 0 }],
    {
      castShadow: false,
    },
  );
  // The walkable floor for the bake: one slab (the tile gaps are visual only).
  addNav(box({ size: [HALF * 2, 0.3, HALF * 2] }), matrixOf({ x: 0, y: -0.15, z: 0 }));

  // ── Perimeter walls: full, broken (short, jagged) or fallen into rubble ──
  const full: Put[] = [];
  const broken: Put[] = [];
  const rubble: Put[] = [];
  const segs = (HALF * 2) / WALL_LEN;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < segs; i++) {
      const along = -HALF + WALL_LEN / 2 + i * WALL_LEN;
      const off = HALF - WALL_T / 2;
      const x = side === 0 ? along : side === 1 ? along : side === 2 ? -off : off;
      const z = side === 0 ? -off : side === 1 ? off : along;
      const yaw = side < 2 ? 0 : Math.PI / 2;
      const h = roll(side, i, 2);
      if (h < 0.42) {
        broken.push({ x, y: 0, z, yaw, sy: 0.7 + 0.6 * roll(side, i, 3) });
        for (let r = 0; r < 3; r++) {
          const a = roll(side * 31 + i, r, 4);
          const inward = 1.2 + 1.6 * roll(side * 31 + i, r, 5);
          rubble.push({
            x: x + (side < 2 ? (a - 0.5) * 3 : side === 2 ? inward : -inward),
            y: 0.08,
            z: z + (side < 2 ? (side === 0 ? inward : -inward) : (a - 0.5) * 3),
            yaw: a * 6,
            s: 0.6 + a * 0.9,
            tilt: a * 2,
          });
        }
      } else full.push({ x, y: WALL_H / 2, z, yaw });
    }
  }
  // Near: the slab under a coping course; far: the slab alone.
  const wallSlab = box({ size: [WALL_LEN - 0.04, WALL_H, WALL_T], uvScale: [2, 2] });
  const wallNear = mergeGeometry(
    wallSlab,
    transformGeometry(
      box({ size: [WALL_LEN - 0.04, 0.22, WALL_T + 0.16] }),
      matrixOf({ x: 0, y: WALL_H / 2 + 0.11, z: 0 }),
    ),
  );
  lodProp('wall', [wallNear, wallSlab], WALL_LOD_PX, mats.wall, full, wallSlab);
  const brokenBase = transformGeometry(
    box({ size: [WALL_LEN - 0.04, 1.4, WALL_T] }),
    matrixOf({ x: 0, y: 0.7, z: 0 }),
  );
  const brokenChunk = transformGeometry(
    box({ size: [1.4, 0.9, WALL_T * 0.9] }),
    matrixOf({ x: -1.1, y: 1.8, z: 0 }),
  );
  const brokenWall = mergeGeometry(
    brokenBase,
    brokenChunk,
    transformGeometry(
      box({ size: [0.9, 0.5, WALL_T * 0.8] }),
      matrixOf({ x: 0.6, y: 1.55, z: 0.05, tilt: 0.2 }),
    ),
  );
  lodProp(
    'wall-broken',
    [brokenWall, mergeGeometry(brokenBase, brokenChunk)],
    WALL_LOD_PX,
    mats.wall,
    broken,
  );

  // ── Colonnades: pillars down both sides, some snapped with drums fallen beside them ──
  // Each level is the same geom builders at fewer sides (PILLAR_SIDES).
  const pillarGeom = (sides: number) =>
    mergeGeometry(
      transformGeometry(box({ size: [1.3, 0.5, 1.3] }), matrixOf({ x: 0, y: 0.25, z: 0 })),
      transformGeometry(
        cylinder({ radius: 0.45, height: 4.2, segments: [sides, 1], uvScale: [3, 3] }),
        matrixOf({ x: 0, y: 2.6, z: 0 }),
      ),
      transformGeometry(box({ size: [1.2, 0.45, 1.2] }), matrixOf({ x: 0, y: 4.9, z: 0 })),
    );
  const brokenGeom = (sides: number) =>
    mergeGeometry(
      transformGeometry(box({ size: [1.3, 0.5, 1.3] }), matrixOf({ x: 0, y: 0.25, z: 0 })),
      transformGeometry(
        cylinder({ radius: [0.42, 0.45], height: 1.7, segments: [sides, 1], uvScale: [3, 1] }),
        matrixOf({ x: 0, y: 1.35, z: 0 }),
      ),
      transformGeometry(
        cylinder({ radius: 0.42, height: 0.5, segments: [sides, 1] }),
        matrixOf({ x: 0.08, y: 2.3, z: 0, tilt: 0.35 }),
      ),
    );
  const drumGeom = (sides: number) => cylinder({ radius: 0.42, height: 1.1, segments: [sides, 1] });
  const pillars: Put[] = [];
  const snapped: Put[] = [];
  const drums: Put[] = [];
  for (const side of [-1, 1]) {
    for (const z of [-8, 0, 8, 16]) {
      const h = roll(side + 3, z + 20, 6);
      if (h < 0.3) {
        snapped.push({ x: side * 9, y: 0, z, yaw: h * 9 });
        drums.push({
          x: side * 9 + side * 1.6,
          y: 0.42,
          z: z + 1.2,
          yaw: 1.2 + h,
          tilt: Math.PI / 2,
        });
      } else pillars.push({ x: side * 9, y: 0, z, yaw: h * 3 });
    }
    snapped.push({ x: side * 19, y: 0, z: -6, yaw: side });
    snapped.push({ x: side * 18, y: 0, z: 14, yaw: side * 2 });
    drums.push({ x: side * 20.5, y: 0.42, z: -4.5, yaw: 0.4 * side, tilt: Math.PI / 2 });
  }
  const pillarNav = box({ size: [1.3, 2.5, 1.3] });
  const chain = (g: (sides: number) => Geometry) => PILLAR_SIDES.map(g);
  lodProp('pillar', chain(pillarGeom), PILLAR_LOD_PX, mats.pillar, pillars, pillarNav);
  lodProp('pillar-broken', chain(brokenGeom), PILLAR_LOD_PX, mats.pillar, snapped, pillarNav);
  lodProp('pillar-drum', chain(drumGeom), PILLAR_LOD_PX, mats.pillar, drums);

  // ── The dais, its stairs and the arch behind ────────────────────────────
  const daisGeom = mergeGeometry(
    transformGeometry(
      box({ size: [DAIS.w, DAIS.h, DAIS.d], uvScale: [3, 3] }),
      matrixOf({ x: 0, y: DAIS.h / 2, z: 0 }),
    ),
    transformGeometry(
      box({ size: [DAIS.w + 0.3, 0.12, DAIS.d + 0.3] }),
      matrixOf({ x: 0, y: DAIS.h - 0.06, z: 0 }),
    ),
  );
  list('dais', daisGeom, mats.wall, [{ x: DAIS.x, y: 0, z: DAIS.z }], { nav: true });
  const stairsGeom = stairs({ steps: STEPS, width: 5, rise: DAIS.h / STEPS, run: STEP_RUN });
  const stairsZ = DAIS.z + DAIS.d / 2 + (STEPS * STEP_RUN) / 2;
  list('stairs', stairsGeom, mats.wall, [{ x: 0, y: DAIS.h / 2, z: stairsZ, yaw: Math.PI }], {
    nav: true,
  });
  list(
    'arch',
    arch({ width: 7, height: 6.5, depth: 1, thickness: 1.1, segments: 14 }),
    mats.pillar,
    [{ x: 0, y: DAIS.h + 3.25, z: DAIS.z - DAIS.d / 2 + 1 }],
    { nav: true },
  );

  // ── Rubble: rocks under the broken walls and around the snapped pillars ─
  for (let i = 0; i < 24; i++) {
    const p = snapped[i % snapped.length]!;
    const a = roll(i, 3, 7) * Math.PI * 2;
    const r = 1.1 + 1.4 * roll(i, 4, 7);
    rubble.push({
      x: p.x + Math.cos(a) * r,
      y: 0.06,
      z: p.z + Math.sin(a) * r,
      yaw: a,
      s: 0.4 + 0.6 * roll(i, 5, 7),
      tilt: a,
    });
  }
  list('rubble', icosphere({ radius: 0.32, subdivisions: 0 }), mats.dark, rubble);

  // ── Braziers: an iron stand and bowl, an emissive flame core above ──────
  const braziers: Brazier[] = [
    { x: -5, y: DAIS.h, z: DAIS.z + 1 },
    { x: 5, y: DAIS.h, z: DAIS.z + 1 },
    { x: -6, y: 0, z: -4 },
    { x: 6, y: 0, z: -4 },
    { x: -6, y: 0, z: 12 },
    { x: 6, y: 0, z: 12 },
  ];
  const standGeom = mergeGeometry(
    transformGeometry(
      cylinder({ radius: [0.12, 0.3], height: 1.0, segments: [10, 1] }),
      matrixOf({ x: 0, y: 0.5, z: 0 }),
    ),
    transformGeometry(
      cylinder({ radius: [0.55, 0.25], height: 0.32, segments: [14, 1] }),
      matrixOf({ x: 0, y: 1.14, z: 0 }),
    ),
    transformGeometry(box({ size: [0.7, 0.06, 0.7] }), matrixOf({ x: 0, y: 0.03, z: 0 })),
  );
  list(
    'brazier',
    standGeom,
    mats.metal,
    braziers.map((b) => ({ x: b.x, y: b.y, z: b.z })),
    { nav: true, navGeom: box({ size: [1, 1.3, 1] }) },
  );
  for (const b of braziers) b.y += 1.42;
  const flameMesh = renderer.createMesh({
    ...icosphere({ radius: 0.24, subdivisions: 1 }),
    label: 'flame-core',
  });
  const flames = renderer.createInstanceList(flameMesh, mats.flame, braziers.length);
  flames.castShadow = false;
  for (let i = 0; i < braziers.length; i++) {
    const b = braziers[i]!;
    flames.set(i, matrixOf({ x: b.x, y: b.y, z: b.z }), { castShadow: false });
  }

  return {
    lists,
    lods,
    flames,
    braziers,
    nav: { positions: new Float32Array(navPos), indices: new Uint32Array(navIdx), stride: 3 },
  };
}
