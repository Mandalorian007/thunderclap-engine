/**
 * KTX2 container reader: header, level index and the basic data format descriptor of a
 * `.ktx2` file, each mip level as a view into the file's bytes (nothing copied). It reads the
 * container only: Zstd / ZLIB-supercompressed levels and BasisLZ / UASTC Basis payloads are
 * detected and reported (`supercompression`, no `levels`), not decoded, and nothing is
 * uploaded (that needs a compressed-format texture path in `render`).
 *
 * `ktx2ToWebGpuFormat(vkFormat)` names the WebGPU format a level's bytes are in, when there is
 * one (BC needs the `texture-compression-bc` device feature, ETC2 / EAC `-etc2`, ASTC `-astc`).
 */

/** Malformed or truncated KTX2 data. */
export class Ktx2Error extends Error {
  constructor(message: string) {
    super(`ktx2: ${message}`);
    this.name = 'Ktx2Error';
  }
}

/** `supercompressionScheme`: how the levels are packed on top of `vkFormat`. */
export type Ktx2Supercompression = 'none' | 'basislz' | 'zstd' | 'zlib';

/** One mip level: its bytes (a view into the file) and its size in texels. */
export interface Ktx2Level {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** The basic data format descriptor's colour fields (Khronos Data Format spec). */
export interface Ktx2DataFormat {
  /** `KHR_DF_MODEL_*`: 1 RGBSDA, 128+ block-compressed (BC1 128, BC7 135, ETC2 161, ASTC 162), 166 UASTC, 163 ETC1S. */
  colorModel: number;
  /** `KHR_DF_PRIMARIES_*`: 1 BT.709 / sRGB. */
  colorPrimaries: number;
  /** `KHR_DF_TRANSFER_*`: 1 linear, 2 sRGB. */
  transferFunction: number;
  /** `KHR_DF_FLAG_*`: bit 0 premultiplied alpha. */
  flags: number;
}

/** A parsed KTX2 file. */
export interface Ktx2Texture {
  /** The Vulkan `VkFormat` of the level data (0 `VK_FORMAT_UNDEFINED` for Basis payloads). */
  vkFormat: number;
  /** Bytes per component for uncompressed formats (1 for block-compressed ones). */
  typeSize: number;
  width: number;
  /** 0 for a 1D texture. */
  height: number;
  /** 0 for a 1D or 2D texture. */
  depth: number;
  /** 0 when the texture is not an array. */
  layers: number;
  /** 6 for a cube map, else 1. */
  faces: number;
  /**
   * Mip levels, largest first; each holds every layer and face of that level. Empty when
   * `supercompression` is not `'none'` (the payload needs a decoder this reader does not have).
   */
  levels: Ktx2Level[];
  /** How many levels the file says it has (1 when it asks the reader to generate mips). */
  levelCount: number;
  /** The basic descriptor's colour fields, or null when the file has none. */
  dataFormat: Ktx2DataFormat | null;
  supercompression: Ktx2Supercompression;
}

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_BYTES = 80;
const LEVEL_INDEX_BYTES = 24;
const SCHEMES: readonly Ktx2Supercompression[] = ['none', 'basislz', 'zstd', 'zlib'];

/** True when `bytes` starts with the KTX2 identifier. */
export function isKtx2(bytes: Uint8Array): boolean {
  if (bytes.byteLength < IDENTIFIER.length) return false;
  for (let i = 0; i < IDENTIFIER.length; i++) if (bytes[i] !== IDENTIFIER[i]) return false;
  return true;
}

/**
 * Read a KTX2 file's header, data format and levels. Throws `Ktx2Error` for a bad identifier,
 * a truncated file or a level that runs past the end.
 */
export function parseKtx2(bytes: Uint8Array): Ktx2Texture {
  if (!isKtx2(bytes)) throw new Ktx2Error('not a KTX2 file (bad identifier)');
  if (bytes.byteLength < HEADER_BYTES) throw new Ktx2Error('truncated header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => dv.getUint32(at, true);
  const u64 = (at: number) => {
    const hi = dv.getUint32(at + 4, true);
    if (hi !== 0) throw new Ktx2Error(`offset at byte ${at} does not fit in 32 bits`);
    return dv.getUint32(at, true);
  };
  const vkFormat = u32(12);
  const typeSize = u32(16);
  const width = u32(20);
  const height = u32(24);
  const depth = u32(28);
  const layers = u32(32);
  const faces = u32(36);
  const levelCount = Math.max(1, u32(40));
  const scheme = u32(44);
  const supercompression = SCHEMES[scheme];
  if (!supercompression) throw new Ktx2Error(`supercompression scheme ${scheme} unknown`);
  if (width === 0) throw new Ktx2Error('pixelWidth is 0');
  if (faces !== 1 && faces !== 6) throw new Ktx2Error(`faceCount ${faces} must be 1 or 6`);
  const dfdOffset = u32(48);
  const dfdLength = u32(52);
  if (HEADER_BYTES + levelCount * LEVEL_INDEX_BYTES > bytes.byteLength) {
    throw new Ktx2Error('truncated level index');
  }

  let dataFormat: Ktx2DataFormat | null = null;
  // DFD: u32 total size, then the basic block: two u32 words, then the colour bytes.
  if (dfdLength >= 16) {
    if (dfdOffset + dfdLength > bytes.byteLength)
      throw new Ktx2Error('data format runs past the end');
    dataFormat = {
      colorModel: bytes[dfdOffset + 12]!,
      colorPrimaries: bytes[dfdOffset + 13]!,
      transferFunction: bytes[dfdOffset + 14]!,
      flags: bytes[dfdOffset + 15]!,
    };
  }

  const levels: Ktx2Level[] = [];
  if (supercompression === 'none') {
    for (let i = 0; i < levelCount; i++) {
      const at = HEADER_BYTES + i * LEVEL_INDEX_BYTES;
      const off = u64(at);
      const len = u64(at + 8);
      if (off + len > bytes.byteLength) throw new Ktx2Error(`level ${i} runs past the end`);
      levels.push({
        bytes: bytes.subarray(off, off + len),
        width: Math.max(1, width >> i),
        height: Math.max(1, height >> i),
      });
    }
  }
  return {
    vkFormat,
    typeSize,
    width,
    height,
    depth,
    layers,
    faces,
    levels,
    levelCount,
    dataFormat,
    supercompression,
  };
}

/** Uncompressed and packed `VkFormat`s with a WebGPU twin. */
const PLAIN_FORMATS: Record<number, GPUTextureFormat> = {
  9: 'r8unorm',
  10: 'r8snorm',
  13: 'r8uint',
  14: 'r8sint',
  16: 'rg8unorm',
  17: 'rg8snorm',
  20: 'rg8uint',
  21: 'rg8sint',
  37: 'rgba8unorm',
  38: 'rgba8snorm',
  41: 'rgba8uint',
  42: 'rgba8sint',
  43: 'rgba8unorm-srgb',
  44: 'bgra8unorm',
  50: 'bgra8unorm-srgb',
  64: 'rgb10a2unorm',
  74: 'r16uint',
  75: 'r16sint',
  76: 'r16float',
  81: 'rg16uint',
  82: 'rg16sint',
  83: 'rg16float',
  95: 'rgba16uint',
  96: 'rgba16sint',
  97: 'rgba16float',
  98: 'r32uint',
  99: 'r32sint',
  100: 'r32float',
  101: 'rg32uint',
  102: 'rg32sint',
  103: 'rg32float',
  107: 'rgba32uint',
  108: 'rgba32sint',
  109: 'rgba32float',
  122: 'rg11b10ufloat',
  123: 'rgb9e5ufloat',
  124: 'depth16unorm',
  126: 'depth32float',
};

/** Block-compressed `VkFormat`s 131..156 (BC1..BC7, ETC2, EAC), in VkFormat order. */
const BLOCK_FORMATS: readonly GPUTextureFormat[] = [
  'bc1-rgba-unorm', // 131 BC1_RGB_UNORM (WebGPU has the RGBA form only)
  'bc1-rgba-unorm-srgb',
  'bc1-rgba-unorm',
  'bc1-rgba-unorm-srgb',
  'bc2-rgba-unorm',
  'bc2-rgba-unorm-srgb',
  'bc3-rgba-unorm',
  'bc3-rgba-unorm-srgb',
  'bc4-r-unorm',
  'bc4-r-snorm',
  'bc5-rg-unorm',
  'bc5-rg-snorm',
  'bc6h-rgb-ufloat',
  'bc6h-rgb-float',
  'bc7-rgba-unorm',
  'bc7-rgba-unorm-srgb',
  'etc2-rgb8unorm',
  'etc2-rgb8unorm-srgb',
  'etc2-rgb8a1unorm',
  'etc2-rgb8a1unorm-srgb',
  'etc2-rgba8unorm',
  'etc2-rgba8unorm-srgb',
  'eac-r11unorm',
  'eac-r11snorm',
  'eac-rg11unorm',
  'eac-rg11snorm', // 156
];

/** ASTC block sizes of `VkFormat` 157..184, each as (unorm, sRGB). */
const ASTC_SIZES = [
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
];

/**
 * The WebGPU texture format a `VkFormat` stores, or null when WebGPU has none (or the file
 * holds a Basis payload, `vkFormat` 0, that must be transcoded first).
 */
export function ktx2ToWebGpuFormat(vkFormat: number): GPUTextureFormat | null {
  const plain = PLAIN_FORMATS[vkFormat];
  if (plain) return plain;
  if (vkFormat >= 131 && vkFormat <= 156) return BLOCK_FORMATS[vkFormat - 131]!;
  if (vkFormat >= 157 && vkFormat <= 184) {
    const i = vkFormat - 157;
    const size = ASTC_SIZES[i >> 1]!;
    return `astc-${size}-${i & 1 ? 'unorm-srgb' : 'unorm'}` as GPUTextureFormat;
  }
  return null;
}
