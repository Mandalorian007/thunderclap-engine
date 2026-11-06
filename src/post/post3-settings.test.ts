/**
 * Post 3 settings (ws/post-3): defaults off, the uniform block packs the new sections where
 * the shaders expect them (float 132 on), the packed size equals the WGSL struct's size for
 * every field, the quality tiers, and the white-balance identity.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPostPatch,
  defaultPostQuality,
  defaultPostSettings,
  lowPostQuality,
  POST_UNIFORM_FLOATS,
  type PostFrameState,
  packPostUniforms,
  postQualityFor,
  WGSL_POST_UNIFORMS,
} from './settings';
import { whiteBalanceMatrix } from './white-balance';

const TAA = 132;
const TAA2 = 136;
const SSR = 140;
const SSR2 = 144;
const EXPOSURE = 148;
const WB0 = 152;
const MOTION_BLUR = 164;
const DIRT = 168;
const REPROJ = 172;

const depthInfo = {
  outputWidth: 1600,
  near: 0.1,
  far: 100,
  projX: 1,
  projY: 1,
  invProj: new Float32Array(16),
};

function frameState(): PostFrameState {
  const reproj = new Float32Array(16);
  for (let i = 0; i < 16; i++) reproj[i] = i;
  return { jitterX: 0.25, jitterY: -0.125, reset: 0, reproj, autoExposure: 4 };
}

function pack(
  s = defaultPostSettings(),
  quality = defaultPostQuality(),
  depth = false,
  frame: PostFrameState | null = null,
) {
  const out = new Float32Array(POST_UNIFORM_FLOATS);
  packPostUniforms(out, s, 0, 800, 450, 1920, 1080, quality, depth ? depthInfo : null, 0, frame);
  return out;
}

/** Floats of the WGSL struct, field by field (vec4f = 4, mat4x4f = 16, f32 = 1). */
function wgslStructFloats(): { name: string; floats: number }[] {
  const body = WGSL_POST_UNIFORMS.split('struct PostUniforms {')[1]!.split('};')[0]!;
  const fields: { name: string; floats: number }[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.split('//')[0]!.trim();
    const m = /^(\w+):\s*(vec4f|mat4x4f|f32),?$/.exec(line);
    if (!m) continue;
    const floats = m[2] === 'vec4f' ? 4 : m[2] === 'mat4x4f' ? 16 : 1;
    fields.push({ name: m[1]!, floats });
  }
  return fields;
}

