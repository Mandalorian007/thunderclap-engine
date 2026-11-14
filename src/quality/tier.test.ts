import { describe, expect, it } from 'vitest';
import { type DeviceInfo, detectTier, gpuInfo, headsetBrowser, readDevice } from './tier';

const desktop: DeviceInfo = {
  touch: false,
  ipad: false,
  phone: false,
  webkit: false,
  cores: 8,
  headset: false,
  automated: false,
  gpu: null,
};
const gpu = (description: string, maxTexture = 16384, fallback = false) =>
  gpuInfo({
    info: { vendor: description, isFallbackAdapter: fallback },
    limits: { maxTextureDimension2D: maxTexture, maxBufferSize: 1 << 30 },
  });

describe('detectTier (Forge autoTier rules)', () => {
  it('high unless something certain says otherwise, with the reason', () => {
    const c = detectTier(desktop);
    expect(c.tier).toBe('high');
    expect(c.reason).toMatch(/GPU isn't known yet/);
    expect(detectTier({ ...desktop, gpu: gpu('apple') }).tier).toBe('high');
    // A phone or an iPad is not guessed down.
    expect(detectTier({ ...desktop, ipad: true, webkit: true, cores: 2, touch: true }).tier).toBe(
      'high',
    );
  });

  it('low for a software GPU, a headset or an Adreno', () => {
    expect(detectTier({ ...desktop, gpu: gpu('google', 8192, true) })).toMatchObject({
      tier: 'low',
    });
    expect(detectTier({ ...desktop, headset: true }).tier).toBe('low');
    expect(detectTier({ ...desktop, gpu: gpu('qualcomm Adreno 740') }).tier).toBe('low');
  });

  it('medium for small textures or two honest cores', () => {
    expect(detectTier({ ...desktop, gpu: gpu('arm', 4096) }).tier).toBe('medium');
    expect(detectTier({ ...desktop, cores: 2 }).tier).toBe('medium');
    expect(detectTier({ ...desktop, cores: 2, webkit: true }).tier).toBe('high');
  });
});

describe('device facts', () => {
  it('gpuInfo joins the distinct adapter strings', () => {
    const g = gpuInfo({
      info: { vendor: 'apple', architecture: 'common-3', description: 'apple' },
      limits: { maxTextureDimension2D: 16384, maxBufferSize: 4 },
    });
    expect(g).toEqual({
      description: 'apple common-3',
      fallback: false,
      maxTexture: 16384,
      maxBuffer: 4,
    });
  });

  it('headsetBrowser knows the standalone headsets', () => {
    expect(headsetBrowser('Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/35')).toBe(true);
    expect(headsetBrowser('Mozilla/5.0 (Macintosh) AppleWebKit Safari')).toBe(false);
  });

  it('readDevice reads the page (node: no navigator)', () => {
    const d = readDevice();
    expect(d.gpu).toBe(null);
    expect(typeof d.cores).toBe('number');
  });
});
