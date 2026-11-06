import { describe, expect, it } from 'vitest';
import type { GridSource } from './grid';
import {
  carryBy,
  createTileSlideResult,
  slideTiles,
  TILE_EMPTY,
  TILE_ONE_WAY,
  TILE_SOLID,
  type TileBox,
  type TileMover,
  type TileQuery,
} from './tile-slide';

/** A map from rows of text: `#` solid, `-` one-way, anything else empty. Out of range is empty. */
function map(rows: string[], cellSize = 1): TileQuery {
  return {
    cellSize,
    solidAt: (cx, cy) => {
      const ch = rows[cy]?.[cx];
      return ch === '#' ? TILE_SOLID : ch === '-' ? TILE_ONE_WAY : TILE_EMPTY;
    },
  };
}

/** Run `ticks` steps of a box with velocity, gravity added each step, copying the result back. */
function run(
  tiles: TileQuery | GridSource,
  box: TileBox,
  vx: number,
  vy: number,
  ticks: number,
  gravity = 0,
  opts = {},
) {
  const out = createTileSlideResult();
  for (let i = 0; i < ticks; i++) {
    vy += gravity;
    slideTiles(tiles, box, vx, vy, out, opts);
    box.x = out.x;
    box.y = out.y;
    if (out.onGround && vy > 0) vy = 0;
    if (out.hitCeiling && vy < 0) vy = 0;
  }
  return out;
}

