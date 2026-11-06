import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeBuffer, type FakeDevice, fakeRendererGpu } from './fake-gpu';
import { VERTEX_LAYOUT_3D } from './mesh';
import { WGSL_PBR } from './pbr-wgsl';
import { Renderer } from './renderer';
import {
  createStandardMaterial,
  packStandardUniforms,
  STANDARD_TEXTURE_SLOTS,
  STANDARD_UNIFORM_FLOATS,
  STANDARD_WGSL,
} from './standard';
import { defaultTextures } from './texture';
import { wgslLightLoop } from './wgsl';

function setup(): { fake: FakeDevice; r: Renderer } {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  return { fake, r };
}

function defaults(fake: FakeDevice) {
  return fake.textures.filter((t) => t.label?.startsWith('default-'));
}

/** Braces balance (the cheapest check the fake GPU allows on shader text). */
function balanced(code: string): void {
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
}

interface FakePipeline {
  desc: GPURenderPipelineDescriptor;
}
interface FakeGroup {
  entries: { binding: number; resource: { texture?: { label?: string } } }[];
}

describe('WGSL_PBR', () => {
  it('defines the PBR helpers the standard material calls', () => {
    balanced(WGSL_PBR);
    for (const fn of [
      'engine_d_ggx',
      'engine_v_smith_ggx',
      'engine_f_schlick',
      'engine_brdf',
      'engine_pbr_accum',
      'engine_pbr_layers',
      'engine_pbr',
      'engine_perturb_normal',
    ]) {
      expect(WGSL_PBR).toContain(`fn ${fn}(`);
    }
    // Reads the engine's lighting helpers rather than redoing them: the shared loop (sun with
    // its shadow, points, spots, masks) with the GGX BRDF, then fog.
    expect(WGSL_PBR).toContain(
      wgslLightLoop(
        'engine_pbr_accum',
        'engine_brdf(normal, v, l, diffuse_color, f0, a2, n_dot_v)',
        ', v: vec3f, diffuse_color: vec3f, f0: vec3f, a2: f32, n_dot_v: f32',
      ),
    );
    expect(WGSL_PBR).toContain('engine_fog(color, world_pos)');
    expect(WGSL_PBR.split('lights.points[i]')).toHaveLength(2);
  });

  it('builds the standard material into a 3D depth pipeline on the fake GPU', () => {
    const { fake, r } = setup();
    const m = createStandardMaterial(r, { roughness: 0.3 });
    const pipeline = m.pipelineFor(VERTEX_LAYOUT_3D, 2) as unknown as FakePipeline;
    const module = pipeline.desc.fragment!.module as unknown as { code: string };
    balanced(module.code);
    expect(module.code).toContain('fn engine_pbr(');
    expect(module.code).toContain('fn engine_pbr_layers(');
    expect(module.code).toContain('@fragment fn fs_main(');
    // The material lights against the instance's layer bits, so masked lights skip it.
    expect(STANDARD_WGSL).toContain('engine_instance_layers(in.flags)');
    expect(module.code.indexOf('fn engine_vertex(')).toBeLessThan(module.code.indexOf(WGSL_PBR));
    expect(module.code.indexOf(WGSL_PBR)).toBeLessThan(module.code.indexOf(STANDARD_WGSL));
    expect(pipeline.desc.depthStencil?.depthWriteEnabled).toBe(true);
    expect(fake.errors).toEqual([]);
  });
});

