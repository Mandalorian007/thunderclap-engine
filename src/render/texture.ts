import { generateMipmaps, type MipFilter } from './mipmap';

/** Anything with a sampleable view. */
export interface TextureLike {
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
}

export interface TextureDesc {
  width: number;
  height: number;
  /**
   * Array layers. When set (even to 1) the texture is a 2D array and its view is `'2d-array'`
   * (WGSL `texture_2d_array<f32>`); left out, it is a plain 2D texture.
   */
  layers?: number;
  /**
   * Allocate the full mip chain (`mipLevelCount(width, height)` levels). Level 0 is what uploads
   * write; `generateMipmaps(device, texture)` fills the rest.
   */
  mips?: boolean;
  format?: GPUTextureFormat;
  usage?: GPUTextureUsageFlags;
  label?: string;
}

/** Levels of a full mip chain for a `width × height` texture (1 for 1×1). */
export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/** Thin wrapper around a 2D (or 2D array) GPUTexture + default view. */
export class Texture implements TextureLike {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  /** Array layers (1 for a plain 2D texture). */
  readonly layers: number;
  /** Mip levels allocated (1 unless created with `mips: true`). */
  readonly mipLevels: number;
  /** The default view's dimension: `'2d-array'` when created with `layers`, else `'2d'`. */
  readonly viewDimension: '2d' | '2d-array';

