import { describe, expect, it } from 'vitest';
import { VOXEL_WGSL } from './wgsl';

describe('VOXEL_WGSL', () => {
  it('declares the layer, ao and uv helpers over the vertex convention', () => {
    expect(VOXEL_WGSL).toContain('fn voxel_layer(color: vec4f) -> u32');
    expect(VOXEL_WGSL).toContain('round(');
    expect(VOXEL_WGSL).toContain('color.a');
    expect(VOXEL_WGSL).toContain('fn voxel_ao(color: vec4f) -> f32');
    expect(VOXEL_WGSL).toContain('return color.r;');
    expect(VOXEL_WGSL).toContain('fn voxel_uv_wrap(uv: vec2f) -> vec2f');
    expect(VOXEL_WGSL).toContain('fract(uv)');
    // A prelude, not a module: no bindings or entry points of its own.
    expect(VOXEL_WGSL).not.toContain('@group');
    expect(VOXEL_WGSL).not.toContain('@fragment');
  });
});
