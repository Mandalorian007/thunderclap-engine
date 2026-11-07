/**
 * Block-compressed textures (ws/render-5): which compression families the device has
 * (`RendererCaps`), the features to ask an adapter for, and `uploadKtx2`, which puts a parsed
 * KTX2 file (`@thunderclap/engine/assets` `parseKtx2`) on the GPU in its own format, every mip
 * level written with its block-aligned row pitch. No transcoder: a Basis Universal (BasisLZ /
 * UASTC) or supercompressed payload, or a format the device lacks, throws
 * `CompressedTextureError`.
 */
import { type Ktx2Texture, ktx2ToWebGpuFormat } from '../assets/ktx2';
import { Texture } from './texture';

/** A block-compression feature family. */
export type CompressionFamily = 'bc' | 'etc2' | 'astc';

/** The WebGPU feature of each family. */
export const COMPRESSION_FEATURES: Readonly<Record<CompressionFamily, GPUFeatureName>> = {
  bc: 'texture-compression-bc',
  etc2: 'texture-compression-etc2',
  astc: 'texture-compression-astc',
};

/** What the renderer's device can do beyond core WebGPU (`renderer.caps`). */
export interface RendererCaps {
  /** The compressed texture families the device was created with. */
  readonly compressed: Readonly<Record<CompressionFamily, boolean>>;
}

/** Anything with a feature set: a `GPUAdapter` or a `GPUDevice`. */
interface HasFeatures {
  readonly features?: { has(name: string): boolean };
}

/**
 * The compression features `adapter` offers, to spread into `requestDevice`'s
 * `requiredFeatures` (a device only gets the features it asks for):
 * `adapter.requestDevice({ requiredFeatures: [...compressionFeatures(adapter)] })`.
 */
export function compressionFeatures(adapter: HasFeatures): GPUFeatureName[] {
  const out: GPUFeatureName[] = [];
  const f = adapter.features;
  if (!f || typeof f.has !== 'function') return out;
  for (const k of ['bc', 'etc2', 'astc'] as const) {
    if (f.has(COMPRESSION_FEATURES[k])) out.push(COMPRESSION_FEATURES[k]);
  }
  return out;
}

/** The caps of `device`, read from its features (none on a device without a feature set). */
export function rendererCaps(device: HasFeatures): RendererCaps {
  const f = device.features;
  const has = (k: CompressionFamily) =>
    !!f && typeof f.has === 'function' && f.has(COMPRESSION_FEATURES[k]);
  return { compressed: { bc: has('bc'), etc2: has('etc2'), astc: has('astc') } };
}

/** Why `uploadKtx2` could not upload a file: names the format and the device's caps. */
export class CompressedTextureError extends Error {
  /** The file's WebGPU format, or `vk:<VkFormat>` when WebGPU has none. */
  readonly format: string;
  /** The family the format needs, or null (no WebGPU twin, or a payload to transcode). */
  readonly family: CompressionFamily | null;
  readonly caps: RendererCaps;
  constructor(
    message: string,
    format: string,
    family: CompressionFamily | null,
    caps: RendererCaps,
  ) {
    super(message);
    this.name = 'CompressedTextureError';
    this.format = format;
    this.family = family;
    this.caps = caps;
  }
}

/** Block footprint of a format: texels per block in x and y, and bytes per block. */
export interface BlockInfo {
  width: number;
  height: number;
  bytes: number;
  /** The feature family it needs, or null for an uncompressed format. */
  family: CompressionFamily | null;
}

const PLAIN_BYTES: Partial<Record<string, number>> = {
  r8unorm: 1,
  r8snorm: 1,
  r8uint: 1,
  r8sint: 1,
  rg8unorm: 2,
  rg8snorm: 2,
  rg8uint: 2,
  rg8sint: 2,
  r16uint: 2,
  r16sint: 2,
  r16float: 2,
  depth16unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  rgba8snorm: 4,
  rgba8uint: 4,
  rgba8sint: 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgb10a2unorm: 4,
  rg11b10ufloat: 4,
  rgb9e5ufloat: 4,
  rg16uint: 4,
  rg16sint: 4,
  rg16float: 4,
  r32uint: 4,
  r32sint: 4,
  r32float: 4,
  depth32float: 4,
  rgba16uint: 8,
  rgba16sint: 8,
  rgba16float: 8,
  rg32uint: 8,
  rg32sint: 8,
  rg32float: 8,
  rgba32uint: 16,
  rgba32sint: 16,
  rgba32float: 16,
};

