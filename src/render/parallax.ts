/**
 * Parallax (ws/ergo-2d-2): tile layers that scroll at a fraction of the camera. `update` moves
 * each layer's `origin` to `base + camera × (1 - factor)`, so a layer with factor 0 is pinned to
 * the screen and one with factor 1 moves with the world; a layer with a `wrapW` / `wrapH`
 * pattern period is kept within one period of the camera instead (the origin stays in
 * `camera - wrap .. camera`), so a short repeating strip covers any scroll distance. `draw`
 * draws the layers in order, far to near. No allocation per frame.
 */
import type { Frame, InstanceParams } from './frame';
import type { Renderer } from './renderer';
import type { TileLayer } from './tile-layer';

export interface ParallaxLayerOptions {
  layer: TileLayer;
  /** 0 pins the layer to the view, 1 moves it with the world. */
  factorX: number;
  factorY: number;
  /** Pattern period in px: the layer wraps every `wrapW` along x (default none). */
  wrapW?: number;
  wrapH?: number;
  /** Per-layer draw params (tint, order, layers), passed to `TileLayer.draw`. */
  params?: InstanceParams;
}

export interface ParallaxLayer extends ParallaxLayerOptions {
  /** The layer's `origin` when the parallax was made: where it sits at camera `(0, 0)`. */
  readonly baseX: number;
  readonly baseY: number;
  /** Offset `update` last added to the base (`camera × (1 - factor)`, wrapped). */
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface Parallax {
  /** The layers, in draw order. */
  readonly layers: readonly ParallaxLayer[];
  /**
   * Aim every layer for a view whose top-left is `(cameraX, cameraY)` (an ortho2d `Camera`'s
   * `x`, `y`): writes each layer's `origin`.
   */
  update(cameraX: number, cameraY: number): void;
  /** `layer.draw(frame, params)` for each layer in order. */
  draw(frame: Frame): void;
  /** Destroys every layer. */
  destroy(): void;
}

/** Wrapped parallax offset: `camera - (camera × factor mod wrap)`, in `camera - wrap .. camera`. */
export function parallaxOffset(camera: number, factor: number, wrap?: number): number {
  if (wrap === undefined || !(wrap > 0)) return camera * (1 - factor);
  const scroll = camera * factor;
  return camera - (((scroll % wrap) + wrap) % wrap);
}

/**
 * Make a `Parallax` over layers built on `renderer`. Each layer's `origin` at this moment is its
 * base position. Allocates once.
 */
export function createParallax(_renderer: Renderer, layers: ParallaxLayerOptions[]): Parallax {
  const list: ParallaxLayer[] = layers.map((l) => ({
    layer: l.layer,
    factorX: l.factorX,
    factorY: l.factorY,
    wrapW: l.wrapW,
    wrapH: l.wrapH,
    params: l.params,
    baseX: l.layer.origin.x,
    baseY: l.layer.origin.y,
    offsetX: 0,
    offsetY: 0,
  }));
  return {
    layers: list,
    update(cameraX, cameraY) {
      for (let i = 0; i < list.length; i++) {
        const l = list[i] as { -readonly [K in keyof ParallaxLayer]: ParallaxLayer[K] };
        l.offsetX = parallaxOffset(cameraX, l.factorX, l.wrapW);
        l.offsetY = parallaxOffset(cameraY, l.factorY, l.wrapH);
        l.layer.origin.x = l.baseX + l.offsetX;
        l.layer.origin.y = l.baseY + l.offsetY;
      }
    },
    draw(frame) {
      for (let i = 0; i < list.length; i++) {
        const l = list[i]!;
        l.layer.draw(frame, l.params);
      }
    },
    destroy() {
      for (const l of list) l.layer.destroy();
    },
  };
}
