import { describe, expect, it } from 'vitest';
import { createVoxelGrid } from './grid';
import { createVoxelHit, raycastVoxels } from './ray';

function world() {
  const g = createVoxelGrid({ sizeX: 16, sizeY: 16, sizeZ: 16, chunk: 16 });
  g.fill((_x, y) => (y < 4 ? 1 : 0));
  g.set(8, 4, 8, 2);
  return g;
}

describe('raycastVoxels', () => {
  it('hits the ground straight down with the up normal and the cell above as place target', () => {
    const g = world();
    const hit = createVoxelHit();
    expect(raycastVoxels(g, 2.5, 10.5, 2.5, 0, -1, 0, 20, hit)).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([2, 3, 2]);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([0, 1, 0]);
    expect([hit.px, hit.py, hit.pz]).toEqual([2, 4, 2]);
    expect(hit.distance).toBeCloseTo(6.5);
  });

  it('hits a block from the side along +x and -z', () => {
    const g = world();
    const hit = createVoxelHit();
    expect(raycastVoxels(g, 2.5, 4.5, 8.5, 1, 0, 0, 20, hit)).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([8, 4, 8]);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([-1, 0, 0]);
    expect([hit.px, hit.py, hit.pz]).toEqual([7, 4, 8]);
    expect(hit.distance).toBeCloseTo(5.5);
    expect(raycastVoxels(g, 8.5, 4.5, 14.5, 0, 0, -1, 20, hit)).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([8, 4, 8]);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([0, 0, 1]);
  });

  it('a diagonal ray finds the block on its path and scales distance by the direction', () => {
    const g = world();
    const hit = createVoxelHit();
    // From (4.5, 8.5, 4.5) towards (8.5, 4.5, 8.5): direction (1, -1, 1), unnormalised.
    expect(raycastVoxels(g, 4.5, 8.5, 4.5, 1, -1, 1, 10, hit)).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([8, 4, 8]);
    expect(Math.abs(hit.nx) + Math.abs(hit.ny) + Math.abs(hit.nz)).toBe(1);
    expect(hit.distance).toBeCloseTo(3.5);
    expect(g.get(hit.px, hit.py, hit.pz)).toBe(0);
    // Normalised direction: same cell, distance in world units.
    const s = 1 / Math.sqrt(3);
    expect(raycastVoxels(g, 4.5, 8.5, 4.5, s, -s, s, 10, hit)).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([8, 4, 8]);
    expect(hit.distance).toBeCloseTo(3.5 * Math.sqrt(3));
  });

  it('misses: up into the sky, out of the grid, or beyond maxDist', () => {
    const g = world();
    const hit = createVoxelHit();
    hit.x = 99;
    expect(raycastVoxels(g, 2.5, 10.5, 2.5, 0, 1, 0, 100, hit)).toBe(false);
    expect(raycastVoxels(g, 2.5, 10.5, 2.5, 1, 0, 0, 100, hit)).toBe(false);
    expect(raycastVoxels(g, 2.5, 10.5, 2.5, 0, -1, 0, 6, hit)).toBe(false);
    expect(raycastVoxels(g, -5, 2, -5, 0, -1, 0, 100, hit)).toBe(false);
    expect(hit.x).toBe(99);
  });

  it('a ray starting inside a block hits it at once with no face', () => {
    const g = world();
    const hit = createVoxelHit();
    expect(raycastVoxels(g, 2.5, 1.5, 2.5, 0, 1, 0, 10, hit)).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([2, 1, 2]);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([0, 0, 0]);
    expect([hit.px, hit.py, hit.pz]).toEqual([2, 1, 2]);
    expect(hit.distance).toBe(0);
  });

  it('enters the grid from outside', () => {
    const g = world();
    const hit = createVoxelHit();
    expect(raycastVoxels(g, -3.5, 2.5, 2.5, 1, 0, 0, 10, hit)).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([0, 2, 2]);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([-1, 0, 0]);
    expect(hit.distance).toBeCloseTo(3.5);
  });
});
