/**
 * The finishing sections (ws/post-2): defaults off, merge by section, quality caps on FXAA and
 * the outline, and the uniform block packs them where the composite expects them (after
 * `invProj`, at float 104 on).
 */
import { describe, expect, it } from 'vitest';
import {
  applyPostPatch,
  defaultPostQuality,
  defaultPostSettings,
  lowPostQuality,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';

const FXAA = 104;
const LUT = 108;
const GRAIN = 112;
const ABERRATION = 116;
const SHARPEN = 120;
const OUTLINE = 124;
const OUTLINE_COLOR = 128;

function pack(s = defaultPostSettings(), quality = defaultPostQuality(), depth = false, seed = 0) {
  const out = new Float32Array(POST_UNIFORM_FLOATS);
  const info = depth
    ? { outputWidth: 1600, near: 0.1, far: 100, projX: 1, projY: 1, invProj: new Float32Array(16) }
    : null;
  packPostUniforms(out, s, 0, 800, 450, 1920, 1080, quality, info, seed);
  return out;
}

describe('finishing settings', () => {
  it('default to off with the brief values', () => {
    const s = defaultPostSettings();
    expect(s.fxaa).toEqual({ enabled: false, subpixel: 0.75, edgeThreshold: 0.125 });
    expect(s.lut).toEqual({ texture: null, size: 32, intensity: 1 });
    expect(s.grain).toEqual({ intensity: 0, size: 1, luminanceResponse: 0.5, animated: true });
    expect(s.aberration).toEqual({ intensity: 0, radialOnly: true });
    expect(s.sharpen).toEqual({ amount: 0 });
    expect(s.outline).toEqual({
      enabled: false,
      color: [0, 0, 0],
      thickness: 1.5,
      depthThreshold: 0.03,
      normalThreshold: 0.4,
      intensity: 1,
    });
  });

  it('merge by section, keeping the other fields', () => {
    const s = defaultPostSettings();
    applyPostPatch(s, {
      grain: { intensity: 0.2 },
      outline: { thickness: 3 },
      sharpen: { amount: 1 },
    });
    expect(s.grain).toMatchObject({ intensity: 0.2, size: 1, animated: true });
    expect(s.outline).toMatchObject({ thickness: 3, enabled: false, depthThreshold: 0.03 });
    expect(s.sharpen.amount).toBe(1);
  });

  it('quality: the default tier allows FXAA and the outline; the low tier caps them off', () => {
    expect(defaultPostQuality()).toMatchObject({ fxaa: true, outline: true });
    expect(lowPostQuality()).toMatchObject({ fxaa: false, outline: false, compositeAtScene: true });
  });

  it('pack every section off by default, leaving the earlier block alone', () => {
    const out = pack();
    const before = new Float32Array(POST_UNIFORM_FLOATS);
    packPostUniforms(
      before,
      defaultPostSettings(),
      0,
      800,
      450,
      1920,
      1080,
      defaultPostQuality(),
      null,
    );
    expect(out.slice(0, FXAA)).toEqual(before.slice(0, FXAA));
    expect(out[FXAA]).toBe(0);
    expect(out[LUT]).toBe(0);
    expect(out[GRAIN]).toBe(0);
    expect(out[ABERRATION]).toBe(0);
    expect(out[SHARPEN]).toBe(0);
    expect(out[OUTLINE]).toBe(0);
    expect(out[OUTLINE_COLOR + 3]).toBe(1);
  });

  it('pack the sections on, with the LUT scale and the grain seed only when animated', () => {
    const s = defaultPostSettings();
    const tex = {} as GPUTexture;
    applyPostPatch(s, {
      fxaa: { enabled: true, subpixel: 0.5, edgeThreshold: 0.2 },
      lut: { texture: tex, size: 16, intensity: 0.5 },
      grain: { intensity: 0.1, size: 2, luminanceResponse: 0.25 },
      aberration: { intensity: 3, radialOnly: false },
      sharpen: { amount: 0.8 },
    });
    const out = pack(s, defaultPostQuality(), false, 7);
    expect(out[FXAA]).toBe(1);
    expect(out[FXAA + 1]).toBe(0.5);
    expect(out[FXAA + 2]).toBeCloseTo(0.2);
    expect(out[LUT]).toBe(1);
    expect(out[LUT + 1]).toBeCloseTo(15 / 16);
    expect(out[LUT + 2]).toBe(0.5);
    expect(out[LUT + 3]).toBeCloseTo(0.5 / 16);
    expect(out[GRAIN]).toBeCloseTo(0.1);
    expect(Array.from(out.slice(GRAIN + 1, GRAIN + 4))).toEqual([2, 0.25, 7]);
    applyPostPatch(s, { grain: { animated: false } });
    expect(pack(s, defaultPostQuality(), false, 7)[GRAIN + 3]).toBe(0);
    expect(Array.from(out.slice(ABERRATION, ABERRATION + 2))).toEqual([3, 0]);
    expect(out[SHARPEN]).toBeCloseTo(0.8);
  });

  it('pack the outline on only with depth, scaled to scene px, and the caps turn FXAA and it off', () => {
    const s = defaultPostSettings();
    applyPostPatch(s, {
      fxaa: { enabled: true },
      outline: { enabled: true, thickness: 2, color: [1, 0.5, 0], intensity: 0.75 },
    });
    expect(pack(s)[OUTLINE]).toBe(0);
    const deep = pack(s, defaultPostQuality(), true);
    expect(deep[OUTLINE]).toBe(1);
    expect(deep[OUTLINE + 1]).toBeCloseTo(2 * (800 / 1600));
    expect(Array.from(deep.slice(OUTLINE_COLOR, OUTLINE_COLOR + 4))).toEqual([1, 0.5, 0, 0.75]);
    const low = pack(s, lowPostQuality(), true);
    expect(low[OUTLINE]).toBe(0);
    expect(low[FXAA]).toBe(0);
  });
});
