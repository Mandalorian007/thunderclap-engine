import { describe, expect, it } from 'vitest';
import { createFakeDevice } from './fake-gpu';
import { generateMipmaps } from './mipmap';
import { Texture } from './texture';

/** A fake device that also records view descriptors and pipelines. */
function recording() {
  const fake = createFakeDevice();
  const views: GPUTextureViewDescriptor[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const dev = fake.device as unknown as Record<string, unknown>;
  const createTexture = dev.createTexture as (d: GPUTextureDescriptor) => {
    createView(d?: GPUTextureViewDescriptor): unknown;
  };
  dev.createTexture = (d: GPUTextureDescriptor) => {
    const t = createTexture(d);
    const createView = t.createView;
    t.createView = (vd?: GPUTextureViewDescriptor) => {
      if (vd) views.push(vd);
      return createView(vd);
    };
    return t;
  };
  const createRenderPipeline = dev.createRenderPipeline as (
    d: GPURenderPipelineDescriptor,
  ) => unknown;
  dev.createRenderPipeline = (d: GPURenderPipelineDescriptor) => {
    pipelines.push(d);
    return createRenderPipeline(d);
  };
  return { fake, views, pipelines };
}

describe('generateMipmaps', () => {
  it('renders each level from the one above, layer by layer', () => {
    const { fake, views } = recording();
    const t = new Texture(fake.device, { width: 8, height: 8, layers: 2, mips: true, label: 'a' });
    generateMipmaps(fake.device, t);
    expect(t.mipLevels).toBe(4);
    const passes = fake.passes.filter((p) => p.label?.startsWith('mipmap:'));
    expect(passes.map((p) => p.label)).toEqual([
      'mipmap:1:0',
      'mipmap:2:0',
      'mipmap:3:0',
      'mipmap:1:1',
      'mipmap:2:1',
      'mipmap:3:1',
    ]);
    for (const p of passes) {
      expect(p.commands.map((c) => c.op)).toEqual(['setPipeline', 'setBindGroup', 'draw', 'other']);
    }
    // Single-level, single-layer 2D views: level 0 of each layer is read, every other level written.
    const mipViews = views.filter((v) => v.label?.startsWith('mipmap:'));
    expect(mipViews.map((v) => [v.baseMipLevel, v.baseArrayLayer])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    for (const v of mipViews) {
      expect(v).toMatchObject({ dimension: '2d', mipLevelCount: 1, arrayLayerCount: 1 });
    }
    expect(fake.errors).toEqual([]);
  });

  it('caches one pipeline per format and filter on each device', () => {
    const { fake, pipelines } = recording();
    const a = new Texture(fake.device, { width: 4, height: 4, mips: true });
    const b = new Texture(fake.device, { width: 4, height: 4, mips: true, format: 'rgba16float' });
    generateMipmaps(fake.device, a);
    generateMipmaps(fake.device, a);
    generateMipmaps(fake.device, b);
    generateMipmaps(fake.device, a, { filter: 'nearest' });
    expect(pipelines.map((p) => [p.label, p.fragment!.entryPoint])).toEqual([
      ['mipmap:rgba8unorm-srgb:linear', 'fs_linear'],
      ['mipmap:rgba16float:linear', 'fs_linear'],
      ['mipmap:rgba8unorm-srgb:nearest', 'fs_nearest'],
    ]);
    const other = recording();
    generateMipmaps(
      other.fake.device,
      new Texture(other.fake.device, { width: 2, height: 2, mips: true }),
    );
    expect(other.pipelines).toHaveLength(1);
  });

  it('leaves a single-level texture alone and rejects one it cannot render to', () => {
    const { fake } = recording();
    generateMipmaps(fake.device, new Texture(fake.device, { width: 4, height: 4 }));
    expect(fake.passes).toHaveLength(0);
    const sampledOnly = new Texture(fake.device, {
      width: 4,
      height: 4,
      mips: true,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'ro',
    });
    expect(() => generateMipmaps(fake.device, sampledOnly)).toThrow(/ro needs TEXTURE_BINDING/);
  });
});
