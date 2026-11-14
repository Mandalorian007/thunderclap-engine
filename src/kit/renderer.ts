/**
 * The engine's renderer for the kit (ws/kit). Its own module so `composeGame` loads it with a
 * dynamic import only when the game draws through the engine (ws/kit-fit): a game with its own
 * renderer, or none, never loads `Renderer`.
 */

import type { GpuContext } from '../platform';
import { installGpuErrorLogging, Renderer, type SceneTargetAux } from '../render';

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
