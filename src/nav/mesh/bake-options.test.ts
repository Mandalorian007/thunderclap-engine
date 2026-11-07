import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_BAKE_DEFAULTS, NavBakeError, resolveNavBakeOptions } from './bake-options';
import { bakeNavMesh } from './navmesh';
import type { NavBakeOptions } from './voxelize';

/** A 20 × 20 floor slab (top at y = 0) with a 2 × 2 × 3 pillar on it, as triangle soup. */
function floorWithPillar(): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const box = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => {
    const b = positions.length / 3;
    for (const [x, y, z] of [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
      [-1, 1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [-1, 1, 1],
    ]) {
      positions.push(cx + (x! * sx) / 2, cy + (y! * sy) / 2, cz + (z! * sz) / 2);
    }
    for (const t of [4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1]) indices.push(b + t);
    for (const t of [1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]) indices.push(b + t);
  };
  box(0, -0.5, 0, 20, 1, 20);
  box(0, 1.5, 0, 2, 3, 2);
  return { positions, indices };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveNavBakeOptions', () => {
  it('derives every default from cellSize', () => {
    expect(resolveNavBakeOptions({ cellSize: 0.3 })).toEqual({
      cellSize: 0.3,
      cellHeight: 0.15,
      agentHeight: 2,
      agentRadius: 0.6,
      agentMaxClimb: 0.3,
      agentMaxSlope: 45,
      minRegionArea: 8,
      mergeRegionArea: 20,
      maxEdgeLength: 12 * 0.3,
      maxSimplification: 1.3 * 0.3,
      maxVertsPerPoly: 6,
    });
    // Climb follows the cell height given, not the derived one.
    expect(resolveNavBakeOptions({ cellSize: 0.5, cellHeight: 0.1 }).agentMaxClimb).toBe(0.2);
    expect(NAV_BAKE_DEFAULTS.agentHeight).toBe(2);
  });

  it('keeps every value given', () => {
    const full: Required<NavBakeOptions> = {
      cellSize: 0.25,
      cellHeight: 0.2,
      agentHeight: 1.8,
      agentRadius: 0,
      agentMaxClimb: 0,
      agentMaxSlope: 90,
      minRegionArea: 0,
      mergeRegionArea: 0,
      maxEdgeLength: 0,
      maxSimplification: 0,
      maxVertsPerPoly: 3,
    };
    expect(resolveNavBakeOptions(full)).toEqual(full);
  });

  it.each([
    [{}, 'cellSize', undefined],
    [{ cellSize: 0 }, 'cellSize', 0],
    [{ cellSize: Number.NaN }, 'cellSize', Number.NaN],
    [{ cellSize: 0.3, cellHeight: -0.1 }, 'cellHeight', -0.1],
    [{ cellSize: 0.3, agentHeight: Number.NaN }, 'agentHeight', Number.NaN],
    [{ cellSize: 0.3, agentHeight: 0 }, 'agentHeight', 0],
    [{ cellSize: 0.3, agentRadius: -1 }, 'agentRadius', -1],
    [{ cellSize: 0.3, agentMaxClimb: Number.POSITIVE_INFINITY }, 'agentMaxClimb', Infinity],
    [{ cellSize: 0.3, agentMaxSlope: 91 }, 'agentMaxSlope', 91],
    [{ cellSize: 0.3, minRegionArea: -1 }, 'minRegionArea', -1],
    [{ cellSize: 0.3, maxVertsPerPoly: 8 }, 'maxVertsPerPoly', 8],
    [{ cellSize: 0.3, maxVertsPerPoly: 4.5 }, 'maxVertsPerPoly', 4.5],
    [{ cellSize: 0.3, agentHeight: '2' }, 'agentHeight', '2'],
    [{ cellSize: 0.3, agentRadius: null }, 'agentRadius', null],
  ])('throws a NavBakeError naming the option for %j', (opts, option, value) => {
    let err: unknown;
    try {
      resolveNavBakeOptions(opts as NavBakeOptions);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NavBakeError);
    const e = err as NavBakeError;
    expect(e.name).toBe('NavBakeError');
    expect(e.option).toBe(option);
    expect(Object.is(e.value, value)).toBe(true);
    expect(e.message).toContain(`bakeNavMesh: ${option} must be`);
    expect(e.message).toContain(`got ${typeof value === 'string' ? `"${value}"` : String(value)}`);
  });
});

describe('bakeNavMesh defaults and validation', () => {
  it('bakes with only cellSize, the same polygons as the defaults spelled out', () => {
    const src = floorWithPillar();
    const short = bakeNavMesh(src, { cellSize: 0.3 });
    const long = bakeNavMesh(src, resolveNavBakeOptions({ cellSize: 0.3 }));
    expect(short.polyCount).toBeGreaterThan(0);
    expect(short.verts).toEqual(long.verts);
    expect(short.polys).toEqual(long.polys);
    expect(short.cellHeight).toBe(0.15);
  });

  it('agrees with explicit options that quantise to the same cells', () => {
    // cellSize 0.3: radius 0.4 and 0.6 both erode 2 cells, height 1.8 and 2 both clear the
    // open floor, climb 0.3 and 0.2 both span 2 or more cells of 0.1.
    const src = floorWithPillar();
    const given = bakeNavMesh(src, {
      cellSize: 0.3,
      cellHeight: 0.1,
      agentHeight: 1.8,
      agentRadius: 0.4,
      agentMaxClimb: 0.3,
      agentMaxSlope: 45,
    });
    const defaults = bakeNavMesh(src, { cellSize: 0.3, cellHeight: 0.1 });
    expect(defaults.polyCount).toBe(given.polyCount);
    expect(defaults.verts).toEqual(given.verts);
    expect(defaults.polys).toEqual(given.polys);
  });

  it('throws on a bad option before baking', () => {
    const src = floorWithPillar();
    expect(() => bakeNavMesh(src, { cellSize: 0.3, agentHeight: Number.NaN })).toThrow(
      NavBakeError,
    );
    expect(() => bakeNavMesh(src, { cellHeight: 0.2 } as unknown as NavBakeOptions)).toThrow(
      /cellSize/,
    );
  });

  it('warns once when triangles give no polygon, and not for no input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A vertical wall: two triangles, nothing walkable.
    const wall = { positions: [0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0], indices: [0, 1, 2, 0, 2, 3] };
    const mesh = bakeNavMesh(wall, { cellSize: 0.3 });
    expect(mesh.polyCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^\[nav\] bakeNavMesh: 0 polygons from 2 triangles/,
    );
    warn.mockClear();
    expect(bakeNavMesh({ positions: [], indices: [] }, { cellSize: 0.3 }).polyCount).toBe(0);
    expect(bakeNavMesh(floorWithPillar(), { cellSize: 0.3 }).polyCount).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
