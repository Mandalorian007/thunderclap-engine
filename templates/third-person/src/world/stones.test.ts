import { createHit, exportCollider, raycastReg } from '@thunderclap/engine/geom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import stonesJson from '../../assets/stones.json';
import { createGround } from './ground';
import { createStoneCollider, loadStoneCollider, stoneGeometry, stoneGeometryJson } from './stones';

const ground = createGround();

describe('stones', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('meshes every block as a box', () => {
    const g = stoneGeometry(ground);
    expect(g.indices.length / 3).toBe(ground.blocks.length * 12);
  });

  it('assets/stones.json is the bake input for the blocks in ground.ts', () => {
    // `pnpm bake` reads this file; regenerate it when the blocks change (see CLAUDE.md).
    const j = stoneGeometryJson(ground);
    expect(stonesJson.indices).toEqual(j.indices);
    expect(stonesJson.positions.length).toBe(j.positions.length);
    for (let i = 0; i < j.positions.length; i++) {
      expect(stonesJson.positions[i]).toBeCloseTo(j.positions[i]!, 3);
    }
  });

  it('the runtime collider blocks a line through a stone and not one above it', () => {
    const c = createStoneCollider(ground);
    const b = ground.blocks[0]!;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const hit = createHit();
    expect(raycastReg(c, cx - 5, cy, cz, 1, 0, 0, 10, hit)).toBe(true);
    expect(hit.x).toBeCloseTo(b.min[0], 4);
    expect(raycastReg(c, cx - 5, cy + 10, cz, 1, 0, 0, 10, hit)).toBe(false);
  });

  it('loads the baked file when it is there and falls back when it is not', async () => {
    const baked = exportCollider(createStoneCollider(ground));
    vi.stubGlobal('fetch', async () => new Response(baked));
    const fromFile = await loadStoneCollider(ground, 'baked/stones.coll');
    expect(fromFile.triangleCount).toBe(ground.blocks.length * 12);

    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 404 }));
    const fallback = await loadStoneCollider(ground, 'baked/stones.coll');
    expect(fallback.triangleCount).toBe(ground.blocks.length * 12);

    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect((await loadStoneCollider(ground, 'x')).triangleCount).toBe(ground.blocks.length * 12);
  });
});