/**
 * The block footprint of `format`: 4×4 blocks of 8 bytes (BC1, BC4, ETC2 RGB8 / RGB8A1, EAC
 * R11) or 16 (BC2/3/5/6H/7, ETC2 RGBA8, EAC RG11), ASTC's W×H blocks of 16 bytes, and 1×1
 * "blocks" of a texel for the uncompressed formats. Null for a format it does not know.
 */
export function blockInfo(format: GPUTextureFormat): BlockInfo | null {
  const f = format as string;
  if (f.startsWith('bc')) {
    const eight = f.startsWith('bc1-') || f.startsWith('bc4-');
    return { width: 4, height: 4, bytes: eight ? 8 : 16, family: 'bc' };
  }
  if (f.startsWith('etc2-')) {
    return { width: 4, height: 4, bytes: f.startsWith('etc2-rgba8') ? 16 : 8, family: 'etc2' };
  }
  if (f.startsWith('eac-')) {
    return { width: 4, height: 4, bytes: f.startsWith('eac-rg11') ? 16 : 8, family: 'etc2' };
  }
  if (f.startsWith('astc-')) {
    const m = /^astc-(\d+)x(\d+)-/.exec(f);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]), bytes: 16, family: 'astc' };
  }
  const n = PLAIN_BYTES[f];
  return n ? { width: 1, height: 1, bytes: n, family: null } : null;
}

/** `format` in sRGB (`srgb` true) or linear (false) form, when it has that twin. */
function withColorSpace(format: GPUTextureFormat, srgb: boolean | undefined): GPUTextureFormat {
  if (srgb === undefined) return format;
  const f = format as string;
  if (srgb) {
    if (f.endsWith('-srgb')) return format;
    const twin = `${f}-srgb`;
    return SRGB_TWINS.has(twin) ? (twin as GPUTextureFormat) : format;
  }
  return (f.endsWith('-srgb') ? f.slice(0, -5) : f) as GPUTextureFormat;
}

/** The formats that have an `-srgb` form. */
const SRGB_TWINS = new Set<string>([
  'rgba8unorm-srgb',
  'bgra8unorm-srgb',
  'bc1-rgba-unorm-srgb',
  'bc2-rgba-unorm-srgb',
  'bc3-rgba-unorm-srgb',
  'bc7-rgba-unorm-srgb',
  'etc2-rgb8unorm-srgb',
  'etc2-rgb8a1unorm-srgb',
  'etc2-rgba8unorm-srgb',
  ...[
    '4x4',
    '5x4',
    '5x5',
    '6x5',
    '6x6',
    '8x5',
    '8x6',
    '8x8',
    '10x5',
    '10x6',
    '10x8',
    '10x10',
    '12x10',
    '12x12',
  ].map((s) => `astc-${s}-unorm-srgb`),
]);

/** Options of `uploadKtx2`. */
export interface UploadKtx2Options {
  /**
   * Upload as the sRGB (true) or linear (false) twin of the file's format, when it has one: a
   * colour map stored as `bc7-rgba-unorm` reads as `bc7-rgba-unorm-srgb` with `srgb: true`.
   * Default: the file's own format.
   */
  srgb?: boolean;
  /** Texture label. Default `'ktx2'`. */
  label?: string;
}

/** What `uploadKtx2` needs of a renderer: its device and caps. */
export interface CompressedUploadTarget {
  readonly device: GPUDevice;
  readonly caps: RendererCaps;
}

/** One level's copy: its block-aligned pitch, rows and copy extent (`ktx2LevelLayout`). */
export interface Ktx2LevelLayout {
  bytesPerRow: number;
  rowsPerImage: number;
  /** The copy extent in texels: the level's size rounded up to whole blocks. */
  width: number;
  height: number;
  /** Bytes one image (layer or face) of the level holds. */
  imageBytes: number;
}

/**
 * The copy layout of mip level `level` of a `width × height` texture in blocks of `block`:
 * `bytesPerRow = ceil(w / bw) · blockBytes`, `rowsPerImage = ceil(h / bh)`, the extent rounded up
 * to whole blocks (a 2×2 mip of a BC texture is copied as one 4×4 block).
 */
export function ktx2LevelLayout(
  width: number,
  height: number,
  level: number,
  block: BlockInfo,
): Ktx2LevelLayout {
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  const bx = Math.ceil(w / block.width);
  const by = Math.ceil(h / block.height);
  const bytesPerRow = bx * block.bytes;
  return {
    bytesPerRow,
    rowsPerImage: by,
    width: bx * block.width,
    height: by * block.height,
    imageBytes: bytesPerRow * by,
  };
}

