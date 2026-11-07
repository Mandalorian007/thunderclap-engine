import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { createFakeDevice, fakeRendererGpu } from './fake-gpu';
import {
  ALL_LIGHT_LAYERS,
  DEFAULT_SHADOW_BIAS,
  FOG_OFFSET_FLOATS,
  INSTANCE_LAYER_BITS,
  INSTANCE_LAYER_SHIFT,
  LAYERS_OFFSET_FLOATS,
  LIGHTS_BLOCK_FLOATS,
  Lights,
  MAX_POINT_LIGHTS,
  MAX_SPOT_LIGHTS,
  POINT_LAYERS_OFFSET_FLOATS,
  POINT_LIGHT_FLOATS,
  POINT_LIGHTS_OFFSET_FLOATS,
  packInstanceFlags,
  SHADOW_PARAMS_OFFSET_FLOATS,
  SPOT_LIGHT_FLOATS,
  SPOT_LIGHTS_OFFSET_FLOATS,
  SUN_VIEW_PROJ_OFFSET_FLOATS,
  spotCone,
} from './lights';
import { INSTANCE_FLOATS, INSTANCE_OFFSET } from './material';
import { Renderer } from './renderer';
import { WGSL_LIGHTS, WGSL_MATERIAL_PRELUDE } from './wgsl';

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
    expect(LAYERS_OFFSET_FLOATS).toBe(168);
    expect(POINT_LAYERS_OFFSET_FLOATS).toBe(172);
    expect(MAX_SPOT_LIGHTS).toBe(8);
    expect(SPOT_LIGHT_FLOATS).toBe(16);
    expect(SPOT_LIGHTS_OFFSET_FLOATS).toBe(188);
    expect(LIGHTS_BLOCK_FLOATS).toBe(316);
    expect((LIGHTS_BLOCK_FLOATS * 4) % 16).toBe(0);
    // Uniform-address-space alignment of the appended fields (16-byte structs and arrays).
    expect((POINT_LAYERS_OFFSET_FLOATS * 4) % 16).toBe(0);
    expect((SPOT_LIGHTS_OFFSET_FLOATS * 4) % 16).toBe(0);
    expect(WGSL_LIGHTS).toContain(`array<EngineSpotLight, ${MAX_SPOT_LIGHTS}>`);
    expect(WGSL_LIGHTS).toContain('point_layers: array<vec4u, 4>');
    for (const f of ['spot_count: u32', 'sun_layers: u32', 'cos_outer: f32', 'cos_inner: f32'])
      expect(WGSL_LIGHTS).toContain(f);
    expect(WGSL_LIGHTS).toContain(
      'fn engine_light_accum(world_pos: vec3f, normal: vec3f, layer_mask: u32) -> vec3f',
    );
    expect(WGSL_LIGHTS).toContain('fn engine_instance_layers(flags: u32) -> u32');
    expect(WGSL_LIGHTS).toContain(
      'fn engine_lambert_layers(normal: vec3f, world_pos: vec3f, layer_mask: u32) -> vec3f',
    );
    expect(WGSL_LIGHTS).toContain('engine_lambert_layers(normal, world_pos, 0xffffffffu)');
    // The 2D material prelude still carries the same lights block and vertex contract.
    expect(WGSL_MATERIAL_PRELUDE).toContain(WGSL_LIGHTS);
    expect(WGSL_MATERIAL_PRELUDE).toContain('@location(9) @interpolate(flat) flags: u32,');
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
    expect(f32.subarray(12, LAYERS_OFFSET_FLOATS).every((v) => v === 0)).toBe(true);
    // The tail: no spots, the sun's mask is all layers, no point masks, no spot slots.
    expect(u32[LAYERS_OFFSET_FLOATS]).toBe(0);
    expect(u32[LAYERS_OFFSET_FLOATS + 1]).toBe(ALL_LIGHT_LAYERS);
    expect(f32.subarray(LAYERS_OFFSET_FLOATS + 2).every((v) => v === 0)).toBe(true);
  });

  it('writes ambient, a normalised sun and each point light at its slot', () => {
    const l = new Lights();
    l.ambient.set([0.1, 0.2, 0.3]);
    l.sun.direction = [0, 0, -2];
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
    expect(f32.subarray(28, LAYERS_OFFSET_FLOATS).every((v) => v === 0)).toBe(true);
    expect([...u32.subarray(POINT_LAYERS_OFFSET_FLOATS, POINT_LAYERS_OFFSET_FLOATS + 3)]).toEqual([
      ALL_LIGHT_LAYERS,
      ALL_LIGHT_LAYERS,
      0,
    ]);
    expect(f32.subarray(SPOT_LIGHTS_OFFSET_FLOATS).every((v) => v === 0)).toBe(true);
  });

  it('a zero sun direction writes zeros instead of NaN', () => {
    const l = new Lights();
    l.sun.direction = [0, 0, 0];
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
      f32
        .subarray(POINT_LIGHTS_OFFSET_FLOATS + POINT_LIGHT_FLOATS, LAYERS_OFFSET_FLOATS)
        .every((v) => v === 0),
    ).toBe(true);
    // The stale point masks are cleared with their slots.
    expect(u32[POINT_LAYERS_OFFSET_FLOATS]).toBe(ALL_LIGHT_LAYERS);
    expect(f32.subarray(POINT_LAYERS_OFFSET_FLOATS + 1).every((v) => v === 0)).toBe(true);
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

  it('defaults every layer mask to all layers and writes point masks per slot', () => {
    const l = new Lights();
    l.points.push(
      { position: [0, 0, 0], color: [1, 1, 1], radius: 1 },
      { position: [0, 0, 0], color: [1, 1, 1], radius: 1, layers: 0b10 },
    );
    const { u32 } = block(l, 2);
    expect(u32[LAYERS_OFFSET_FLOATS]).toBe(0); // spot_count
    expect(u32[LAYERS_OFFSET_FLOATS + 1]).toBe(ALL_LIGHT_LAYERS); // sun_layers
    expect([...u32.subarray(LAYERS_OFFSET_FLOATS + 2, LAYERS_OFFSET_FLOATS + 4)]).toEqual([0, 0]);
    expect(u32[POINT_LAYERS_OFFSET_FLOATS]).toBe(ALL_LIGHT_LAYERS);
    expect(u32[POINT_LAYERS_OFFSET_FLOATS + 1]).toBe(0b10);
    // Empty point slots carry a zero mask.
    expect(
      u32.subarray(POINT_LAYERS_OFFSET_FLOATS + 2, SPOT_LIGHTS_OFFSET_FLOATS).every((v) => v === 0),
    ).toBe(true);
    l.sun.layers = 0b100;
    l.points[0]!.layers = 0xffff0000;
    const again = block(l).u32;
    expect(again[LAYERS_OFFSET_FLOATS + 1]).toBe(0b100);
    expect(again[POINT_LAYERS_OFFSET_FLOATS]).toBe(0xffff0000);
  });

  it('writes each spot light: position, radius, unit direction, cosines, colour, mask', () => {
    const l = new Lights();
    l.spots.push(
      {
        position: [1, 2, 3],
        direction: [0, -2, 0],
        color: [4, 5, 6],
        radius: 7,
        innerAngle: 0.2,
        outerAngle: 0.4,
      },
      {
        position: new Float32Array([-1, -2, -3]),
        direction: [3, 0, 4],
        color: [1, 0, 0],
        radius: 9,
        innerAngle: 0,
        outerAngle: Math.PI / 2,
        layers: 0b1010,
      },
    );
    const { f32, u32 } = block(l, 7);
    expect(u32[LAYERS_OFFSET_FLOATS]).toBe(2);
    const s0 = SPOT_LIGHTS_OFFSET_FLOATS;
    expect([...f32.subarray(s0, s0 + 12)]).toEqual(
      [1, 2, 3, 7, 0, -1, 0, Math.cos(0.4), 4, 5, 6, Math.cos(0.2)].map(Math.fround),
    );
    expect(u32[s0 + 12]).toBe(ALL_LIGHT_LAYERS);
    expect([...f32.subarray(s0 + 13, s0 + 16)]).toEqual([0, 0, 0]);
    const s1 = s0 + SPOT_LIGHT_FLOATS;
    expect([...f32.subarray(s1, s1 + 7)]).toEqual([-1, -2, -3, 9, 0.6, 0, 0.8].map(Math.fround));
    expect(f32[s1 + 7]).toBeCloseTo(0, 6);
    expect([...f32.subarray(s1 + 8, s1 + 12)]).toEqual([1, 0, 0, 1]);
    expect(u32[s1 + 12]).toBe(0b1010);
    expect(f32.subarray(s1 + SPOT_LIGHT_FLOATS).every((v) => v === 0)).toBe(true);
    expect(f32.length).toBe(LIGHTS_BLOCK_FLOATS);
  });

  it('clamps spot_count to MAX_SPOT_LIGHTS and clears stale spot slots', () => {
    const l = new Lights();
    for (let i = 0; i < MAX_SPOT_LIGHTS + 2; i++) {
      l.spots.push({
        position: [i, 0, 0],
        direction: [0, -1, 0],
        color: [1, 1, 1],
        radius: 1,
        innerAngle: 0.1,
        outerAngle: 0.2,
      });
    }
    const f32 = new Float32Array(LIGHTS_BLOCK_FLOATS);
    const u32 = new Uint32Array(f32.buffer);
    l.writeBlock(f32, u32);
    expect(u32[LAYERS_OFFSET_FLOATS]).toBe(MAX_SPOT_LIGHTS);
    expect(f32[SPOT_LIGHTS_OFFSET_FLOATS + (MAX_SPOT_LIGHTS - 1) * SPOT_LIGHT_FLOATS]).toBe(7);
    l.spots.length = 1;
    l.writeBlock(f32, u32);
    expect(u32[LAYERS_OFFSET_FLOATS]).toBe(1);
    expect(f32.subarray(SPOT_LIGHTS_OFFSET_FLOATS + SPOT_LIGHT_FLOATS).every((v) => v === 0)).toBe(
      true,
    );
    expect(l.reset().spots.length).toBe(0);
    expect(block(l).f32).toEqual(block(new Lights()).f32);
  });

  it('spotCone: 1 inside the inner angle, 0 outside the outer, smooth between, hard when equal', () => {
    const inner = Math.cos(0.2);
    const outer = Math.cos(0.4);
    expect(spotCone(1, outer, inner)).toBe(1);
    expect(spotCone(inner, outer, inner)).toBe(1);
    expect(spotCone(outer, outer, inner)).toBe(0);
    expect(spotCone(-1, outer, inner)).toBe(0);
    const mid = spotCone((inner + outer) / 2, outer, inner);
    expect(mid).toBeCloseTo(0.5, 6);
    expect(spotCone(outer + (inner - outer) * 0.25, outer, inner)).toBeCloseTo(0.15625, 6);
    // Equal angles: a hard edge, never NaN.
    expect(spotCone(0.9, 0.8, 0.8)).toBe(1);
    expect(spotCone(0.7, 0.8, 0.8)).toBe(0);
    expect(spotCone(0.8, 0.8, 0.8)).toBe(0);
  });

  it('packInstanceFlags: shadow bit 0, layers in bits 1..23, exact in a float', () => {
    expect(INSTANCE_LAYER_SHIFT).toBe(1);
    expect(INSTANCE_LAYER_BITS).toBe(23);
    expect(packInstanceFlags(true, 1)).toBe(2);
    expect(packInstanceFlags(false, 1)).toBe(3);
    expect(packInstanceFlags(true, 0b101)).toBe(0b1010);
    const all = packInstanceFlags(false, 0xffffffff);
    expect(all).toBe(0xffffff);
    expect(Math.fround(all)).toBe(all);
    expect(all >> INSTANCE_LAYER_SHIFT).toBe((1 << INSTANCE_LAYER_BITS) - 1);
    // The 24th layer bit and above do not fit and are dropped.
    expect(packInstanceFlags(true, 1 << 23)).toBe(0);
  });

  it('a masked light reaches the GPU block and the instance carries its layers (fake GPU)', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    r.resize(64, 64);
    const blocks: { f32: Float32Array; u32: Uint32Array }[] = [];
    const instances: Float32Array[] = [];
    const q = fake.device.queue as unknown as { writeBuffer: (...a: unknown[]) => void };
    const orig = q.writeBuffer.bind(q);
    q.writeBuffer = (buffer: unknown, offset: unknown, data: unknown, ...rest: unknown[]) => {
      const label = (buffer as { label?: string }).label ?? '';
      if (label.startsWith('engine-globals')) {
        const f32 = new Float32Array(data as Float32Array);
        // The lights block follows the 8-float globals and the 128-float camera at byte 768.
        const o = 192;
        expect(f32.length).toBe(o + LIGHTS_BLOCK_FLOATS);
        blocks.push({ f32: f32.subarray(o), u32: new Uint32Array(f32.buffer).subarray(o) });
      } else if (label.startsWith('instances')) {
        instances.push(new Float32Array(data as Float32Array));
      }
      orig(buffer, offset, data, ...rest);
    };
    const cam = Camera.perspective(1, 1, 0.1, 100);
    cam.cull = false;
    r.camera = cam;
    const f = r.beginFrame(0, 0);
    f.lights.ambient.set([0.1, 0.1, 0.1]);
    f.lights.points.push({ position: [0, 2, 0], color: [1, 1, 1], radius: 5, layers: 0b10 });
    f.lights.spots.push({
      position: [0, 4, 0],
      direction: [0, -1, 0],
      color: [2, 2, 2],
      radius: 8,
      innerAngle: 0.1,
      outerAngle: 0.3,
      layers: 0b1,
    });
    f.sprite(null, { x: 0, y: 0, layers: 0b1 });
    f.sprite(null, { x: 1, y: 0, layers: 0b10 });
    r.endFrame();
    expect(fake.errors).toEqual([]);
    expect(blocks.length).toBeGreaterThan(0);
    const { f32, u32 } = blocks[blocks.length - 1]!;
    expect(u32[3]).toBe(1);
    expect(u32[POINT_LAYERS_OFFSET_FLOATS]).toBe(0b10);
    expect(u32[LAYERS_OFFSET_FLOATS]).toBe(1);
    expect(u32[LAYERS_OFFSET_FLOATS + 1]).toBe(ALL_LIGHT_LAYERS);
    expect(u32[SPOT_LIGHTS_OFFSET_FLOATS + 12]).toBe(0b1);
    expect(f32[SPOT_LIGHTS_OFFSET_FLOATS + 7]).toBe(Math.fround(Math.cos(0.3)));
    // The two instances carry layers 1 and 2 in their flags; the point light (mask 0b10) is
    // excluded from the first by `engine_light_accum`, the spot (mask 0b1) from the second.
    const inst = instances[instances.length - 1]!;
    const flags = [0, 1].map((i) => inst[i * INSTANCE_FLOATS + INSTANCE_OFFSET.flags]! >> 1);
    expect(flags).toEqual([0b1, 0b10]);
    expect(flags[0]! & u32[POINT_LAYERS_OFFSET_FLOATS]!).toBe(0);
    expect(flags[1]! & u32[POINT_LAYERS_OFFSET_FLOATS]!).not.toBe(0);
    expect(flags[0]! & u32[SPOT_LIGHTS_OFFSET_FLOATS + 12]!).not.toBe(0);
    expect(flags[1]! & u32[SPOT_LIGHTS_OFFSET_FLOATS + 12]!).toBe(0);
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
