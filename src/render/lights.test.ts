import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHADOW_BIAS,
  FOG_OFFSET_FLOATS,
  LIGHTS_BLOCK_FLOATS,
  Lights,
  MAX_POINT_LIGHTS,
  POINT_LIGHT_FLOATS,
  POINT_LIGHTS_OFFSET_FLOATS,
  SHADOW_PARAMS_OFFSET_FLOATS,
  SUN_VIEW_PROJ_OFFSET_FLOATS,
} from './lights';
import { WGSL_LIGHTS } from './wgsl';

function block(l: Lights, o = 0) {
  const f32 = new Float32Array(o + LIGHTS_BLOCK_FLOATS).fill(Number.NaN);
  const u32 = new Uint32Array(f32.buffer);
  l.writeBlock(f32, u32, o);
  return { f32: f32.subarray(o), u32: u32.subarray(o) };
}

describe('Lights block', () => {
  it('matches the WGSL struct: 12-float header, 16 × 8-float points, sun matrix, shadow, fog', () => {
    expect(POINT_LIGHTS_OFFSET_FLOATS).toBe(12);
    expect(POINT_LIGHT_FLOATS).toBe(8);
    expect(MAX_POINT_LIGHTS).toBe(16);
    expect(SUN_VIEW_PROJ_OFFSET_FLOATS).toBe(140);
    expect(SHADOW_PARAMS_OFFSET_FLOATS).toBe(156);
    expect(FOG_OFFSET_FLOATS).toBe(160);
    expect(LIGHTS_BLOCK_FLOATS).toBe(168);
    expect((LIGHTS_BLOCK_FLOATS * 4) % 16).toBe(0);
    expect(WGSL_LIGHTS).toContain('@group(0) @binding(2) var<uniform> lights: EngineLights;');
    expect(WGSL_LIGHTS).toContain(`array<EnginePointLight, ${MAX_POINT_LIGHTS}>`);
    expect(WGSL_LIGHTS).toContain('@group(0) @binding(3) var engine_shadow_map: texture_depth_2d;');
    expect(WGSL_LIGHTS).toContain(
      '@group(0) @binding(4) var engine_shadow_sampler: sampler_comparison;',
    );
    for (const f of [
      'sun_view_proj: mat4x4f',
      'shadow_params: vec4f',
      'fog: vec4f',
      'fog_range: vec4f',
    ])
      expect(WGSL_LIGHTS).toContain(f);
    // The helpers every material can call (and skip under the default block).
    expect(WGSL_LIGHTS).toContain('fn engine_shadow(world_pos: vec3f) -> f32');
    expect(WGSL_LIGHTS).toContain('fn engine_fog(color: vec3f, world_pos: vec3f) -> vec3f');
    expect(WGSL_LIGHTS).toContain('* engine_shadow(world_pos)');
  });

  it('defaults to the unlit block: ambient 1, no sun, no points, zero padding', () => {
    const { f32, u32 } = block(new Lights());
    expect([...f32.subarray(0, 3)]).toEqual([1, 1, 1]);
    expect(u32[3]).toBe(0);
    expect([...f32.subarray(4, 8)]).toEqual([0, -1, 0, 0]);
    expect([...f32.subarray(8, 12)]).toEqual([0, 0, 0, 0]);
    expect(f32.subarray(12).every((v) => v === 0)).toBe(true);
  });

  it('writes ambient, a normalised sun and each point light at its slot', () => {
    const l = new Lights();
    l.ambient.set([0.1, 0.2, 0.3]);
    l.sun.dir = [0, 0, -2];
    l.sun.color = [1, 0.5, 0.25];
    l.points.push(
      { position: [1, 2, 3], color: [4, 5, 6], radius: 7 },
      { position: new Float32Array([-1, -2, -3]), color: [0, 1, 0], radius: 0.5 },
    );
    const { f32, u32 } = block(l, 5);
    expect([...f32.subarray(0, 3)]).toEqual([0.1, 0.2, 0.3].map(Math.fround));
    expect(u32[3]).toBe(2);
    expect([...f32.subarray(4, 7)]).toEqual([0, 0, -1]);
    expect([...f32.subarray(8, 11)]).toEqual([1, 0.5, 0.25]);
    expect([...f32.subarray(12, 20)]).toEqual([1, 2, 3, 7, 4, 5, 6, 0]);
    expect([...f32.subarray(20, 28)]).toEqual([-1, -2, -3, 0.5, 0, 1, 0, 0]);
    expect(f32.subarray(28).every((v) => v === 0)).toBe(true);
  });

  it('a zero sun direction writes zeros instead of NaN', () => {
    const l = new Lights();
    l.sun.dir = [0, 0, 0];
    const { f32 } = block(l);
    expect([...f32.subarray(4, 7)]).toEqual([0, 0, 0]);
  });

  it('clamps point_count to MAX_POINT_LIGHTS and clears stale slots when lights go away', () => {
    const l = new Lights();
    for (let i = 0; i < MAX_POINT_LIGHTS + 3; i++) {
      l.points.push({ position: [i, 0, 0], color: [1, 1, 1], radius: 1 });
    }
    const f32 = new Float32Array(LIGHTS_BLOCK_FLOATS);
    const u32 = new Uint32Array(f32.buffer);
    l.writeBlock(f32, u32);
    expect(u32[3]).toBe(MAX_POINT_LIGHTS);
    expect(f32[POINT_LIGHTS_OFFSET_FLOATS + (MAX_POINT_LIGHTS - 1) * POINT_LIGHT_FLOATS]).toBe(15);
    l.points.length = 1;
    l.writeBlock(f32, u32);
    expect(u32[3]).toBe(1);
    expect(
      f32.subarray(POINT_LIGHTS_OFFSET_FLOATS + POINT_LIGHT_FLOATS).every((v) => v === 0),
    ).toBe(true);
  });

  it('reset returns to the unlit block and keeps the same arrays', () => {
    const l = new Lights();
    const ambient = l.ambient;
    l.ambient.set([0, 0, 0]);
    l.sun.color = [1, 1, 1];
    l.sun.shadow = { extent: 10 };
    l.fog.density = 0.5;
    l.fog.far = 10;
    l.points.push({ position: [0, 0, 0], color: [1, 1, 1], radius: 1 });
    expect(l.reset()).toBe(l);
    expect(l.ambient).toBe(ambient);
    expect(l.points.length).toBe(0);
    expect(l.sun.shadow).toBeNull();
    expect(l.fog).toEqual({ color: new Float32Array(3), density: 0, near: 0, far: 0 });
    expect(block(l).f32).toEqual(block(new Lights()).f32);
  });

  it('default sun has no shadow and the shadow fields are zero with enabled 0', () => {
    const l = new Lights();
    expect(l.sun.shadow).toBeNull();
    expect(DEFAULT_SHADOW_BIAS).toBeGreaterThan(0);
    const { f32 } = block(l);
    expect(f32.subarray(SUN_VIEW_PROJ_OFFSET_FLOATS, FOG_OFFSET_FLOATS).every((v) => v === 0)).toBe(
      true,
    );
  });

  it('writes the shadow uniforms the renderer passes: matrix, bias, texel size, enabled 1', () => {
    const l = new Lights();
    const viewProj = Float32Array.from({ length: 16 }, (_, i) => i + 1);
    const f32 = new Float32Array(LIGHTS_BLOCK_FLOATS).fill(Number.NaN);
    const u32 = new Uint32Array(f32.buffer);
    l.writeBlock(f32, u32, 0, { viewProj, bias: 0.002, texelSize: 1 / 2048 });
    expect([
      ...f32.subarray(SUN_VIEW_PROJ_OFFSET_FLOATS, SUN_VIEW_PROJ_OFFSET_FLOATS + 16),
    ]).toEqual([...viewProj]);
    expect([...f32.subarray(SHADOW_PARAMS_OFFSET_FLOATS, SHADOW_PARAMS_OFFSET_FLOATS + 4)]).toEqual(
      [0.002, 1 / 2048, 1, 0].map(Math.fround),
    );
    // Without a shadow pass the same block clears them again (enabled 0).
    l.writeBlock(f32, u32, 0, null);
    expect(f32.subarray(SUN_VIEW_PROJ_OFFSET_FLOATS, FOG_OFFSET_FLOATS).every((v) => v === 0)).toBe(
      true,
    );
  });

  it('writes fog as rgb, density, near, far', () => {
    const l = new Lights();
    l.fog.color = [0.5, 0.6, 0.7];
    l.fog.density = 0.8;
    l.fog.near = 5;
    l.fog.far = 40;
    const { f32 } = block(l, 3);
    expect([...f32.subarray(FOG_OFFSET_FLOATS, FOG_OFFSET_FLOATS + 8)]).toEqual(
      [0.5, 0.6, 0.7, 0.8, 5, 40, 0, 0].map(Math.fround),
    );
    expect(f32.length).toBe(LIGHTS_BLOCK_FLOATS);
  });
});
