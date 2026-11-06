import { describe, expect, it } from 'vitest';
import { BindingSet, createBindingLayout } from './bindings';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from './fake-gpu';
import { Renderer } from './renderer';
import {
  createSamplers,
  createTextureArray,
  defaultTextures,
  loadTexture,
  loadTextureArray,
  mipLevelCount,
  Texture,
} from './texture';

/** A fake device that also records texture and view descriptors. */
function recording() {
  const fake = createFakeDevice();
  const created: GPUTextureDescriptor[] = [];
  const views: (GPUTextureViewDescriptor | undefined)[] = [];
  const dev = fake.device as unknown as Record<string, unknown>;
  const createTexture = dev.createTexture as (d: GPUTextureDescriptor) => {
    createView(d?: GPUTextureViewDescriptor): unknown;
  };
  dev.createTexture = (d: GPUTextureDescriptor) => {
    created.push(d);
    const t = createTexture(d);
    const createView = t.createView;
    t.createView = (vd?: GPUTextureViewDescriptor) => {
      views.push(vd);
      return createView(vd);
    };
    return t;
  };
  const copies: { origin: unknown; size: unknown }[] = [];
  const queue = fake.device.queue as unknown as Record<string, unknown>;
  queue.copyExternalImageToTexture = (_src: unknown, dst: { origin?: unknown }, size: unknown) => {
    copies.push({ origin: dst.origin, size });
  };
  return { fake, created, views, copies };
}

const pixels = (w: number, h: number, v: number) => ({
  width: w,
  height: h,
  data: new Uint8Array(w * h * 4).fill(v),
});

describe('Texture', () => {
  it('stays a plain 2D texture without layers or mips', () => {
    const { fake, created, views } = recording();
    const t = new Texture(fake.device, { width: 8, height: 4 });
    expect(t.layers).toBe(1);
    expect(t.mipLevels).toBe(1);
    expect(t.viewDimension).toBe('2d');
    expect(created[0]!.size).toEqual([8, 4]);
    expect(created[0]!.mipLevelCount).toBeUndefined();
    expect(views[0]).toEqual({ label: undefined });
  });

  it('makes a 2d-array view when given layers, and a full chain with mips', () => {
    const { fake, created, views } = recording();
    const t = new Texture(fake.device, { width: 16, height: 8, layers: 3, mips: true });
    expect(t.layers).toBe(3);
    expect(t.mipLevels).toBe(5);
    expect(t.viewDimension).toBe('2d-array');
    expect(created[0]!.size).toEqual([16, 8, 3]);
    expect(created[0]!.mipLevelCount).toBe(5);
    expect(views[0]!.dimension).toBe('2d-array');
  });

  it('counts mip levels of a full chain', () => {
    expect(mipLevelCount(1, 1)).toBe(1);
    expect(mipLevelCount(16, 16)).toBe(5);
    expect(mipLevelCount(17, 3)).toBe(5);
    expect(mipLevelCount(1, 64)).toBe(7);
  });
});

describe('texture arrays', () => {
  it('createTextureArray makes an empty array without mips by default', () => {
    const { fake } = recording();
    const t = createTextureArray(fake.device, { width: 4, height: 4, layers: 2 });
    expect([t.layers, t.mipLevels, t.viewDimension]).toEqual([2, 1, '2d-array']);
  });

  it('loadTextureArray writes pixel layers at their z origin and generates mips', () => {
    const { fake, created } = recording();
    const t = loadTextureArray(fake.device, [pixels(4, 4, 1), pixels(4, 4, 2), pixels(4, 4, 3)], {
      label: 'blocks',
    });
    expect(fake.errors).toEqual([]);
    expect([t.width, t.height, t.layers, t.mipLevels]).toEqual([4, 4, 3, 3]);
    expect(created[0]).toMatchObject({
      size: [4, 4, 3],
      format: 'rgba8unorm-srgb',
      label: 'blocks',
    });
    const w = fake.textureWrites.filter((x) => x.texture.label === 'blocks');
    expect(w.map((x) => [x.bytesPerRow, x.size])).toEqual([
      [16, [4, 4, 1]],
      [16, [4, 4, 1]],
      [16, [4, 4, 1]],
    ]);
    // Two levels below level 0, for each of three layers.
    expect(fake.passes.filter((p) => p.label?.startsWith('mipmap:'))).toHaveLength(6);
  });

  it('copies image layers on the GPU', () => {
    const { fake, copies } = recording();
    const bmp = { width: 8, height: 8 } as unknown as ImageBitmap;
    const t = loadTextureArray(fake.device, [bmp, bmp], { mips: false });
    expect(t.mipLevels).toBe(1);
    expect(copies).toEqual([
      { origin: [0, 0, 0], size: [8, 8, 1] },
      { origin: [0, 0, 1], size: [8, 8, 1] },
    ]);
    expect(fake.passes).toHaveLength(0);
  });

  it('rejects mismatched sizes, empty lists and short data', () => {
    const { fake } = recording();
    expect(() => loadTextureArray(fake.device, [])).toThrow(/no sources/);
    expect(() => loadTextureArray(fake.device, [pixels(4, 4, 0), pixels(4, 2, 0)])).toThrow(
      /layer 1 is 4×2/,
    );
    const short = { width: 4, height: 4, data: new Uint8Array(8) };
    expect(() => loadTextureArray(fake.device, [short])).toThrow(/too few bytes/);
  });
});