describe('post 3 settings', () => {
  it('default to off with the brief values', () => {
    const s = defaultPostSettings();
    expect(s.taa).toEqual({ enabled: false, feedback: 0.9, sharpen: 0.2, clampMode: 'aabb' });
    expect(s.ssr).toMatchObject({
      enabled: false,
      maxSteps: 32,
      roughnessCutoff: 0.6,
      intensity: 1,
    });
    expect(s.exposure).toMatchObject({
      mode: 'manual',
      keyValue: 0.18,
      histogramLow: 0.4,
      histogramHigh: 0.95,
    });
    expect(s.whiteBalance).toEqual({ temperature: 6500, tint: 0 });
    expect(s.motionBlur).toEqual({ enabled: false, intensity: 1, maxSamples: 8 });
    expect(s.bloom.dirt).toBeUndefined();
  });

  it('the packed block is exactly the WGSL struct, and every field has a packed slot', () => {
    const fields = wgslStructFloats();
    const total = fields.reduce((n, f) => n + f.floats, 0);
    expect(total).toBe(POST_UNIFORM_FLOATS);
    // Each field starts at its offset: the post-3 ones where the tests below read them.
    const offsets = new Map<string, number>();
    let o = 0;
    for (const f of fields) {
      offsets.set(f.name, o);
      o += f.floats;
    }
    expect(offsets.get('taa')).toBe(TAA);
    expect(offsets.get('taa2')).toBe(TAA2);
    expect(offsets.get('ssr')).toBe(SSR);
    expect(offsets.get('ssr2')).toBe(SSR2);
    expect(offsets.get('exposure')).toBe(EXPOSURE);
    expect(offsets.get('wb0')).toBe(WB0);
    expect(offsets.get('motionBlur')).toBe(MOTION_BLUR);
    expect(offsets.get('dirt')).toBe(DIRT);
    expect(offsets.get('reproj')).toBe(REPROJ);
    expect(REPROJ + 16).toBe(POST_UNIFORM_FLOATS);
  });

  it('pack every section off by default: identity white balance, identity reproject', () => {
    const out = pack();
    expect(out[TAA]).toBe(0);
    expect(out[SSR]).toBe(0);
    expect(out[EXPOSURE]).toBe(0);
    expect(out[MOTION_BLUR]).toBe(0);
    expect(out[DIRT]).toBe(0);
    expect(Array.from(out.slice(WB0, WB0 + 12))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(out[TAA2 + 2]).toBe(1); // reset without a frame state
    const reproj = Array.from(out.slice(REPROJ, REPROJ + 16));
    expect(reproj).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // Everything before the post-3 block is untouched by the new sections.
    const s = defaultPostSettings();
    applyPostPatch(s, {
      taa: { enabled: true },
      ssr: { enabled: true },
      exposure: { mode: 'auto' },
      whiteBalance: { temperature: 3200 },
      motionBlur: { enabled: true },
    });
    const on = Array.from(pack(s, defaultPostQuality(), true, frameState()).slice(0, TAA));
    const off = Array.from(pack(undefined, undefined, true).slice(0, TAA));
    on[11] = off[11]!; // enables2.w: the auto-exposure multiplier replaces grade.exposure
    expect(on).toEqual(off);
  });

  it('pack the temporal sections on only with depth and a frame state', () => {
    const s = defaultPostSettings();
    applyPostPatch(s, {
      taa: { enabled: true, feedback: 2, clampMode: 'variance' },
      motionBlur: { enabled: true, maxSamples: 100 },
      ssr: { enabled: true, maxSteps: 3 },
    });
    expect(pack(s)[TAA]).toBe(0);
    expect(pack(s, undefined, true)[TAA]).toBe(0);
    expect(pack(s, undefined, true)[MOTION_BLUR]).toBe(0);
    expect(pack(s, undefined, true)[SSR]).toBe(1);
    const fs = frameState();
    const on = pack(s, undefined, true, fs);
    expect(Array.from(on.slice(TAA, TAA + 4))).toEqual([
      1,
      expect.closeTo(0.98),
      expect.closeTo(0.2),
      1,
    ]);
    expect(Array.from(on.slice(TAA2, TAA2 + 3))).toEqual([0.25, -0.125, 0]);
    expect(on[SSR + 1]).toBe(8);
    expect(Array.from(on.slice(MOTION_BLUR, MOTION_BLUR + 3))).toEqual([1, 1, 16]);
    expect(Array.from(on.slice(REPROJ, REPROJ + 16))).toEqual(
      Array.from(fs.reproj as Float32Array),
    );
    const low = pack(s, lowPostQuality(), true, fs);
    expect(low[TAA]).toBe(1);
    expect(low[SSR]).toBe(0);
    expect(low[MOTION_BLUR]).toBe(0);
  });

  it('auto exposure replaces the grade exposure with the frame state multiplier', () => {
    const s = defaultPostSettings();
    s.grade.exposure = 2;
    const fs = frameState();
    expect(pack(s, undefined, false, fs)[11]).toBe(2);
    s.exposure.mode = 'auto';
    expect(pack(s, undefined, false, fs)[11]).toBe(4);
    expect(pack(s, undefined, false, fs)[EXPOSURE]).toBe(1);
    // Without a frame state (or under a tier that forbids it) the manual value stands.
    expect(pack(s)[11]).toBe(2);
    expect(pack(s, { ...defaultPostQuality(), autoExposure: false }, false, fs)[11]).toBe(2);
  });

  it('white balance: 6500 / 0 is the identity, a lower temperature warms', () => {
    const m = new Float32Array(9);
    whiteBalanceMatrix(m, 6500, 0);
    for (let i = 0; i < 9; i++) expect(m[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 5);
    whiteBalanceMatrix(m, 3200, 0);
    // A grey through the warm matrix gains red and loses blue.
    const r = m[0]! + m[1]! + m[2]!;
    const b = m[6]! + m[7]! + m[8]!;
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
    expect(r).toBeGreaterThan(b);
    const s = defaultPostSettings();
    s.whiteBalance.temperature = 3200;
    const out = pack(s);
    expect(out[WB0 + 3]).toBe(1);
    expect(out[WB0]! + out[WB0 + 1]! + out[WB0 + 2]!).toBeCloseTo(r, 5);
  });

  it('lens dirt packs the flag only with a texture', () => {
    const s = defaultPostSettings();
    s.bloom.dirt = { texture: null, intensity: 2 };
    expect(Array.from(pack(s).slice(DIRT, DIRT + 2))).toEqual([0, 2]);
    s.bloom.dirt.texture = {} as GPUTexture;
    expect(Array.from(pack(s).slice(DIRT, DIRT + 2))).toEqual([1, 2]);
  });

  it('quality tiers: phone is low, xr drops the temporal passes and SSR, desktop is default', () => {
    expect(defaultPostQuality()).toMatchObject({
      taa: true,
      ssr: true,
      autoExposure: true,
      motionBlur: true,
    });
    expect(lowPostQuality()).toMatchObject({ taa: true, ssr: false, motionBlur: false });
    expect(postQualityFor('phone')).toEqual(lowPostQuality());
    expect(postQualityFor('desktop')).toEqual(defaultPostQuality());
    expect(postQualityFor('tablet')).toMatchObject({ ssr: false, taa: true, fxaa: true });
    expect(postQualityFor('xr')).toMatchObject({ taa: false, ssr: false, motionBlur: false });
  });
});
