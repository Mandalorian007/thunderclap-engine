/** ws/voxel-draw: a `VoxelGrid` feeding a `VoxelWorld` on the fake GPU, edits included. */
import { describe, expect, it } from 'vitest';
import { createRenderCore } from '../render/core/core';
import { createRenderView } from '../render/core/view';
import { createFakeDevice } from '../render/fake-gpu';
import { defineBlockTable } from './blocks';
import { defineVoxelFormat } from './format';
import { createVoxelGrid } from './grid';
import { feedVoxelGrid } from './grid-source';
import { createVoxelWorld } from './world';

const format = defineVoxelFormat({
  sectionSize: 8,
  blocks: defineBlockTable([{ class: 'none' }, { class: 'opaque' }, { class: 'liquid' }]),
});

describe('feedVoxelGrid (ws/voxel-draw)', () => {
  it('draws a grid through the world and remeshes what an edit touches', async () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const clock = { now: 0 };
    const world = createVoxelWorld(core, { format, radius: 3, clock: () => clock.now });
    const grid = createVoxelGrid({ sizeX: 20, sizeY: 12, sizeZ: 20, chunk: 8 });
    grid.fill((x, y, z) => (y < 4 + ((x + z) % 3) ? 1 : y < 6 ? 2 : 0));
    expect(() => feedVoxelGrid(world, createVoxelGrid({ sizeX: 4, sizeY: 4, sizeZ: 4 }))).toThrow(
      /sectionSize/,
    );
    const source = feedVoxelGrid(world, grid);
    // 3 × 2 × 3 chunks and the ring of 5 × 4 × 5 around them.
    expect(source.puts).toBe(5 * 4 * 5);
    world.setInterest(10, 6, 10);
    const view = [createRenderView()];
    const run = async () => {
      for (let i = 0; i < 500 && (i === 0 || !world.settled); i++) {
        source.sync();
        world.update(10, 20, 10);
        core.prepare(fake.device.createCommandEncoder(), view);
        clock.now += 16;
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      expect(world.settled).toBe(true);
    };
    await run();
    const before = { ...world.stats };
    expect(before.drawn).toBeGreaterThan(0);
    expect(before.opaqueQuads).toBeGreaterThan(0);
    expect(before.liquidQuads).toBeGreaterThan(0);
    // A pillar of stone out of the water.
    for (let y = 4; y < 10; y++) grid.set(10, y, 10, 1);
    expect(source.sync()).toBeGreaterThan(0);
    await run();
    expect(world.stats.opaqueQuads).toBeGreaterThan(before.opaqueQuads);
    expect(source.sync()).toBe(0);
  });
});