/**
 * Upload a parsed KTX2 file as a `Texture` in its own format (`ktx2ToWebGpuFormat`, through
 * `opts.srgb`'s colour space): a 2D texture, or a 2D array for a file with layers or cube faces
 * (layer-major, faces within). Every level the file carries is written with
 * `queue.writeTexture` at its block-aligned `bytesPerRow` (`ktx2LevelLayout`); the texture has
 * exactly that many mips. The result binds anywhere a `TextureLike` does (a standard
 * material's map).
 *
 * Throws `CompressedTextureError` when the payload needs a transcoder (BasisLZ, UASTC,
 * `vkFormat` 0, or Zstd / ZLIB supercompression: none is bundled), when WebGPU has no such
 * format, or when the device lacks the format's family (`renderer.caps.compressed`; the
 * message names the format and the caps). Throws `Error` for a 3D texture, a block-compressed
 * level 0 that is not whole blocks, or a level shorter than its layout.
 */
export function uploadKtx2(
  renderer: CompressedUploadTarget,
  ktx2: Ktx2Texture,
  opts: UploadKtx2Options = {},
): Texture {
  const caps = renderer.caps;
  const capsText = () => {
    const c = caps.compressed;
    const on = (['bc', 'etc2', 'astc'] as const).filter((k) => c[k]);
    return on.length ? on.join(', ') : 'none';
  };
  if (ktx2.supercompression !== 'none' || ktx2.vkFormat === 0 || ktx2.levels.length === 0) {
    const what = ktx2.supercompression !== 'none' ? ktx2.supercompression : 'basis';
    throw new CompressedTextureError(
      `uploadKtx2: the ${what} payload needs a transcoder (none is bundled); compressed caps: ${capsText()}`,
      `vk:${ktx2.vkFormat}`,
      null,
      caps,
    );
  }
  const fileFormat = ktx2ToWebGpuFormat(ktx2.vkFormat);
  if (!fileFormat) {
    throw new CompressedTextureError(
      `uploadKtx2: VkFormat ${ktx2.vkFormat} has no WebGPU format; compressed caps: ${capsText()}`,
      `vk:${ktx2.vkFormat}`,
      null,
      caps,
    );
  }
  const format = withColorSpace(fileFormat, opts.srgb);
  const block = blockInfo(format);
  if (!block) {
    throw new CompressedTextureError(
      `uploadKtx2: format ${format} is not uploadable; compressed caps: ${capsText()}`,
      format,
      null,
      caps,
    );
  }
  if (block.family && !caps.compressed[block.family]) {
    throw new CompressedTextureError(
      `uploadKtx2: format ${format} needs ${COMPRESSION_FEATURES[block.family]}, which the device lacks; compressed caps: ${capsText()}`,
      format,
      block.family,
      caps,
    );
  }
  if (ktx2.depth > 1) throw new Error('uploadKtx2: 3D textures are not supported');
  const width = Math.max(1, ktx2.width);
  const height = Math.max(1, ktx2.height);
  if (width % block.width !== 0 || height % block.height !== 0) {
    throw new Error(
      `uploadKtx2: ${width}×${height} is not whole ${block.width}×${block.height} blocks of ${format}`,
    );
  }
  const images = Math.max(1, ktx2.layers) * Math.max(1, ktx2.faces);
  const array = ktx2.layers > 0 || ktx2.faces > 1;
  const levels = ktx2.levels;
  const tex = new Texture(renderer.device, {
    width,
    height,
    ...(array ? { layers: images } : {}),
    mipLevelCount: levels.length,
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    label: opts.label ?? 'ktx2',
  });
  const queue = renderer.device.queue;
  for (let i = 0; i < levels.length; i++) {
    const lv = ktx2LevelLayout(width, height, i, block);
    const bytes = levels[i]!.bytes;
    const need = lv.imageBytes * images;
    if (bytes.byteLength < need) {
      tex.destroy();
      throw new Error(`uploadKtx2: level ${i} holds ${bytes.byteLength} bytes, needs ${need}`);
    }
    queue.writeTexture(
      { texture: tex.texture, mipLevel: i },
      bytes,
      { offset: 0, bytesPerRow: lv.bytesPerRow, rowsPerImage: lv.rowsPerImage },
      [lv.width, lv.height, images],
    );
  }
  return tex;
}
