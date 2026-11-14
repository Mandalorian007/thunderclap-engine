import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAW_FEATURES_ALL, initGpu, restoreGpu } from './gpu';

/** A fake adapter offering `features`, recording each `requestDevice` descriptor. */
function fakeGpu(features: string[], refuse = false) {
  const requests: GPUDeviceDescriptor[] = [];
  const adapterRequests: (GPURequestAdapterOptions & { xrCompatible?: boolean })[] = [];
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
      requestAdapter: async (o: GPURequestAdapterOptions) => {
        adapterRequests.push(o);
        return adapter;
      },
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  const canvas = { getContext: () => ({ configure() {} }) } as unknown as HTMLCanvasElement;
  return { requests, adapterRequests, canvas };
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

  it('requests indirect-first-instance and multi-draw when the adapter has them', async () => {
    const a = fakeGpu(['indirect-first-instance', 'chromium-experimental-multi-draw-indirect']);
    await initGpu(a.canvas);
    expect(a.requests[0]!.requiredFeatures).toEqual([
      'indirect-first-instance',
      'chromium-experimental-multi-draw-indirect',
    ]);
    const b = fakeGpu(['indirect-first-instance']);
    await initGpu(b.canvas, { drawFeatures: false });
    expect(b.requests[0]!.requiredFeatures).toEqual([]);
  });

  it('drawFeatures flags ask for each feature on its own (ws/kit-fit)', async () => {
    const both = ['indirect-first-instance', 'chromium-experimental-multi-draw-indirect'];
    const a = fakeGpu(both);
    await initGpu(a.canvas, { drawFeatures: { indirectFirstInstance: true } });
    expect(a.requests[0]!.requiredFeatures).toEqual(['indirect-first-instance']);
    const b = fakeGpu(both);
    await initGpu(b.canvas, { drawFeatures: { multiDrawIndirect: true } });
    expect(b.requests[0]!.requiredFeatures).toEqual(['chromium-experimental-multi-draw-indirect']);
    const c = fakeGpu(both);
    await initGpu(c.canvas, { drawFeatures: {} });
    expect(c.requests[0]!.requiredFeatures).toEqual([]);
    // The preset is what `true` (and the default) asks for.
    const d = fakeGpu(both);
    await initGpu(d.canvas, { drawFeatures: DRAW_FEATURES_ALL });
    expect(d.requests[0]!.requiredFeatures).toEqual(both);
    // A flag on for a feature the adapter lacks asks for nothing.
    const e = fakeGpu([]);
    await initGpu(e.canvas, { drawFeatures: { indirectFirstInstance: true } });
    expect(e.requests[0]!.requiredFeatures).toEqual([]);
  });

  it('xrCompatible asks for an XR-compatible adapter, and only when set (ws/kit-fit)', async () => {
    const a = fakeGpu([]);
    await initGpu(a.canvas);
    expect(a.adapterRequests[0]).toEqual({ powerPreference: 'high-performance' });
    const b = fakeGpu([]);
    await initGpu(b.canvas, { xrCompatible: true, powerPreference: 'low-power' });
    expect(b.adapterRequests[0]).toEqual({ powerPreference: 'low-power', xrCompatible: true });
    // restoreGpu takes the same option for the new adapter.
    const res = await initGpu(b.canvas, { xrCompatible: true });
    if (!res.ok) throw new Error('initGpu failed');
    await restoreGpu(res.gpu, { xrCompatible: true });
    expect(b.adapterRequests.at(-1)).toEqual({
      powerPreference: 'high-performance',
      xrCompatible: true,
    });
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

describe('initGpu: the canvas context (#5)', () => {
  it('treats a throwing getContext like a null one, keeping the message', async () => {
    fakeGpu([]);
    const canvas = {
      getContext: () => {
        throw new Error('context creation crashed');
      },
    } as unknown as HTMLCanvasElement;
    expect(await initGpu(canvas)).toEqual({
      ok: false,
      reason: 'no-context',
      detail: 'Error: context creation crashed',
    });
  });

  it('a null getContext is still no-context', async () => {
    fakeGpu([]);
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(await initGpu(canvas)).toEqual({ ok: false, reason: 'no-context' });
  });
});