describe('loadTexture', () => {
  it('creates a plain 2D texture with the full chain, writes level 0 and generates mips', () => {
    const { fake, created, views } = recording();
    const t = loadTexture(fake.device, pixels(8, 4, 5), { label: 'tile' });
    expect(fake.errors).toEqual([]);
    expect([t.width, t.height, t.layers, t.mipLevels, t.viewDimension]).toEqual([8, 4, 1, 4, '2d']);
    expect(created[0]).toMatchObject({
      size: [8, 4],
      mipLevelCount: 4,
      format: 'rgba8unorm-srgb',
      label: 'tile',
    });
    expect(views[0]).toEqual({ label: 'tile' });
    const w = fake.textureWrites.filter((x) => x.texture.label === 'tile');
    expect(w.map((x) => [x.bytesPerRow, x.size])).toEqual([[32, [8, 4, 1]]]);
    // Three levels below level 0.
    expect(fake.passes.filter((p) => p.label?.startsWith('mipmap:'))).toHaveLength(3);
  });

  it('gives a non-power-of-two source mipLevelCount levels', () => {
    const { fake } = recording();
    const t = loadTexture(fake.device, pixels(5, 3, 1));
    expect(t.mipLevels).toBe(mipLevelCount(5, 3));
    expect(t.mipLevels).toBe(3);
    expect(fake.passes.filter((p) => p.label?.startsWith('mipmap:'))).toHaveLength(2);
    expect(fake.errors).toEqual([]);
  });

  it('honours mips: false, format and filter', () => {
    const { fake, created } = recording();
    const t = loadTexture(fake.device, pixels(4, 4, 1), { mips: false, format: 'rgba8unorm' });
    expect(t.mipLevels).toBe(1);
    expect(created[0]!.mipLevelCount).toBeUndefined();
    expect(created[0]!.format).toBe('rgba8unorm');
    expect(fake.passes).toHaveLength(0);
    loadTexture(fake.device, pixels(4, 4, 1), { filter: 'nearest' });
    const nearest = fake.passes.filter((p) => p.label?.startsWith('mipmap:'));
    expect(nearest).toHaveLength(2);
    const pipeline = nearest[0]!.commands.find((c) => c.op === 'setPipeline') as {
      pipeline: { desc: { fragment: { entryPoint: string } } };
    };
    expect(pipeline.pipeline.desc.fragment.entryPoint).toBe('fs_nearest');
  });

  it('copies an image source on the GPU', () => {
    const { fake, copies } = recording();
    const bmp = { width: 16, height: 16 } as unknown as ImageBitmap;
    const t = loadTexture(fake.device, bmp);
    expect(t.mipLevels).toBe(5);
    expect(copies).toEqual([{ origin: [0, 0, 0], size: [16, 16, 1] }]);
  });

  it('rejects short pixel data', () => {
    const { fake } = recording();
    const short = { width: 4, height: 4, data: new Uint8Array(8) };
    expect(() => loadTexture(fake.device, short)).toThrow(/loadTexture: layer 0 has too few bytes/);
  });
});

