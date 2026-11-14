/**
 * The surface and GPU service (ws/kit): `bootKit` mounts the letterboxed surface and boots
 * WebGPU on it (or takes a given GPU, headless), and `createKitRenderer` builds the renderer on
 * that GPU. Both are constructible alone; `composeGame` calls them first.
 */

import { DetachedSurface } from '../core/detached-surface';
import {
  type BootResult,
  blockBrowserZoom,
  boot,
  type GpuContext,
  mountSurface,
  type Surface,
  type SurfaceOptions,
} from '../platform';
import { installGpuErrorLogging, Renderer, type SceneTargetAux } from '../render';

/** `bootKit`'s inputs: where to mount, what to boot on, and the design size. */
export interface KitBootOptions {
  /**
   * Element the canvas mounts into. Required unless `gpu` is given; a headless game without it
   * mounts into a new detached `<div>` of `document`.
   */
  root?: HTMLElement;
  /** Headless: the GPU to build on instead of booting WebGPU (no fatal screens, no context). */
  gpu?: GpuContext;
  /**
   * `false`: no DOM at all (a `DetachedSurface` of the design size). Needs `gpu`. Default true.
   */
  dom?: boolean;
  /** Logical design size. */
  design: { width: number; height: number };
  /** Surface options other than the design size. */
  surface?: Omit<SurfaceOptions, 'logicalWidth' | 'logicalHeight'>;
  /** The game's name, the eyebrow on the fatal screens. */
  title?: string;
  /** Stop double-tap, pinch and ctrl+wheel from zooming the page. Default true. */
  blockBrowserZoom?: boolean;
  /** Dev aid: show the unsupported screen as if WebGPU were missing. */
  forceUnsupported?: boolean;
}

/** What `bootKit` resolves to: the surface, the GPU and the device-loss subscription. */
export type KitBoot = Extract<BootResult, { ok: true }>;

/**
 * Mounts the surface and boots WebGPU on it. Resolves `null` when WebGPU is unavailable (the
 * unsupported screen is shown). With `gpu` it skips the boot and reads device loss from
 * `gpu.device.lost`; with `dom: false` it touches no DOM.
 */
export async function bootKit(opts: KitBootOptions): Promise<KitBoot | null> {
  const surfaceOpts = {
    ...opts.surface,
    logicalWidth: opts.design.width,
    logicalHeight: opts.design.height,
  };
  if (opts.dom === false) {
    if (!opts.gpu) throw new Error('bootKit: `dom: false` needs `gpu` (it touches no DOM)');
    return gpuBoot(new DetachedSurface(surfaceOpts), opts.gpu);
  }
  const root = opts.root ?? (opts.gpu ? globalThis.document?.createElement('div') : undefined);
  if (!root) {
    throw new Error(
      'createGame: `root` is required (a headless game passes `gpu` and a DOM, or `overlay: false`)',
    );
  }
  // Before boot, so it holds from the first frame (and on the fatal screens too).
  if (opts.blockBrowserZoom !== false) blockBrowserZoom(root.ownerDocument);
  const booted = opts.gpu
    ? gpuBoot(mountSurface(root, surfaceOpts), opts.gpu)
    : await boot(root, {
        ...surfaceOpts,
        title: opts.title,
        forceUnsupported: opts.forceUnsupported,
      });
  return booted.ok ? booted : null;
}

/**
 * The renderer on `gpu` at the design size, with GPU error logging installed on the device.
 * `aux` is `RendererOptions.aux`.
 */
export function createKitRenderer(
  gpu: GpuContext,
  design: { width: number; height: number },
  aux?: SceneTargetAux,
): Renderer {
  installGpuErrorLogging(gpu.device);
  return new Renderer(gpu, {
    logicalWidth: design.width,
    logicalHeight: design.height,
    aux,
  });
}

/**
 * `boot` for a headless game: the surface is the one given, the GPU is the one given, and device
 * loss comes from `gpu.device.lost` when the device has one (a reason of `destroyed` is an
 * explicit `destroy()`, not a loss).
 */
function gpuBoot(surface: Surface, gpu: GpuContext): KitBoot {
  const listeners = new Set<(info: GPUDeviceLostInfo) => void>();
  const lost = (gpu.device as { lost?: Promise<GPUDeviceLostInfo> }).lost;
  if (lost && typeof lost.then === 'function') {
    void lost.then((info) => {
      if (info.reason === 'destroyed') return;
      for (const fn of [...listeners]) {
        try {
          fn(info);
        } catch (err) {
          console.error('[createGame] device-lost handler failed', err);
        }
      }
    });
  }
  return {
    ok: true,
    surface,
    gpu,
    onDeviceLost(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
