/**
 * The skirmish map: a seeded 24×24 field of grass, mud and water with two elevation steps of
 * hills. `?seed=N` fixes it. Every non-water tile is reachable from the player spawn (the
 * generator floods from there and drowns what it cannot reach), so a unit is never boxed in.
 */
import { createRandom } from '@thunderclap/engine/core';
import { MAP } from './iso';

export type Terrain = 0 | 1 | 2;
export const GRASS: Terrain = 0;
export const MUD: Terrain = 1;
export const WATER: Terrain = 2;
export const MAX_ELEVATION = 2;

/** Movement cost of entering a tile of this terrain; water is impassable. */
export const TERRAIN_COST: readonly number[] = [1, 2, Number.POSITIVE_INFINITY];
export const TERRAIN_NAME: readonly string[] = ['grass', 'mud', 'water'];

export interface TacticsMap {
  readonly terrain: Uint8Array;
  readonly elevation: Uint8Array;
  readonly playerSpawns: { x: number; y: number }[];
  readonly enemySpawns: { x: number; y: number }[];
}

export function index(tx: number, ty: number): number {
  return ty * MAP + tx;
}

export function inBounds(tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < MAP && ty < MAP;
}

function blob(
  out: Uint8Array,
  cx: number,
  cy: number,
  r: number,
  value: number,
  when: (i: number) => boolean,
): void {
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = index(x, y);
        if (when(i)) out[i] = value;
      }
    }
  }
}

export function buildMap(seed: number): TacticsMap {
  const random = createRandom(seed);
  const terrain = new Uint8Array(MAP * MAP);
  const elevation = new Uint8Array(MAP * MAP);

  // Hills: four mounds of elevation 1 with a crown of elevation 2.
  for (let k = 0; k < 4; k++) {
    const cx = random.int(4, MAP - 5);
    const cy = random.int(4, MAP - 5);
    const r = random.float(2, 4.2);
    blob(elevation, cx, cy, r, 1, () => true);
    blob(elevation, cx, cy, r - 1.6, 2, () => true);
  }
  // Ponds on the flats, ringed by mud.
  for (let k = 0; k < 3; k++) {
    const cx = random.int(3, MAP - 4);
    const cy = random.int(3, MAP - 4);
    const r = random.float(1.4, 2.7);
    blob(terrain, cx, cy, r + 1.3, MUD, (i) => elevation[i] === 0);
    blob(terrain, cx, cy, r, WATER, (i) => elevation[i] === 0);
  }
  // Mud patches.
  for (let k = 0; k < 4; k++) {
    blob(
      terrain,
      random.int(2, MAP - 3),
      random.int(2, MAP - 3),
      random.float(1, 2.4),
      MUD,
      (i) => terrain[i] !== WATER,
    );
  }

  // Spawn fields: players bottom-left, raiders up and to the right of the middle, both on flat grass.
  const playerSpawns = [
    { x: 2, y: MAP - 3 },
    { x: 3, y: MAP - 4 },
    { x: 2, y: MAP - 5 },
    { x: 4, y: MAP - 3 },
  ];
  const enemySpawns = [
    { x: MAP - 7, y: 6 },
    { x: MAP - 8, y: 7 },
    { x: MAP - 7, y: 8 },
    { x: MAP - 9, y: 6 },
    { x: MAP - 8, y: 9 },
    { x: MAP - 10, y: 7 },
  ];
  for (const s of [...playerSpawns, ...enemySpawns]) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!inBounds(s.x + dx, s.y + dy)) continue;
        const i = index(s.x + dx, s.y + dy);
        terrain[i] = GRASS;
        elevation[i] = 0;
      }
    }
  }

  // Connectivity: flood from the first player spawn over non-water tiles; drown the rest.
  const seen = new Uint8Array(MAP * MAP);
  const queue: number[] = [index(playerSpawns[0]!.x, playerSpawns[0]!.y)];
  seen[queue[0]!] = 1;
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % MAP;
    const y = (i - x) / MAP;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = index(nx, ny);
      if (seen[j] || terrain[j] === WATER) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i] && terrain[i] !== WATER) {
      terrain[i] = WATER;
      elevation[i] = 0;
    }
  }

  return { terrain, elevation, playerSpawns, enemySpawns };
}