  constructor(device: GPUDevice, desc: TextureDesc) {
    this.width = Math.max(1, Math.floor(desc.width));
    this.height = Math.max(1, Math.floor(desc.height));
    this.format = desc.format ?? 'rgba8unorm-srgb';
    const array = desc.layers !== undefined;
    this.layers = array ? Math.max(1, Math.floor(desc.layers ?? 1)) : 1;
    this.mipLevels = desc.mips ? mipLevelCount(this.width, this.height) : 1;
    this.viewDimension = array ? '2d-array' : '2d';
    this.texture = device.createTexture({
      label: desc.label,
      size: array ? [this.width, this.height, this.layers] : [this.width, this.height],
      format: this.format,
      ...(this.mipLevels > 1 ? { mipLevelCount: this.mipLevels } : {}),
      usage:
        desc.usage ??
        GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView(
      array ? { label: desc.label, dimension: '2d-array' } : { label: desc.label },
    );
  }

  destroy(): void {
    this.texture.destroy();
  }
}

/**
 * Sampler presets. The `-mip` kinds blend between mip levels (`mipmapFilter: 'linear'`):
 * `'linear-mip-repeat'` for tiling textures seen at a distance, `'nearest-mip-clamp'` for
 * pixel-art faces (crisp up close, no shimmer far away). Without mips they act like their
 * plain counterparts.
 */
export type SamplerKind =
  | 'linear-clamp'
  | 'linear-repeat'
  | 'nearest-clamp'
  | 'linear-mip-repeat'
  | 'nearest-mip-clamp';

export function createSamplers(device: GPUDevice): Record<SamplerKind, GPUSampler> {
  return {
    'linear-clamp': device.createSampler({
      label: 'linear-clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
    'linear-repeat': device.createSampler({
      label: 'linear-repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    }),
    'nearest-clamp': device.createSampler({
      label: 'nearest-clamp',
      magFilter: 'nearest',
      minFilter: 'nearest',
    }),
    'linear-mip-repeat': device.createSampler({
      label: 'linear-mip-repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    }),
    'nearest-mip-clamp': device.createSampler({
      label: 'nearest-mip-clamp',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
  };
}

export type TextureSource =
  | ImageBitmap
  | ImageData
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLImageElement;

/** Typed data accepted by `renderer.textureFromPixels` / `renderer.writePixels`. */
export type PixelData =
  | Uint8Array<ArrayBuffer>
  | Uint8ClampedArray<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>;

/** Tightly packed texels of one image (`ImageData` is one). */
export interface PixelSource {
  width: number;
  height: number;
  data: PixelData;
}

/** One layer of `loadTextureArray`: an image (copied on the GPU) or raw texels. */
export type TextureLayerSource = TextureSource | PixelSource;

/** A texture array whose layers the caller fills (`writeTexture` with `origin.z` = layer). */
export interface TextureArrayDesc {
  width: number;
  height: number;
  layers: number;
  /** Allocate the full mip chain (default false); fill it with `generateMipmaps`. */
  mips?: boolean;
  format?: GPUTextureFormat;
  usage?: GPUTextureUsageFlags;
  label?: string;
}

/** Create an empty `texture_2d_array` (`Texture.viewDimension === '2d-array'`). */
export function createTextureArray(device: GPUDevice, desc: TextureArrayDesc): Texture {
  return new Texture(device, desc);
}

export interface LoadTextureArrayOptions {
  /** Build the full mip chain on the GPU after upload (default true). */
  mips?: boolean;
  /** How each mip level is reduced from the one above (default `'linear'`, a 2×2 box). */
  mipFilter?: MipFilter;
  /**
   * Default `rgba8unorm-srgb` (colour). Image layers need an 8-bit RGBA/BGRA format; pixel
   * layers any format `bytesPerTexel` lists.
   */
  format?: GPUTextureFormat;
  label?: string;
}

function isPixels(s: TextureLayerSource): s is PixelSource {
  return 'data' in s && ArrayBuffer.isView((s as PixelSource).data);
}

/**
 * Upload `sources` to the layers of one `texture_2d_array`, in order: images through
 * `copyExternalImageToTexture`, pixel data (`ImageData` or `{ width, height, data }`) through
 * `writeTexture`. Every source must have the size of the first. With `mips` (default) the full
 * chain is allocated and generated on the GPU, layer by layer.
 */
export function loadTextureArray(
  device: GPUDevice,
  sources: readonly TextureLayerSource[],
  opts: LoadTextureArrayOptions = {},
): Texture {
  const first = sources[0];
  if (!first) throw new Error('loadTextureArray: no sources');
  const { width, height } = first;
  for (let i = 1; i < sources.length; i++) {
    const s = sources[i]!;
    if (s.width !== width || s.height !== height) {
      throw new Error(
        `loadTextureArray: layer ${i} is ${s.width}×${s.height}, layer 0 is ${width}×${height}`,
      );
    }
  }
  const format = opts.format ?? 'rgba8unorm-srgb';
  const mips = opts.mips ?? true;
  const tex = createTextureArray(device, {
    width,
    height,
    layers: sources.length,
    mips,
    format,
    label: opts.label ?? 'texture-array',
  });
  const texel = bytesPerTexel(format);
  sources.forEach((s, layer) => {
    if (isPixels(s)) {
      if (s.data.byteLength < width * height * texel) {
        throw new Error(`loadTextureArray: layer ${layer} has too few bytes for ${format}`);
      }
      device.queue.writeTexture(
        { texture: tex.texture, origin: [0, 0, layer] },
        s.data,
        { bytesPerRow: width * texel, rowsPerImage: height },
        [width, height, 1],
      );
    } else {
      device.queue.copyExternalImageToTexture(
        { source: s as Exclude<TextureSource, ImageData> },
        { texture: tex.texture, origin: [0, 0, layer] },
        [width, height, 1],
      );
    }
  });
  if (tex.mipLevels > 1) generateMipmaps(device, tex, { filter: opts.mipFilter });
  return tex;
}

const TEXEL_BYTES: Partial<Record<GPUTextureFormat, number>> = {
  r8unorm: 1,
  r8snorm: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  rgba8snorm: 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  r16float: 2,
  rg16float: 4,
  rgba16float: 8,
  r32float: 4,
  rg32float: 8,
  rgba32float: 16,
};

/** Bytes per texel for the uncompressed formats `textureFromPixels` supports. */
export function bytesPerTexel(format: GPUTextureFormat): number {
  const n = TEXEL_BYTES[format];
  if (!n) throw new Error(`bytesPerTexel: unsupported format ${format}`);
  return n;
}
