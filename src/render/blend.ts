/**
 * How a material or fullscreen pass blends into its target (`MaterialDesc.blend`,
 * `FullscreenPassDesc.blend`):
 *
 * - `alpha`: straight alpha (`rgb * a + dst * (1 - a)`). Default.
 * - `premultiplied`: shader outputs rgb already multiplied by alpha.
 * - `additive`: `rgb * a + dst`. Destination alpha untouched. Glows, sparks.
 * - `opaque`: overwrite.
 * - `multiply`: `dst * rgb` (colour factors `dst` / `zero`); destination alpha kept (alpha
 *   factors `zero` / `one`). Decals, stains, tinted glass: white leaves the surface alone.
 */
export type RenderBlendMode = 'alpha' | 'premultiplied' | 'additive' | 'opaque' | 'multiply';

export function blendState(mode: RenderBlendMode): GPUBlendState | undefined {
  switch (mode) {
    case 'opaque':
      return undefined;
    case 'alpha':
      return {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
    case 'premultiplied':
      return {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
    case 'additive':
      return {
        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      };
    case 'multiply':
      return {
        color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      };
  }
}