describe('defaultTextures', () => {
  const bytes = (fake: FakeDevice, label: string) => {
    const w = fake.textureWrites.find((x) => x.texture.label === label)!;
    return Array.from(new Uint8Array(w.data as Uint8Array));
  };

  it('has the documented bytes, formats and sizes', () => {
    const fake = createFakeDevice();
    const d = defaultTextures(fake.device);
    expect(fake.errors).toEqual([]);
    expect(bytes(fake, 'default-white')).toEqual([255, 255, 255, 255]);
    expect(bytes(fake, 'default-black')).toEqual([0, 0, 0, 255]);
    expect(bytes(fake, 'default-flat-normal')).toEqual([128, 128, 255, 255]);
    expect(bytes(fake, 'default-metal-rough')).toEqual([255, 255, 0, 255]);
    expect([d.white.format, d.black.format, d.flatNormal.format, d.metalRough.format]).toEqual([
      'rgba8unorm-srgb',
      'rgba8unorm-srgb',
      'rgba8unorm',
      'rgba8unorm',
    ]);
    for (const t of [d.white, d.black, d.flatNormal, d.metalRough]) {
      expect([t.width, t.height, t.mipLevels, t.viewDimension]).toEqual([1, 1, 1, '2d']);
    }
    expect([d.checker.width, d.checker.height, d.checker.mipLevels]).toEqual([8, 8, 4]);
    const c = bytes(fake, 'default-checker');
    expect(c).toHaveLength(8 * 8 * 4);
    const texel = (x: number, y: number) => c.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4);
    expect(texel(0, 0)).toEqual([255, 0, 255, 255]);
    expect(texel(1, 1)).toEqual([255, 0, 255, 255]);
    expect(texel(2, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(0, 2)).toEqual([0, 0, 0, 255]);
    expect(texel(2, 2)).toEqual([255, 0, 255, 255]);
  });

  it('is cached per device', () => {
    const a = createFakeDevice();
    const b = createFakeDevice();
    const first = defaultTextures(a.device);
    expect(defaultTextures(a.device)).toBe(first);
    expect(first.white).toBe(defaultTextures(a.device).white);
    expect(a.textures.filter((t) => t.label === 'default-white')).toHaveLength(1);
    expect(defaultTextures(b.device)).not.toBe(first);
    expect(b.textures.filter((t) => t.label === 'default-white')).toHaveLength(1);
  });
});

describe('samplers', () => {
  it('offers mip-filtered kinds', () => {
    const fake = createFakeDevice();
    const calls: GPUSamplerDescriptor[] = [];
    const dev = fake.device as unknown as Record<string, unknown>;
    dev.createSampler = (d: GPUSamplerDescriptor) => {
      calls.push(d);
      return { label: d.label };
    };
    const s = createSamplers(fake.device);
    expect(Object.keys(s)).toContain('linear-mip-repeat');
    expect(calls.find((c) => c.label === 'linear-mip-repeat')).toMatchObject({
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
    });
    expect(calls.find((c) => c.label === 'nearest-mip-clamp')).toMatchObject({
      magFilter: 'nearest',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
    });
  });
});

describe('array bindings', () => {
  function setup(): { fake: FakeDevice; r: Renderer } {
    const fake = createFakeDevice();
    return { fake, r: new Renderer(fakeRendererGpu(fake)) };
  }

  it('declares texture_2d_array slots through viewDimension', () => {
    const fake = createFakeDevice();
    const layout = createBindingLayout(
      fake.device,
      { textures: 2, viewDimension: ['2d', '2d-array'] },
      'l',
    ) as unknown as { entries: GPUBindGroupLayoutEntry[] };
    expect(layout.entries.map((e) => e.texture)).toEqual([
      undefined,
      { sampleType: 'float' },
      { sampleType: 'float', viewDimension: '2d-array' },
    ]);
  });

  it('a material samples a texture array, and an unbound array slot reads a white array', () => {
    const { fake, r } = setup();
    const m = r.createMaterial({
      label: 'blocks',
      wgsl: '@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; return o; }',
      textures: 1,
      sampler: 'nearest-mip-clamp',
      viewDimension: '2d-array',
    });
    const before = m.bindings!.createGroup() as unknown as { entries: GPUBindGroupEntry[] };
    const white = before.entries[1]!.resource as unknown as { texture: { label?: string } };
    expect(white.texture.label).toBe('white-array');
    const arr = loadTextureArray(r.device, [pixels(2, 2, 9), pixels(2, 2, 7)], { label: 'arr' });
    m.setTexture(0, arr);
    const g = m.bindings!.bindGroup as unknown as { entries: GPUBindGroupEntry[] };
    expect(g.entries[1]!.resource).toBe(arr.view);
    expect(g.entries[0]!.resource).toBe(r.samplers['nearest-mip-clamp']);
    expect(fake.errors).toEqual([]);
  });

  it('shares one white array per device', () => {
    const fake = createFakeDevice();
    const white = new Texture(fake.device, { width: 1, height: 1 });
    const s = createSamplers(fake.device)['linear-clamp'];
    const a = new BindingSet(
      fake.device,
      { textures: 1, viewDimension: '2d-array' },
      s,
      white.view,
      'a',
    );
    const b = new BindingSet(
      fake.device,
      { textures: 1, viewDimension: '2d-array' },
      s,
      white.view,
      'b',
    );
    a.createGroup();
    b.createGroup();
    expect(fake.textures.filter((t) => t.label === 'white-array')).toHaveLength(1);
  });
});
