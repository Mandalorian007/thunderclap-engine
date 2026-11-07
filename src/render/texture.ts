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
  /** Allocate exactly this many mip levels (overrides `mips`): a file's own chain (KTX2). */
  mipLevelCount?: number;
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
    this.mipLevels =
      desc.mipLevelCount !== undefined
        ? Math.max(1, Math.floor(desc.mipLevelCount))
        : desc.mips
          ? mipLevelCount(this.width, this.height)
          : 1;
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
 * pixel-art faces (crisp up close, no shimmer far away), `'nearest-mip-repeat'` for pixel-art
 * faces tiled across a quad (block faces whose uv spans whole cells). Without mips they act
 * like their plain counterparts.
 */
export type SamplerKind =
  | 'linear-clamp'
  | 'linear-repeat'
  | 'nearest-clamp'
  | 'linear-mip-repeat'
  | 'nearest-mip-clamp'
  | 'nearest-mip-repeat';

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
    'nearest-mip-repeat': device.createSampler({
      label: 'nearest-mip-repeat',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
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
  filter?: MipFilter;
  /** @deprecated Use `filter` (ws/render-4); read when `filter` is absent. */
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
  sources.forEach((s, layer) => {
    uploadLayer(device, tex, s, layer, 'loadTextureArray');
  });
  if (tex.mipLevels > 1) generateMipmaps(device, tex, { filter: opts.filter ?? opts.mipFilter });
  return tex;
}

/** Write `source` into level 0, layer `layer` of `tex` (`writeTexture` for pixels, a GPU copy for images). */
function uploadLayer(
  device: GPUDevice,
  tex: Texture,
  source: TextureLayerSource,
  layer: number,
  who: string,
): void {
  const { width, height } = tex;
  if (isPixels(source)) {
    const texel = bytesPerTexel(tex.format);
    if (source.data.byteLength < width * height * texel) {
      throw new Error(`${who}: layer ${layer} has too few bytes for ${tex.format}`);
    }
    device.queue.writeTexture(
      { texture: tex.texture, origin: [0, 0, layer] },
      source.data,
      { bytesPerRow: width * texel, rowsPerImage: height },
      [width, height, 1],
    );
  } else {
    device.queue.copyExternalImageToTexture(
      { source: source as Exclude<TextureSource, ImageData> },
      { texture: tex.texture, origin: [0, 0, layer] },
      [width, height, 1],
    );
  }
}

export interface LoadTextureOptions {
  /** Build the full mip chain on the GPU after upload (default true; a 1×1 source has one level). */
  mips?: boolean;
  /** How each mip level is reduced from the one above (default `'linear'`, a 2×2 box). */
  filter?: MipFilter;
  /**
   * Default `rgba8unorm-srgb` (colour). An image source needs an 8-bit RGBA/BGRA format; a pixel
   * source any format `bytesPerTexel` lists. Data such as normal maps wants `rgba8unorm`.
   */
  format?: GPUTextureFormat;
  label?: string;
}

/**
 * One call for a single 2D texture: create it, upload `source` (an image through
 * `copyExternalImageToTexture`, `ImageData` or `{ width, height, data }` through `writeTexture`)
 * as level 0 and, with `mips` (default), allocate the full chain and fill it with
 * `generateMipmaps`. Non-power-of-two sizes get `mipLevelCount(width, height)` levels too.
 * Allocates; call it at load time.
 */
export function loadTexture(
  device: GPUDevice,
  source: TextureLayerSource,
  opts: LoadTextureOptions = {},
): Texture {
  const tex = new Texture(device, {
    width: source.width,
    height: source.height,
    mips: opts.mips ?? true,
    format: opts.format ?? 'rgba8unorm-srgb',
    label: opts.label ?? 'texture',
  });
  uploadLayer(device, tex, source, 0, 'loadTexture');
  if (tex.mipLevels > 1) generateMipmaps(device, tex, { filter: opts.filter });
  return tex;
}

/**
 * Textures a material slot can read when the game sets nothing: one set per device, created on
 * first use by `defaultTextures(device)` and alive as long as the device.
 */
export interface DefaultTextures {
  /** 1×1 `(255, 255, 255, 255)`, sRGB: a colour map that changes nothing. The unset-slot default. */
  readonly white: Texture;
  /** 1×1 `(0, 0, 0, 255)`, sRGB: no emissive, no light. */
  readonly black: Texture;
  /** 1×1 `(128, 128, 255, 255)`, linear: a tangent-space normal map that keeps the mesh normal. */
  readonly flatNormal: Texture;
  /**
   * 1×1 `(255, 255, 0, 255)`, linear, in the glTF channel layout (G roughness, B metallic):
   * a dielectric, fully rough surface (metallic 0, roughness 1).
   */
  readonly metalRough: Texture;
  /**
   * 8×8 sRGB checker of 2×2-texel magenta `(255, 0, 255)` and black squares, mipmapped: bind it
   * where a texture failed to load so the gap is visible.
   */
  readonly checker: Texture;
}

const DEFAULT_TEXTURES = new WeakMap<GPUDevice, DefaultTextures>();

function solid(
  device: GPUDevice,
  rgba: [number, number, number, number],
  opts: LoadTextureOptions,
) {
  return loadTexture(device, { width: 1, height: 1, data: new Uint8Array(rgba) }, opts);
}

/** The device's `DefaultTextures`, made on first call and cached (a `WeakMap` keyed by device). */
export function defaultTextures(device: GPUDevice): DefaultTextures {
  let set = DEFAULT_TEXTURES.get(device);
  if (set) return set;
  const checker = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const on = ((x >> 1) + (y >> 1)) % 2 === 0;
      const o = (y * 8 + x) * 4;
      checker[o] = on ? 255 : 0;
      checker[o + 1] = 0;
      checker[o + 2] = on ? 255 : 0;
      checker[o + 3] = 255;
    }
  }
  set = {
    white: solid(device, [255, 255, 255, 255], { label: 'default-white' }),
    black: solid(device, [0, 0, 0, 255], { label: 'default-black' }),
    flatNormal: solid(device, [128, 128, 255, 255], {
      label: 'default-flat-normal',
      format: 'rgba8unorm',
    }),
    metalRough: solid(device, [255, 255, 0, 255], {
      label: 'default-metal-rough',
      format: 'rgba8unorm',
    }),
    checker: loadTexture(
      device,
      { width: 8, height: 8, data: checker },
      { label: 'default-checker' },
    ),
  };
  DEFAULT_TEXTURES.set(device, set);
  return set;
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
