/** Anything with a sampleable view. */
export interface TextureLike {
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
}

export interface TextureDesc {
  width: number;
  height: number;
  format?: GPUTextureFormat;
  usage?: GPUTextureUsageFlags;
  label?: string;
}

/** Thin wrapper around a 2D GPUTexture + default view. */
export class Texture implements TextureLike {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;

  constructor(device: GPUDevice, desc: TextureDesc) {
    this.width = Math.max(1, Math.floor(desc.width));
    this.height = Math.max(1, Math.floor(desc.height));
    this.format = desc.format ?? 'rgba8unorm-srgb';
    this.texture = device.createTexture({
      label: desc.label,
      size: [this.width, this.height],
      format: this.format,
      usage:
        desc.usage ??
        GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView({ label: desc.label });
  }

  destroy(): void {
    this.texture.destroy();
  }
}

export type SamplerKind = 'linear-clamp' | 'linear-repeat' | 'nearest-clamp';

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
