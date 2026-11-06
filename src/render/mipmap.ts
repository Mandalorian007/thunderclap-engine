import type { Texture } from './texture';

/** How `generateMipmaps` reduces a level: `'linear'` averages each 2×2 block, `'nearest'` keeps its top-left texel. */
export type MipFilter = 'linear' | 'nearest';

export interface GenerateMipmapsOptions {
  /** Default `'linear'`. */
  filter?: MipFilter;
}

/**
 * Fullscreen triangle; the fragment shader reads the level above with `textureLoad` (so any
 * float format works, filterable or not) at twice its own pixel, clamped to the source size.
 */
const MIPMAP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn at(p: vec2i) -> vec4f {
  let last = vec2i(textureDimensions(src)) - 1;
  return textureLoad(src, min(p, last), 0);
}

@fragment fn fs_linear(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(floor(pos.xy)) * 2;
  return 0.25 * (at(p) + at(p + vec2i(1, 0)) + at(p + vec2i(0, 1)) + at(p + vec2i(1, 1)));
}

@fragment fn fs_nearest(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return at(vec2i(floor(pos.xy)) * 2);
}
`;

interface MipmapKit {
  module: GPUShaderModule;
  layout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  /** Keyed `format:filter`. */
  pipelines: Map<string, GPURenderPipeline>;
}

const kits = new WeakMap<GPUDevice, MipmapKit>();

function kitFor(device: GPUDevice): MipmapKit {
  let kit = kits.get(device);
  if (!kit) {
    const layout = device.createBindGroupLayout({
      label: 'mipmap-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    });
    kit = {
      module: device.createShaderModule({ label: 'mipmap', code: MIPMAP_WGSL }),
      layout,
      pipelineLayout: device.createPipelineLayout({
        label: 'mipmap-pipeline-layout',
        bindGroupLayouts: [layout],
      }),
      pipelines: new Map(),
    };
    kits.set(device, kit);
  }
  return kit;
}

/** The blit pipeline for `format` and `filter`: built once per device, then cached. */
function pipelineFor(device: GPUDevice, format: GPUTextureFormat, filter: MipFilter) {
  const kit = kitFor(device);
  const key = `${format}:${filter}`;
  let pipeline = kit.pipelines.get(key);
  if (!pipeline) {
    pipeline = device.createRenderPipeline({
      label: `mipmap:${key}`,
      layout: kit.pipelineLayout,
      vertex: { module: kit.module, entryPoint: 'vs' },
      fragment: {
        module: kit.module,
        entryPoint: filter === 'nearest' ? 'fs_nearest' : 'fs_linear',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });
    kit.pipelines.set(key, pipeline);
  }
  return { pipeline, layout: kit.layout };
}

/**
 * Fill mip levels 1..`mipLevels - 1` of `texture` from level 0 on the GPU, each level rendered
 * from the one above by a tiny blit pipeline (one per format and filter, cached per device).
 * Arrays are handled layer by layer. The texture needs `TEXTURE_BINDING | RENDER_ATTACHMENT`
 * usage and a renderable float format (e.g. `rgba8unorm`, `rgba8unorm-srgb`, `rgba16float`);
 * sRGB textures average in linear space. One command buffer is submitted; a texture with one
 * level is left as it is. Creation-time work: it allocates views and bind groups.
 */
export function generateMipmaps(
  device: GPUDevice,
  texture: Texture,
  opts: GenerateMipmapsOptions = {},
): void {
  if (texture.mipLevels <= 1) return;
  const need = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
  if ((texture.texture.usage & need) !== need) {
    throw new Error(
      `generateMipmaps: ${texture.texture.label || 'texture'} needs TEXTURE_BINDING | RENDER_ATTACHMENT usage`,
    );
  }
  const { pipeline, layout } = pipelineFor(device, texture.format, opts.filter ?? 'linear');
  const encoder = device.createCommandEncoder({ label: 'mipmap' });
  const view = (level: number, layer: number) =>
    texture.texture.createView({
      label: `mipmap:${level}:${layer}`,
      dimension: '2d',
      baseMipLevel: level,
      mipLevelCount: 1,
      baseArrayLayer: layer,
      arrayLayerCount: 1,
    });
  for (let layer = 0; layer < texture.layers; layer++) {
    let src = view(0, layer);
    for (let level = 1; level < texture.mipLevels; level++) {
      const dst = view(level, layer);
      const group = device.createBindGroup({
        label: `mipmap:${level}:${layer}`,
        layout,
        entries: [{ binding: 0, resource: src }],
      });
      const pass = encoder.beginRenderPass({
        label: `mipmap:${level}:${layer}`,
        colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      src = dst;
    }
  }
  device.queue.submit([encoder.finish()]);
}
