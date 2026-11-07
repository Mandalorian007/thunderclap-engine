import { describe, expect, it } from 'vitest';
import { blendState, type RenderBlendMode } from './blend';

describe('blendState', () => {
  it('opaque is no blend state', () => {
    expect(blendState('opaque')).toBeUndefined();
  });

  it('multiply is dst × src on colour (`dst` / `zero`) and keeps destination alpha (ws/render-hooks)', () => {
    expect(blendState('multiply')).toEqual({
      color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    });
  });

  it('every mode but opaque has a colour and an alpha blend', () => {
    const modes: RenderBlendMode[] = ['alpha', 'premultiplied', 'additive', 'multiply'];
    for (const m of modes) {
      const b = blendState(m)!;
      expect(b.color.operation).toBe('add');
      expect(b.alpha.operation).toBe('add');
    }
  });
});
