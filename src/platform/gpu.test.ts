import { afterEach, describe, expect, it, vi } from 'vitest';
import { initGpu } from './gpu';

/** A fake adapter offering `features`, recording each `requestDevice` descriptor. */
function fakeGpu(features: string[], refuse = false) {
  const requests: GPUDeviceDescriptor[] = [];
  const adapter = {
    features: new Set(features),
    async requestDevice(desc: GPUDeviceDescriptor) {
      requests.push(desc);
      const asked = [...(desc.requiredFeatures ?? [])];
      if (refuse && asked.length > 0) throw new Error('refused');
      return { features: new Set(asked), lost: new Promise(() => {}) };
    },
  };
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: async () => adapter,
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  const canvas = { getContext: () => ({ configure() {} }) } as unknown as HTMLCanvasElement;
  return { requests, canvas };
}

afterEach(() => vi.unstubAllGlobals());

describe('initGpu', () => {
  it('requests the compression features the adapter has, with timestamp-query', async () => {
    const { requests, canvas } = fakeGpu([
      'timestamp-query',
      'texture-compression-bc',
      'texture-compression-astc',
    ]);
    const res = await initGpu(canvas);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.requiredFeatures).toEqual([
      'timestamp-query',
      'texture-compression-bc',
      'texture-compression-astc',
    ]);
    if (res.ok) {
      expect(res.gpu.timestamps).toBe(true);
      expect(res.gpu.device.features.has('texture-compression-bc')).toBe(true);
      expect(res.gpu.device.features.has('texture-compression-etc2')).toBe(false);
    }
  });

  it('asks for nothing the adapter lacks, and nothing when turned off', async () => {
    const a = fakeGpu(['texture-compression-etc2']);
    await initGpu(a.canvas, { compression: false });
    expect(a.requests[0]!.requiredFeatures).toEqual([]);
    const b = fakeGpu([]);
    await initGpu(b.canvas);
    expect(b.requests[0]!.requiredFeatures).toEqual([]);
  });

  it('retries without features when the device request is refused', async () => {
    const { requests, canvas } = fakeGpu(['texture-compression-bc'], true);
    const res = await initGpu(canvas);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requiredFeatures).toBeUndefined();
    if (res.ok) expect(res.gpu.device.features.has('texture-compression-bc')).toBe(false);
  });
});
