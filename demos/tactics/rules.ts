/**
 * The skirmish's rules: units, the movement cost of a step (terrain of the tile entered plus
 * one per elevation level climbed or dropped), the move-range flood with its parent pointers
 * (so the preview path and the move itself are the same path) and attack reach. Pure data and
 * functions over preallocated arrays; nothing here touches the engine.
 */
import { MAP } from './iso';
import { inBounds, index, type TacticsMap, TERRAIN_COST } from './map';

export type Side = 'player' | 'enemy';

export interface Unit {
  readonly id: number;
  readonly side: Side;
  readonly name: string;
  tx: number;
  ty: number;
  /** World position of the feet (tweened while moving). */
  x: number;
  y: number;
  hp: number;
  readonly hpMax: number;
  readonly move: number;
  readonly range: number;
  readonly damage: number;
  /** 0 = +x (down-right), 1 = +y (down-left), 2 = -x (up-left), 3 = -y (up-right). */
  facing: number;
  moved: boolean;
  acted: boolean;
  alive: boolean;
}

export interface UnitKind {
  name: string;
  hp: number;
  move: number;
  range: number;
  damage: number;
}

export const PLAYER_KINDS: readonly UnitKind[] = [
  { name: 'Knight', hp: 14, move: 3, range: 1, damage: 5 },
  { name: 'Scout', hp: 9, move: 5, range: 1, damage: 3 },
  { name: 'Archer', hp: 8, move: 3, range: 3, damage: 3 },
  { name: 'Guard', hp: 12, move: 4, range: 1, damage: 4 },
];

export const ENEMY_KIND: UnitKind = { name: 'Raider', hp: 7, move: 4, range: 1, damage: 3 };

export function makeUnit(id: number, side: Side, kind: UnitKind, tx: number, ty: number): Unit {
  return {
    id,
    side,
    name: kind.name,
    tx,
    ty,
    x: 0,
    y: 0,
    hp: kind.hp,
    hpMax: kind.hp,
    move: kind.move,
    range: kind.range,
    damage: kind.damage,
    facing: side === 'player' ? 3 : 1,
    moved: false,
    acted: false,
    alive: true,
  };
}

/** Facing for a step from (fx, fy) to (tx, ty). */
export function facingOf(fx: number, fy: number, tx: number, ty: number): number {
  if (tx > fx) return 0;
  if (ty > fy) return 1;
  if (tx < fx) return 2;
  return 3;
}

/** Cost of stepping from tile `from` onto tile `to`; Infinity when impassable. */
export function stepCost(map: TacticsMap, fromIndex: number, toIndex: number): number {
  const terrain = TERRAIN_COST[map.terrain[toIndex]!]!;
  if (!Number.isFinite(terrain)) return Number.POSITIVE_INFINITY;
  const climb = Math.abs(map.elevation[toIndex]! - map.elevation[fromIndex]!);
  return terrain + climb;
}

const NX = [1, -1, 0, 0];
const NY = [0, 0, 1, -1];

/** The move flood's result: cost-weighted distance and parent per tile, reusable. */
export interface MoveRange {
  readonly dist: Float32Array;
  readonly parent: Int16Array;
  /** The flood's origin, or -1. */
  origin: number;
  budget: number;
}

export function createMoveRange(): MoveRange {
  return {
    dist: new Float32Array(MAP * MAP).fill(Number.POSITIVE_INFINITY),
    parent: new Int16Array(MAP * MAP).fill(-1),
    origin: -1,
    budget: 0,
  };
}

/**
 * Dijkstra over the four neighbours from `unit`'s tile, bounded by `budget`. Tiles holding
 * another living unit cannot be entered. `occupied` is the unit at each tile (-1 none).
 */
export function floodMoves(
  map: TacticsMap,
  occupied: Int16Array,
  unit: Unit,
  budget: number,
  out: MoveRange,
): MoveRange {
  const { dist, parent } = out;
  dist.fill(Number.POSITIVE_INFINITY);
  parent.fill(-1);
  const start = index(unit.tx, unit.ty);
  out.origin = start;
  out.budget = budget;
  dist[start] = 0;
  // A plain array queue is fine at 576 cells; we scan for the cheapest frontier cell.
  const open: number[] = [start];
  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (dist[open[i]!]! < dist[open[best]!]!) best = i;
    const cur = open[best]!;
    open[best] = open[open.length - 1]!;
    open.pop();
    const cx = cur % MAP;
    const cy = (cur - cx) / MAP;
    for (let k = 0; k < 4; k++) {
      const nx = cx + NX[k]!;
      const ny = cy + NY[k]!;
      if (!inBounds(nx, ny)) continue;
      const ni = index(nx, ny);
      const occ = occupied[ni]!;
      if (occ >= 0 && occ !== unit.id) continue;
      const nd = dist[cur]! + stepCost(map, cur, ni);
      if (nd > budget || nd >= dist[ni]!) continue;
      dist[ni] = nd;
      parent[ni] = cur;
      if (!open.includes(ni)) open.push(ni);
    }
  }
  return out;
}

/** Whether `range` lets the unit end its move on `tileIndex` (reachable and not its own tile). */
export function canReach(range: MoveRange, tileIndex: number): boolean {
  return tileIndex !== range.origin && range.dist[tileIndex]! <= range.budget;
}

/**
 * Writes the tile indices from the origin (exclusive) to `tileIndex` (inclusive) into `out`
 * and returns the step count (0 when unreachable).
 */
export function pathTo(range: MoveRange, tileIndex: number, out: Int16Array): number {
  if (!canReach(range, tileIndex)) return 0;
  let n = 0;
  for (let i = tileIndex; i !== range.origin && i >= 0; i = range.parent[i]!) n++;
  let i = tileIndex;
  for (let k = n - 1; k >= 0; k--) {
    out[k] = i;
    i = range.parent[i]!;
  }
  return n;
}

/** Manhattan distance between two tiles. */
export function tileDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function inAttackRange(from: Unit, tx: number, ty: number): boolean {
  const d = tileDistance(from.tx, from.ty, tx, ty);
  return d >= 1 && d <= from.range;
}
