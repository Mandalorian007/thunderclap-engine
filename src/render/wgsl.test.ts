import { describe, expect, it } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from './fake-gpu';
import { VERTEX_LAYOUT_2D, VERTEX_LAYOUT_3D } from './mesh';
import { WGSL_PBR } from './pbr-wgsl';
import { Renderer } from './renderer';
import { createStandardMaterial } from './standard';
import {
  materialPrelude,
  WGSL_LAMBERT_BRDF,
  WGSL_LIGHTS,
  WGSL_MATERIAL_PRELUDE,
  wgslLightLoop,
} from './wgsl';

/** The loop's three light sections, each present once per generated copy. */
const SUN = 'if ((lights.sun_layers & layer_mask) != 0u)';
const POINTS = 'for (var i = 0u; i < lights.point_count; i++)';
const SPOTS = 'for (var i = 0u; i < lights.spot_count; i++)';

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The light-loop bodies in `code` that are not a `wgslLightLoop` instance named in `copies`: a
 * sun branch, a spot loop or a point-light fetch outside `engine_point_lights` (the legacy
 * points-only helper, which is not the light loop).
 */
function strayLoops(code: string, copies: string[]): number {
  let rest = code;
  for (const c of copies) {
    expect(count(rest, c)).toBe(1);
    rest = rest.replace(c, '');
  }
  rest = rest.replace(/fn engine_point_lights\([\s\S]*?\n}\n/, '');
  return (
    count(rest, SUN) + count(rest, SPOTS) + count(rest, POINTS) + count(rest, 'lights.points[')
  );
}

const LAMBERT_LOOP = wgslLightLoop('engine_light_accum', WGSL_LAMBERT_BRDF);
const PBR_LOOP = wgslLightLoop(
  'engine_pbr_accum',
  'engine_brdf(normal, v, l, diffuse_color, f0, a2, n_dot_v)',
  ', v: vec3f, diffuse_color: vec3f, f0: vec3f, a2: f32, n_dot_v: f32',
);

interface FakePipeline {
  desc: GPURenderPipelineDescriptor;
}

function fragmentCode(pipeline: unknown): string {
  return ((pipeline as FakePipeline).desc.fragment!.module as unknown as { code: string }).code;
}

describe('wgslLightLoop', () => {
  it('generates one function with the sun, point and spot sections and the BRDF inlined per kind', () => {
    const loop = wgslLightLoop('my_loop', 'brdf_expr(normal, l, extra)', ', extra: f32');
    expect(
      loop.startsWith(
        'fn my_loop(world_pos: vec3f, normal: vec3f, layer_mask: u32, extra: f32) -> vec3f {',
      ),
    ).toBe(true);
    expect(count(loop, SUN)).toBe(1);
    expect(count(loop, POINTS)).toBe(1);
    expect(count(loop, SPOTS)).toBe(1);
    expect(count(loop, 'brdf_expr(normal, l, extra)')).toBe(3);
    // The sun is shadowed, points and spots fall off with (1 - d/radius)², spots are coned.
    expect(loop).toContain(
      'lights.sun_color * (brdf_expr(normal, l, extra)) * engine_shadow(world_pos)',
    );
    expect(loop).toContain('light.color * (falloff * falloff * (brdf_expr(normal, l, extra)))');
    expect(loop).toContain(
      'light.color * (falloff * falloff * cone * (brdf_expr(normal, l, extra)))',
    );
    expect(loop).toContain(
      'engine_spot_cone(dot(-l, light.direction), light.cos_outer, light.cos_inner)',
    );
    // Masks: the sun's, the point's slot in point_layers, the spot's own field.
    expect(loop).toContain('lights.point_layers[i >> 2u][i & 3u] & layer_mask');
    expect(loop).toContain('(light.layers & layer_mask) == 0u');
    let depth = 0;
    for (const ch of loop) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('is the one loop WGSL_LIGHTS carries (engine_light_accum with the Lambert BRDF)', () => {
    expect(WGSL_LIGHTS).toContain(LAMBERT_LOOP);
    expect(strayLoops(WGSL_LIGHTS, [LAMBERT_LOOP])).toBe(0);
    // Lambert: N·L clamped, the arithmetic of the loop before it was shared.
    expect(WGSL_LAMBERT_BRDF).toBe('vec3f(max(dot(normal, l), 0.0))');
    expect(WGSL_LIGHTS).toContain(
      'sum += lights.sun_color * (vec3f(max(dot(normal, l), 0.0))) * engine_shadow(world_pos);',
    );
  });

  it('is the one loop WGSL_PBR carries (engine_pbr_accum with engine_brdf), with no private copy', () => {
    expect(WGSL_PBR).toContain(PBR_LOOP);
    expect(strayLoops(WGSL_PBR, [PBR_LOOP])).toBe(0);
    expect(count(WGSL_PBR, 'lights.sun_color')).toBe(1);
    expect(WGSL_PBR).toContain(
      'color += engine_pbr_accum(world_pos, n, layer_mask, v, diffuse_color, f0, a2, n_dot_v);',
    );
    expect(WGSL_PBR).toContain(
      'return engine_pbr_layers(base, metallic, roughness, n, v, world_pos, ao, emissive, 0xffffffffu);',
    );
  });

  it('a Lambert material and the standard material each compile with only generated loops (fake GPU)', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const lit = r.createMaterial({
      label: 'lit',
      wgsl: /* wgsl */ `@fragment fn fs_main(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = vec4f(in.color.rgb * engine_lambert_layers(normalize(in.normal), in.worldPos, engine_instance_layers(in.flags)), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`,
    });
    const litCode = fragmentCode(lit.pipelineFor(VERTEX_LAYOUT_3D, 2));
    expect(strayLoops(litCode, [LAMBERT_LOOP])).toBe(0);
    expect(count(litCode, SPOTS)).toBe(1);

    const standard = createStandardMaterial(r, { roughness: 0.3 });
    const code = fragmentCode(standard.pipelineFor(VERTEX_LAYOUT_3D, 2));
    // The prelude's Lambert copy and the PBR copy: two instances of one generator, nothing else.
    expect(strayLoops(code, [LAMBERT_LOOP, PBR_LOOP])).toBe(0);
    expect(count(code, SPOTS)).toBe(2);
    expect(code).toContain('engine_instance_layers(in.flags)');
    expect(fake.errors).toEqual([]);
  });

  it('the 2D path carries the block but calls neither loop: the sprite shader is loop-free', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    expect(WGSL_MATERIAL_PRELUDE).toBe(materialPrelude(VERTEX_LAYOUT_2D));
    const code = fragmentCode(r.defaultSprite.pipelineFor(VERTEX_LAYOUT_2D, 0));
    const prelude = WGSL_MATERIAL_PRELUDE;
    expect(code.startsWith(prelude)).toBe(true);
    const body = code.slice(prelude.length);
    for (const fn of ['engine_light_accum', 'engine_lambert', 'engine_pbr', 'engine_point_lights'])
      expect(body).not.toContain(fn);
    expect(fake.errors).toEqual([]);
  });
});