describe('slideTiles', () => {
  it('lands on a solid floor and stays grounded at rest', () => {
    const tiles = map(['....', '....', '....', '####']);
    const box = { x: 1, y: 0, w: 0.8, h: 0.8 };
    const out = run(tiles, box, 0, 0, 30, 0.05);
    expect(out.onGround).toBe(true);
    expect(box.y).toBeCloseTo(3 - 0.8, 9);
    const rest = slideTiles(tiles, box, 0, 0, createTileSlideResult());
    expect(rest.onGround).toBe(true);
    expect(rest.dx).toBe(0);
    expect(rest.dy).toBe(0);
  });

  it('a one-way platform passes from below and holds from above', () => {
    const tiles = map(['....', '....', '----', '....', '....', '####']);
    // Jumping up from the floor: through the one-way row without a ceiling hit.
    const up = { x: 1, y: 4.2, w: 0.8, h: 0.8 };
    const rising = run(tiles, up, 0, -0.4, 8);
    expect(rising.hitCeiling).toBe(false);
    expect(up.y).toBeLessThan(2);
    // Falling back down onto it: it holds.
    const out = run(tiles, up, 0, 0, 40, 0.05);
    expect(out.onGround).toBe(true);
    expect(up.y).toBeCloseTo(2 - 0.8, 9);
    // Walking sideways through it: no wall.
    const side = { x: -1, y: 1.8, w: 0.8, h: 0.8 };
    expect(slideTiles(tiles, side, 2, 0, createTileSlideResult()).hitWall).toBe(false);
    // oneWay: false drops through to the floor.
    const drop = { ...up };
    run(tiles, drop, 0, 0, 60, 0.05, { oneWay: false });
    expect(drop.y).toBeCloseTo(5 - 0.8, 9);
  });

  it('corners do not snag at tile seams', () => {
    // A floor and a wall each made of single tiles.
    const tiles = map(['#.......', '#.......', '#.......', '#.......', '########']);
    // Sliding right along the floor (with gravity pressing down): never a wall.
    const box = { x: 1.5, y: 4 - 0.8, w: 0.8, h: 0.8 };
    const out = createTileSlideResult();
    for (let i = 0; i < 50; i++) {
      slideTiles(tiles, box, 0.1, 0.05, out);
      expect(out.hitWall).toBe(false);
      expect(out.onGround).toBe(true);
      expect(out.y).toBeCloseTo(4 - 0.8, 9);
      box.x = out.x;
      box.y = out.y;
    }
    expect(box.x).toBeCloseTo(6.5, 6);
    // Sliding down the wall (pressed left against it): no ceiling or ground until the floor.
    const wall = { x: 1, y: 0, w: 0.8, h: 0.8 };
    for (let i = 0; i < 20; i++) {
      slideTiles(tiles, wall, -0.05, 0.1, out);
      expect(out.hitCeiling).toBe(false);
      expect(out.hitWall).toBe(true);
      expect(out.x).toBe(1);
      wall.x = out.x;
      wall.y = out.y;
      if (out.onGround) break;
      expect(wall.y).toBeLessThan(3.2 + 1e-9);
    }
  });

  it('stops at walls and ceilings, and never tunnels', () => {
    const tiles = map(['######', '#....#', '#....#', '######']);
    const box = { x: 1.1, y: 1.1, w: 0.8, h: 0.8 };
    const hit = slideTiles(tiles, box, 50, 0, createTileSlideResult());
    expect(hit.hitWall).toBe(true);
    expect(hit.x).toBeCloseTo(5 - 0.8, 9);
    const ceil = slideTiles(tiles, box, 0, -50, createTileSlideResult());
    expect(ceil.hitCeiling).toBe(true);
    expect(ceil.y).toBe(1);
  });

  it('steps up a low ledge when grounded', () => {
    const tiles = map(['........', '........', '........', '....####', '########'], 1);
    const box = { x: 2, y: 4 - 0.8, w: 0.8, h: 0.8 };
    const out = createTileSlideResult();
    out.onGround = true;
    slideTiles(tiles, box, 2, 0, out, { stepUp: 1 });
    expect(out.hitWall).toBe(false);
    expect(out.y).toBeCloseTo(3 - 0.8, 9);
    expect(out.x).toBeCloseTo(4, 9);
    // Without stepUp it is a wall.
    const blocked = createTileSlideResult();
    blocked.onGround = true;
    slideTiles(tiles, box, 2, 0, blocked);
    expect(blocked.hitWall).toBe(true);
    expect(blocked.x).toBeCloseTo(4 - 0.8, 9);
  });

  it('a mover carries the box', () => {
    const tiles = map(['..........']);
    const mover: TileMover = { x: 2, y: 5, w: 3, h: 0.5, dx: 0, dy: 0 };
    const movers = [mover];
    const box = { x: 3, y: 3, w: 0.8, h: 0.8 };
    const out = createTileSlideResult();
    let vy = 0;
    for (let t = 0; t < 120; t++) {
      // Platforms move first: 0.02 right and slightly up each tick after it has landed.
      const moving = t >= 60;
      mover.dx = moving ? 0.02 : 0;
      mover.dy = moving ? -0.01 : 0;
      mover.x += mover.dx;
      mover.y += mover.dy;
      if (out.riding >= 0) carryBy(out, movers[out.riding]!);
      vy += 0.05;
      slideTiles(tiles, box, 0, vy, out, { movers });
      box.x = out.x;
      box.y = out.y;
      if (out.onGround) vy = 0;
      if (moving) {
        expect(out.riding).toBe(0);
        expect(out.onGround).toBe(true);
      }
    }
    expect(box.y + box.h).toBeCloseTo(mover.y, 6);
    expect(box.x).toBeCloseTo(3 + 60 * 0.02, 6);
    expect(out.carried.dx).toBe(0);
  });

  it('takes a GridSource (row z as y)', () => {
    const grid: GridSource = {
      width: 4,
      height: 4,
      cellSize: 2,
      origin: [10, 20],
      solid: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]),
    };
    const box = { x: 12, y: 20, w: 1, h: 1 };
    const out = run(grid, box, 0, 0, 40, 0.1);
    expect(out.onGround).toBe(true);
    expect(box.y).toBeCloseTo(26 - 1, 9);
    expect(() => slideTiles({ ...grid, cellSize: 0 }, box, 0, 0, out)).toThrow(/cellSize/);
  });
});
