/**
 * - `alpha`: straight alpha (`rgb * a + dst * (1 - a)`). Default.
 * - `premultiplied`: shader outputs rgb already multiplied by alpha.
 * - `additive`: `rgb * a + dst`. Destination alpha untouched. Glows, sparks.
 * - `opaque`: overwrite.
 */
export type BlendMode = 'alpha' | 'premultiplied' | 'additive' | 'opaque';

export function blendState(mode: BlendMode): GPUBlendState | undefined {
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
  }
}
