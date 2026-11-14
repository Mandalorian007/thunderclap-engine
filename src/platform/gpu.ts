/** WebGPU capability check + device creation. */

import { compressionFeatures } from '../render/compressed';
import { MULTI_DRAW_FEATURE } from '../render/core/core';

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  /** Preferred swapchain format (bgra8unorm or rgba8unorm). */
  format: GPUTextureFormat;
  /**
   * The device has `timestamp-query`, so GPU pass times can be measured directly
   * (`@thunderclap-engine/engine/render` `GpuTimer`). Without it, timing falls back to submit → done.
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
  /**
   * Ask for the adapter's texture-compression features (`compressionFeatures(adapter)`:
   * `texture-compression-bc`, `-etc2`, `-astc`), so `renderer.caps.compressed` reports what the
   * adapter can upload without a second device (ws/render-6). Default true.
   */
  compression?: boolean;
  /**
   * The draw features to ask for, each only when the adapter has it. `true` (the default) is
   * the render core's preset, `DRAW_FEATURES_ALL`: `indirect-first-instance` (indirect draws of
   * the immediate path's merged mesh runs and of retained sets) and Chromium's
   * `chromium-experimental-multi-draw-indirect` (`MULTI_DRAW_FEATURE`). `false` asks for none.
   * A `DrawFeatures` object asks for exactly the flags set in it (a flag left out is off), e.g.
   * `{ indirectFirstInstance: true }` for indirect draws without multi-draw.
   */
  drawFeatures?: boolean | DrawFeatures;
  /**
   * Request an XR-compatible adapter (`requestAdapter({ xrCompatible: true })`): a WebXR session
   * draws through `XRGPUBinding` only with a device from such an adapter. Default false (some
   * browsers pick a different GPU for it, so ask only when the game may enter XR).
   */
  xrCompatible?: boolean;
}

/** `GpuInitOptions.drawFeatures` flag by flag; a flag left out is off. */
export interface DrawFeatures {
  /** `indirect-first-instance`: indirect draws with a first instance other than 0. */
  indirectFirstInstance?: boolean;
  /** Chromium's `chromium-experimental-multi-draw-indirect` (`MULTI_DRAW_FEATURE`). */
  multiDrawIndirect?: boolean;
}

/** The render core's draw features, every flag on: what `drawFeatures: true` asks for. */
export const DRAW_FEATURES_ALL: Readonly<Required<DrawFeatures>> = Object.freeze({
  indirectFirstInstance: true,
  multiDrawIndirect: true,
});

/** The draw features `opts` asks for, as flags (`true` is `DRAW_FEATURES_ALL`). */
function drawFlags(opt: boolean | DrawFeatures | undefined): DrawFeatures {
  if (opt === undefined || opt === true) return DRAW_FEATURES_ALL;
  return opt === false ? {} : opt;
}

/** The adapter request for `opts`: the power preference, and `xrCompatible` only when asked. */
function adapterRequest(
  opts: Pick<GpuInitOptions, 'powerPreference' | 'xrCompatible'>,
): GPURequestAdapterOptions {
  const req: GPURequestAdapterOptions & { xrCompatible?: boolean } = {
    powerPreference: opts.powerPreference ?? 'high-performance',
  };
  if (opts.xrCompatible) req.xrCompatible = true;
  return req;
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
    adapter = await gpu.requestAdapter(adapterRequest(opts));
  } catch (e) {
    return { ok: false, reason: 'no-adapter', detail: String(e) };
  }
  if (!adapter) return { ok: false, reason: 'no-adapter' };

  // Optional features: requested only when the adapter offers them, so a device without
  // them still comes up (and a refused request retries without any).
  const wanted: GPUFeatureName[] = [];
  if ((opts.timestamps ?? true) && adapter.features.has('timestamp-query')) {
    wanted.push('timestamp-query');
  }
  if (opts.compression ?? true) wanted.push(...compressionFeatures(adapter));
  const draw = drawFlags(opts.drawFeatures);
  const has = adapter.features as ReadonlySet<string>;
  if (draw.indirectFirstInstance && has.has('indirect-first-instance')) {
    wanted.push('indirect-first-instance');
  }
  if (draw.multiDrawIndirect && has.has(MULTI_DRAW_FEATURE)) {
    wanted.push(MULTI_DRAW_FEATURE as GPUFeatureName);
  }
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ label: 'engine-device', requiredFeatures: wanted });
  } catch (e) {
    if (wanted.length === 0) return { ok: false, reason: 'no-device', detail: String(e) };
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

  // A blocked or broken GPU process can make getContext throw rather than return null (#5).
  // Both mean the same to the player, so a throw is the unsupported result too, with its
  // message kept for diagnostics.
  let context: GPUCanvasContext | null;
  try {
    context = canvas.getContext('webgpu');
  } catch (e) {
    return { ok: false, reason: 'no-context', detail: String(e) };
  }
  if (!context) return { ok: false, reason: 'no-context' };
  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { ok: true, gpu: { adapter, device, context, format, timestamps } };
}

/**
 * After a device loss: request a new adapter and device with the features the lost device had,
 * configure the canvas on it, and update `gpu` in place (`adapter`, `device`). Returns the new
 * device, or `null` when the GPU is gone for good (no adapter or no device): then the caller's
 * reload screen stands. A lost device's adapter can't make another, so the adapter is new too.
 * Hand the device to `RenderCore.restore`, which rebuilds the core and fires its one
 * `onDeviceRestored` event (ws/core-passes).
 */
export async function restoreGpu(
  gpu: GpuContext,
  opts: Pick<GpuInitOptions, 'powerPreference' | 'onLost' | 'xrCompatible'> = {},
): Promise<GPUDevice | null> {
  const api = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!api) return null;
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await api.requestAdapter(adapterRequest(opts));
  } catch {
    return null;
  }
  if (!adapter) return null;
  const had = gpu.device.features as ReadonlySet<string>;
  const wanted = [...had].filter((f) =>
    (adapter.features as ReadonlySet<string>).has(f),
  ) as GPUFeatureName[];
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ label: 'engine-device', requiredFeatures: wanted });
  } catch {
    try {
      device = await adapter.requestDevice({ label: 'engine-device' });
    } catch {
      return null;
    }
  }
  device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    console.error(`[gpu] device lost: ${info.reason} ${info.message}`);
    opts.onLost?.(info);
  });
  gpu.context.configure({ device, format: gpu.format, alphaMode: 'opaque' });
  gpu.adapter = adapter;
  gpu.device = device;
  gpu.timestamps = device.features.has('timestamp-query');
  return device;
}
