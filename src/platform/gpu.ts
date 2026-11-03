/** WebGPU capability check + device creation. */

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  /** Preferred swapchain format (bgra8unorm or rgba8unorm). */
  format: GPUTextureFormat;
  /**
   * The device has `timestamp-query`, so GPU pass times can be measured directly
   * (`@thunderclap/engine/render` `GpuTimer`). Without it, timing falls back to submit → done.
   */
  timestamps: boolean;
}

export type GpuFailureReason = 'no-api' | 'no-adapter' | 'no-device' | 'no-context';

export type GpuInitResult =
  | { ok: true; gpu: GpuContext }
  | { ok: false; reason: GpuFailureReason; detail?: string };

export interface GpuInitOptions {
  powerPreference?: GPUPowerPreference;
  /** Called when the device is lost for any reason other than an explicit `destroy()`. */
  onLost?: (info: GPUDeviceLostInfo) => void;
  /** Ask for `timestamp-query` when the adapter has it. Default true. */
  timestamps?: boolean;
}

/**
 * Request an adapter + device and configure the canvas. Never throws: failures come back as
 * `{ ok: false, reason }` so the caller can show the unsupported screen.
 */
export async function initGpu(
  canvas: HTMLCanvasElement,
  opts: GpuInitOptions = {},
): Promise<GpuInitResult> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return { ok: false, reason: 'no-api' };

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter({
      powerPreference: opts.powerPreference ?? 'high-performance',
    });
  } catch (e) {
    return { ok: false, reason: 'no-adapter', detail: String(e) };
  }
  if (!adapter) return { ok: false, reason: 'no-adapter' };

  // Optional features: requested only when the adapter offers them, so a device without
  // them still comes up (and a refused request retries without).
  const wantTs = (opts.timestamps ?? true) && adapter.features.has('timestamp-query');
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      label: 'engine-device',
      requiredFeatures: wantTs ? ['timestamp-query'] : [],
    });
  } catch (e) {
    if (!wantTs) return { ok: false, reason: 'no-device', detail: String(e) };
    try {
      device = await adapter.requestDevice({ label: 'engine-device' });
    } catch (e2) {
      return { ok: false, reason: 'no-device', detail: String(e2) };
    }
  }
  const timestamps = device.features.has('timestamp-query');

  device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    console.error(`[gpu] device lost: ${info.reason} ${info.message}`);
    opts.onLost?.(info);
  });

  const context = canvas.getContext('webgpu');
  if (!context) return { ok: false, reason: 'no-context' };
  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { ok: true, gpu: { adapter, device, context, format, timestamps } };
}
