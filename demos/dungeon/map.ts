/**
 * The 40×30 tile map: rooms joined by corridors, carved deterministically from a seed so the
 * spec can rely on the spawn room. Pure data and arithmetic, no engine.
 */
import { createRandom } from '@thunderclap/engine/core';
import { TILE } from './atlas';

export const MAP_W = 40;
export const MAP_H = 30;

/** The spawn room's floor (inclusive tile bounds). Its west wall is x = 1. */
export const SPAWN_ROOM = { x0: 2, y0: 2, x1: 11, y1: 9 };
/** Where the player starts, and the coin the spec walks into (three tiles east). */
export const SPAWN_TILE = { x: 3, y: 5 };
export const FIRST_COIN_TILE = { x: 6, y: 5 };

export interface Room {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DungeonMap {
  /** Row-major; true = solid wall. */
  solid: Uint8Array;
  rooms: Room[];
  torches: { x: number; y: number }[];
  coins: { x: number; y: number }[];
  /** Floor tiles outside the spawn room (bat spawns). */
  openTiles: { x: number; y: number }[];
}

export function isSolid(map: DungeonMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  return map.solid[ty * MAP_W + tx] === 1;
}

const ROOMS: Room[] = [
  SPAWN_ROOM,
  { x0: 16, y0: 2, x1: 25, y1: 8 },
  { x0: 29, y0: 3, x1: 37, y1: 10 },
  { x0: 3, y0: 14, x1: 10, y1: 21 },
  { x0: 15, y0: 12, x1: 24, y1: 19 },
  { x0: 28, y0: 14, x1: 37, y1: 20 },
  { x0: 2, y0: 24, x1: 14, y1: 27 },
  { x0: 19, y0: 23, x1: 27, y1: 27 },
  { x0: 31, y0: 23, x1: 37, y1: 27 },
];

/** Corridors as (x, y) → (x, y) L-shapes between room centres. */
const LINKS: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 3],
  [1, 4],
  [2, 5],
  [3, 4],
  [4, 5],
  [3, 6],
  [4, 7],
  [5, 8],
  [6, 7],
  [7, 8],
];

function centre(r: Room): { x: number; y: number } {
  return { x: Math.floor((r.x0 + r.x1) / 2), y: Math.floor((r.y0 + r.y1) / 2) };
}

export function buildMap(seed = 7): DungeonMap {
  const solid = new Uint8Array(MAP_W * MAP_H).fill(1);
  const carve = (x: number, y: number) => {
    if (x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1) solid[y * MAP_W + x] = 0;
  };
  for (const r of ROOMS)
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) carve(x, y);
  for (const [a, b] of LINKS) {
    const p = centre(ROOMS[a]!);
    const q = centre(ROOMS[b]!);
    const sx = Math.sign(q.x - p.x);
    for (let x = p.x; x !== q.x; x += sx) carve(x, p.y);
    const sy = Math.sign(q.y - p.y);
    for (let y = p.y; y !== q.y + sy; y += sy) carve(q.x, y);
  }
  const random = createRandom(seed);
  // Pillars in the larger rooms, never in the spawn room's walking row.
  for (const r of ROOMS.slice(1)) {
    const n = random.int(0, 2);
    for (let i = 0; i < n; i++) {
      const x = random.int(r.x0 + 1, r.x1 - 2);
      const y = random.int(r.y0 + 1, r.y1 - 2);
      const c = centre(r);
      if (x !== c.x && y !== c.y) solid[y * MAP_W + x] = 1;
    }
  }
  const map: DungeonMap = { solid, rooms: ROOMS, torches: [], coins: [], openTiles: [] };

  const inSpawn = (x: number, y: number) =>
    x >= SPAWN_ROOM.x0 && x <= SPAWN_ROOM.x1 && y >= SPAWN_ROOM.y0 && y <= SPAWN_ROOM.y1;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (!isSolid(map, x, y) && !inSpawn(x, y)) map.openTiles.push({ x, y });
    }
  }
  // Torches: wall tiles on a room's north edge, every few tiles.
  for (const r of ROOMS) {
    for (let x = r.x0 + 1; x <= r.x1; x += 4) {
      if (isSolid(map, x, r.y0 - 1) && !isSolid(map, x, r.y0)) map.torches.push({ x, y: r.y0 - 1 });
    }
  }
  // Coins: the spec's coin first, then one or two per other room.
  map.coins.push({ ...FIRST_COIN_TILE });
  for (const r of ROOMS.slice(1)) {
    const n = random.int(1, 2);
    for (let i = 0; i < n; i++) {
      const x = random.int(r.x0, r.x1);
      const y = random.int(r.y0, r.y1);
      if (!isSolid(map, x, y) && !map.coins.some((c) => c.x === x && c.y === y))
        map.coins.push({ x, y });
    }
  }
  return map;
}

/**
 * Moves an axis-aligned box (centre cx, cy, half size `half`) by dx, dy against the solid tiles,
 * one axis at a time, so it stops flush against a wall. Writes the result into `out`.
 */
export function moveBox(
  map: DungeonMap,
  cx: number,
  cy: number,
  half: number,
  dx: number,
  dy: number,
  out: { x: number; y: number },
): void {
  let x = cx + dx;
  const eps = 0.001;
  if (dx !== 0) {
    const edge = dx > 0 ? x + half : x - half;
    const tx = Math.floor(edge / TILE);
    const ty0 = Math.floor((cy - half + eps) / TILE);
    const ty1 = Math.floor((cy + half - eps) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (isSolid(map, tx, ty)) {
        x = dx > 0 ? tx * TILE - half : (tx + 1) * TILE + half;
        break;
      }
    }
  }
  let y = cy + dy;
  if (dy !== 0) {
    const edge = dy > 0 ? y + half : y - half;
    const ty = Math.floor(edge / TILE);
    const tx0 = Math.floor((x - half + eps) / TILE);
    const tx1 = Math.floor((x + half - eps) / TILE);
    for (let tx = tx0; tx <= tx1; tx++) {
      if (isSolid(map, tx, ty)) {
        y = dy > 0 ? ty * TILE - half : (ty + 1) * TILE + half;
        break;
      }
    }
  }
  out.x = x;
  out.y = y;
}
