/**
 * The block faces as generated pixels (no asset files): one 16×16 layer per terrain layer, in
 * `LAYER_*` order, each texel jittered by a hash with a darker one-texel rim so the GPU mips
 * have something to blend. `loadTextureArray` uploads them as one `texture_2d_array`; the
 * mesher writes each face's layer into the vertex colour's alpha.
 */
import { hash2f } from '@thunderclap/engine/core';
import type { PixelSource } from '@thunderclap/engine/render';
import { LAYER_COUNT } from '../world/terrain';

export const BLOCK_TEXELS = 16;

/** sRGB bytes: grass, sand, rock, snow. */
const LAYER_COLOURS: readonly (readonly [number, number, number])[] = [
  [96, 150, 70],
  [214, 196, 140],
  [120, 116, 112],
  [236, 240, 246],
];

export function blockLayers(): PixelSource[] {
  const n = BLOCK_TEXELS;
  return LAYER_COLOURS.slice(0, LAYER_COUNT).map((rgb, layer) => {
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const rim = x === 0 || y === 0 || x === n - 1 || y === n - 1;
        const k = rim ? 0.8 : 0.86 + 0.14 * hash2f(layer + 101, x, y);
        const o = (y * n + x) * 4;
        data[o] = rgb[0] * k;
        data[o + 1] = rgb[1] * k;
        data[o + 2] = rgb[2] * k;
        data[o + 3] = 255;
      }
    }
    return { width: n, height: n, data };
  });
}
