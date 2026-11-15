/**
 * ws/scene-read-fit: a voxel stream's set outside `createVoxelWorld` (`voxelSetDesc`), and a
 * world's liquid shaded as a water look through the core's scene-read group (fake GPU).
 */
import { describe, expect, it } from 'vitest';
import { Water } from '../fx/water';
import { createRenderCore } from '../render/core/core';
import { createFakeDevice } from '../render/fake-gpu';
import { defineBlockTable } from './blocks';
import { defineVoxelFormat } from './format';
import { createVoxelWorld, voxelSetDesc } from './world';
import { VOXEL_DEFAULT_FRAGMENT } from './world-shaders';

const format = defineVoxelFormat({
  sectionSize: 8,
  blocks: defineBlockTable([{ class: 'none' }, { class: 'opaque' }, { class: 'liquid' }]),
});

describe('voxel sets outside the world (ws/scene-read-fit)', () => {
  it('describes each stream as the world makes it', () => {
    const opaque = voxelSetDesc(format, 'opaque');
    expect(opaque.pass).toBe('opaque');
    expect(opaque.castShadow).toBe(true);
    expect(opaque.shader.cullMode).toBe('back');
    expect(opaque.vertexLayout.stride).toBe(8);
    expect(opaque.instanceLayout!.stride).toBe(16);
    const liquid = voxelSetDesc(format, 'liquid');
    expect(liquid.pass).toBe('transparent');
    expect(liquid.shader.blend).toBeDefined();
    expect(liquid.shader.code).toContain(VOXEL_DEFAULT_FRAGMENT.liquid);
    expect(liquid.readsDepth).toBeUndefined();
    expect(voxelSetDesc(format, 'foliage').pass).toBe('cutout');
  });

  it('a liquid material that is a water look reads the scene', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const look = new Water(core, { plane: false }).look();
    const fragment = `${look.wgsl}
@fragment fn fs(in: VoxelVarying) -> WaterLookOut {
  return water_look_out(water_look(in.clip, in.world, in.normal));
}`;
    const world = createVoxelWorld(core, {
      format,
      radius: 1,
      materials: {
        liquid: {
          fragment,
          bindGroups: [look.bindGroup],
          blend: look.blend,
          writes: look.writes,
          readsDepth: look.readsDepth,
          readsColor: look.readsColor,
        },
      },
    });
    const liquid = world.sets.liquid;
    expect(liquid.readsDepth).toBe(true);
    expect(liquid.readsColor).toBe(true);
    expect(liquid.sceneGroup).toBe(2);
    expect(liquid.castShadow).toBe(false);
    expect(world.sets.opaque.sceneGroup).toBe(-1);
    expect(fake.errors).toEqual([]);
  });
});
