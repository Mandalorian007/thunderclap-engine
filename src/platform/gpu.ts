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
   * Ask for the draw features the render core uses when the adapter has them:
   * `indirect-first-instance` (indirect draws of the immediate path's merged mesh runs and of
   * retained sets) and Chromium's `chromium-experimental-multi-draw-indirect`
   * (`MULTI_DRAW_FEATURE`). Default true.
   */
  drawFeatures?: boolean;
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
  // them still comes up (and a refused request retries without any).
  const wanted: GPUFeatureName[] = [];
  if ((opts.timestamps ?? true) && adapter.features.has('timestamp-query')) {
    wanted.push('timestamp-query');
  }
  if (opts.compression ?? true) wanted.push(...compressionFeatures(adapter));
  if (opts.drawFeatures ?? true) {
    const has = adapter.features as ReadonlySet<string>;
    if (has.has('indirect-first-instance')) wanted.push('indirect-first-instance');
    if (has.has(MULTI_DRAW_FEATURE)) wanted.push(MULTI_DRAW_FEATURE as GPUFeatureName);
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
