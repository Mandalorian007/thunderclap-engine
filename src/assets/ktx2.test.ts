import { describe, expect, it } from 'vitest';
import { isKtx2, Ktx2Error, ktx2ToWebGpuFormat, parseKtx2 } from './ktx2';

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** A minimal KTX2 file: header, level index, a 28-byte basic DFD, then the level data. */
function ktx2(opts: {
  vkFormat: number;
  width: number;
  height: number;
  levels: Uint8Array[];
  scheme?: number;
  transfer?: number;
  typeSize?: number;
}): Uint8Array {
  const n = opts.levels.length;
  const dfdOffset = 80 + n * 24;
  const dfdLength = 28;
  let dataAt = dfdOffset + dfdLength;
  const offsets = opts.levels.map((l) => {
    dataAt = Math.ceil(dataAt / 16) * 16;
    const at = dataAt;
    dataAt += l.byteLength;
    return at;
  });
  const out = new Uint8Array(dataAt);
  const dv = new DataView(out.buffer);
  out.set(IDENTIFIER);
  const header = [
    opts.vkFormat,
    opts.typeSize ?? 1,
    opts.width,
    opts.height,
    0,
    0,
    1,
    n,
    opts.scheme ?? 0,
    dfdOffset,
    dfdLength,
    0,
    0,
  ];
  for (const [i, v] of header.entries()) dv.setUint32(12 + i * 4, v, true);
  // sgd offset/length (u64) at 64..80 stay zero.
  opts.levels.forEach((l, i) => {
    dv.setUint32(80 + i * 24, offsets[i]!, true);
    dv.setUint32(80 + i * 24 + 8, l.byteLength, true);
    dv.setUint32(80 + i * 24 + 16, l.byteLength, true);
    out.set(l, offsets[i]!);
  });
  dv.setUint32(dfdOffset, dfdLength, true);
  out[dfdOffset + 12] = 1; // RGBSDA
  out[dfdOffset + 13] = 1; // BT.709
  out[dfdOffset + 14] = opts.transfer ?? 2; // sRGB
  return out;
}

describe('parseKtx2', () => {
  it('reads an RGBA8 file to its pixels, level by level', () => {
    const l0 = new Uint8Array(4 * 4 * 4).map((_, i) => i);
    const l1 = new Uint8Array(2 * 2 * 4).fill(7);
    const l2 = new Uint8Array([1, 2, 3, 4]);
    const file = ktx2({ vkFormat: 43, width: 4, height: 4, levels: [l0, l1, l2] });
    expect(isKtx2(file)).toBe(true);
    const t = parseKtx2(file);
    expect(t).toMatchObject({
      vkFormat: 43,
      width: 4,
      height: 4,
      depth: 0,
      layers: 0,
      faces: 1,
      levelCount: 3,
      supercompression: 'none',
      dataFormat: { colorModel: 1, colorPrimaries: 1, transferFunction: 2, flags: 0 },
    });
    expect(t.levels.map((l) => [l.width, l.height])).toEqual([
      [4, 4],
      [2, 2],
      [1, 1],
    ]);
    expect([...t.levels[0]!.bytes]).toEqual([...l0]);
    expect([...t.levels[1]!.bytes]).toEqual([...l1]);
    expect([...t.levels[2]!.bytes]).toEqual([1, 2, 3, 4]);
    // Views into the file, not copies.
    expect(t.levels[0]!.bytes.buffer).toBe(file.buffer);
    expect(ktx2ToWebGpuFormat(t.vkFormat)).toBe('rgba8unorm-srgb');
  });

  it('maps BC7 to bc7-rgba-unorm and reads its blocks', () => {
    const block = new Uint8Array(16).fill(0x55);
    const t = parseKtx2(ktx2({ vkFormat: 145, width: 4, height: 4, levels: [block], transfer: 1 }));
    expect(ktx2ToWebGpuFormat(t.vkFormat)).toBe('bc7-rgba-unorm');
    expect(ktx2ToWebGpuFormat(146)).toBe('bc7-rgba-unorm-srgb');
    expect(t.levels[0]!.bytes.byteLength).toBe(16);
    expect(t.dataFormat!.transferFunction).toBe(1);
  });

  it('reports a supercompressed file without decoding it (no levels)', () => {
    const zstd = parseKtx2(
      ktx2({ vkFormat: 37, width: 8, height: 8, levels: [new Uint8Array(20)], scheme: 2 }),
    );
    expect(zstd.supercompression).toBe('zstd');
    expect(zstd.levels).toEqual([]);
    expect(zstd.levelCount).toBe(1);
    const basis = parseKtx2(
      ktx2({ vkFormat: 0, width: 8, height: 8, levels: [new Uint8Array(20)], scheme: 1 }),
    );
    expect(basis.supercompression).toBe('basislz');
    expect(basis.levels).toEqual([]);
    expect(ktx2ToWebGpuFormat(basis.vkFormat)).toBeNull();
  });

  it('names ASTC, ETC2 and packed formats, null for ones WebGPU lacks', () => {
    expect(ktx2ToWebGpuFormat(157)).toBe('astc-4x4-unorm');
    expect(ktx2ToWebGpuFormat(158)).toBe('astc-4x4-unorm-srgb');
    expect(ktx2ToWebGpuFormat(184)).toBe('astc-12x12-unorm-srgb');
    expect(ktx2ToWebGpuFormat(147)).toBe('etc2-rgb8unorm');
    expect(ktx2ToWebGpuFormat(131)).toBe('bc1-rgba-unorm');
    expect(ktx2ToWebGpuFormat(97)).toBe('rgba16float');
    expect(ktx2ToWebGpuFormat(23)).toBeNull(); // R8G8B8_UNORM: no 3-channel WebGPU format
  });

  it('rejects a bad identifier, truncation and a level past the end', () => {
    expect(() => parseKtx2(new Uint8Array(100))).toThrow(Ktx2Error);
    const ok = ktx2({ vkFormat: 37, width: 1, height: 1, levels: [new Uint8Array(4)] });
    expect(() => parseKtx2(ok.subarray(0, 60))).toThrow(/truncated header/);
    const bad = ok.slice();
    new DataView(bad.buffer).setUint32(88, 1000, true);
    expect(() => parseKtx2(bad)).toThrow(/level 0 runs past the end/);
  });
});