describe('createStandardMaterial', () => {
  it('binds five maps, a 48-byte block and the repeat sampler, opaque by default', () => {
    const { fake, r } = setup();
    const m = createStandardMaterial(r, {});
    expect(m.label).toBe('standard');
    expect(m.blend).toBe('opaque');
    expect(m.bindings?.blockBytes).toBe(STANDARD_UNIFORM_FLOATS * 4);
    const group = m.bindings!.bindGroup as unknown as FakeGroup;
    expect(group.entries.map((e) => e.binding)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // The maps come from the device's registry (`defaultTextures`), not a private set.
    const d = defaultTextures(fake.device);
    const texture = (slot: number) =>
      group.entries.find((e) => e.binding === 2 + slot)!.resource.texture;
    expect(texture(STANDARD_TEXTURE_SLOTS.baseColor)).toBe(d.white.texture);
    expect(texture(STANDARD_TEXTURE_SLOTS.metallicRoughness)).toBe(d.white.texture);
    expect(texture(STANDARD_TEXTURE_SLOTS.normal)).toBe(d.flatNormal.texture);
    expect(texture(STANDARD_TEXTURE_SLOTS.occlusion)).toBe(d.white.texture);
    expect(texture(STANDARD_TEXTURE_SLOTS.emissive)).toBe(d.black.texture);
    expect(fake.textures.filter((t) => t.label?.startsWith('standard:'))).toEqual([]);
    const flat = fake.textureWrites.find((w) => w.texture.label === 'default-flat-normal');
    expect([...(flat!.data as Uint8Array)]).toEqual([128, 128, 255, 255]);
    const black = fake.textureWrites.find((w) => w.texture.label === 'default-black');
    expect([...(black!.data as Uint8Array)]).toEqual([0, 0, 0, 255]);
    expect(fake.errors).toEqual([]);
  });

  it('creates no maps of its own: the registry is made once per device', () => {
    const { fake, r } = setup();
    const before = defaults(fake).length;
    createStandardMaterial(r, {});
    createStandardMaterial(r, { metallic: 1 });
    createStandardMaterial(r, { alphaMode: 'blend' });
    expect(defaults(fake)).toHaveLength(before);
    expect(fake.textures.filter((t) => t.label?.startsWith('standard:'))).toEqual([]);
  });

  it('binds the given maps in slot order and the defaults elsewhere', () => {
    const { fake, r } = setup();
    const px = (label: string) =>
      r.textureFromPixels({ width: 1, height: 1, data: new Uint8Array(4), label });
    const m = createStandardMaterial(r, { normal: px('n'), emissive: px('e'), label: 'skin' });
    expect(m.label).toBe('skin');
    const group = m.bindings!.bindGroup as unknown as FakeGroup;
    const label = (slot: number) =>
      group.entries.find((e) => e.binding === 2 + slot)!.resource.texture?.label;
    expect(label(STANDARD_TEXTURE_SLOTS.baseColor)).toBe('default-white');
    expect(label(STANDARD_TEXTURE_SLOTS.metallicRoughness)).toBe('default-white');
    expect(label(STANDARD_TEXTURE_SLOTS.normal)).toBe('n');
    expect(label(STANDARD_TEXTURE_SLOTS.occlusion)).toBe('default-white');
    expect(label(STANDARD_TEXTURE_SLOTS.emissive)).toBe('e');
    expect(defaults(fake).map((t) => t.label)).toEqual([
      'default-white',
      'default-black',
      'default-flat-normal',
      'default-metal-rough',
      'default-checker',
    ]);
  });

  it('writes the whole block once and picks the blend by alphaMode', () => {
    const { fake, r } = setup();
    const m = createStandardMaterial(r, { alphaMode: 'blend' });
    expect(m.blend).toBe('alpha');
    const buffer = m.bindings!.uniformBuffer as unknown as FakeBuffer;
    const writes = fake.writes.filter((w) => w.buffer === buffer);
    expect(writes).toEqual([{ buffer, offset: 0, bytes: STANDARD_UNIFORM_FLOATS * 4 }]);
    expect(createStandardMaterial(r, { alphaMode: 'mask' }).blend).toBe('opaque');
    expect(createStandardMaterial(r, { alphaMode: 'opaque' }).blend).toBe('opaque');
    expect(fake.errors).toEqual([]);
  });
});

describe('packStandardUniforms', () => {
  it('fills the defaults', () => {
    expect([...packStandardUniforms({})]).toEqual([1, 1, 1, 1, 0, 0.5, 1, 0.5, 0, 0, 0, 0]);
  });

  it('packs factors and flags', () => {
    const out = packStandardUniforms({
      baseColorFactor: [0.1, 0.2, 0.3, 0.4],
      metallic: 0.6,
      roughness: 0.7,
      normalScale: 2,
      alphaCutoff: 0.3,
      emissiveFactor: [1, 2, 3],
      alphaMode: 'mask',
      doubleSided: true,
    });
    expect([...out].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 2, 0.3, 1, 2, 3, 3,
    ]);
    expect(packStandardUniforms({ alphaMode: 'blend', doubleSided: true })[11]).toBe(5);
  });

  it('defaults the emissive factor to 1 only when there is an emissive map', () => {
    const tex = { view: {} as GPUTextureView, width: 1, height: 1 };
    expect([...packStandardUniforms({ emissive: tex })].slice(8, 11)).toEqual([1, 1, 1]);
    expect([...packStandardUniforms({})].slice(8, 11)).toEqual([0, 0, 0]);
  });

  it('writes into a caller-owned block and rejects a short one', () => {
    const out = new Float32Array(STANDARD_UNIFORM_FLOATS);
    expect(packStandardUniforms({ metallic: 1 }, out)).toBe(out);
    expect(out[4]).toBe(1);
    expect(() => packStandardUniforms({}, new Float32Array(4))).toThrow();
  });
});
