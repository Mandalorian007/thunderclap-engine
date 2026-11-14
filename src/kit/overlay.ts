/**
 * The overlay service (ws/kit): the DOM overlay over the surface, with its layout, theme, text
 * scale and the host's safe area.
 */

import type { Host } from '../host';
import type { Surface } from '../platform';
import type { Renderer } from '../render';
import {
  applyTextScale,
  createOverlay,
  followSafeArea,
  type LayoutSpec,
  type Overlay,
  type ThemeOverrides,
} from '../ui';
import type { KitPart, KitService } from './types';

/** The overlay's look and layout (`CreateGameOptions`' `styles`, `layout`, `theme`, `textScale`). */
export interface KitOverlayOptions {
  /** Injects the game's stylesheets, before the overlay adds the engine's. */
  styles?(doc: Document): void;
  /** The overlay's layout (`Layout`; read it as `ctx.ui.layout`). */
  layout?: LayoutSpec;
  /** Token overrides on `defaultTheme`. */
  theme?: ThemeOverrides;
  /** Text scale, 1 = 100%. */
  textScale?: number;
}

/** `createKitOverlay`'s dependencies. */
export interface KitOverlayDeps extends KitOverlayOptions {
  /** The surface the overlay mounts over (its `root`; focus returns to its `canvas`). */
  surface: Surface;
  /** `ui.anchors()` and `ui.floats()` without a camera follow `renderer.camera`. */
  renderer: Renderer;
  design: { readonly width: number; readonly height: number };
  /** A host with `safeArea` pads the layout's regions by it. */
  host?: Host;
}

/** The overlay, mounted on `surface.root`. Needs a DOM. */
export function createKitOverlay(deps: KitOverlayDeps): Overlay {
  const { surface, renderer } = deps;
  deps.styles?.(surface.root.ownerDocument);
  // When a panel closes and its opener can't take focus back, focus returns to the canvas so
  // keys keep reaching the game.
  const overlay = createOverlay({
    parent: surface.root,
    designWidth: deps.design.width,
    designHeight: deps.design.height,
    layout: deps.layout,
    focusHome: () => surface.canvas,
    theme: deps.theme,
    camera: () => renderer.camera,
  });
  if (deps.textScale !== undefined && deps.textScale !== 1) {
    applyTextScale(overlay.root, deps.textScale, (t) => overlay.setTheme(t));
  }
  if (deps.host?.safeArea) followSafeArea(overlay.layout, deps.host.safeArea);
  return overlay;
}

/** `ctx.ui`. */
export interface KitOverlayFields {
  readonly ui: Overlay;
}

/**
 * The overlay service: resized with the surface, its anchors updated after each frame, its
 * caption suspended on device loss; input is blocked while a modal panel is up.
 */
export function withOverlay(opts: KitOverlayOptions = {}): KitService<KitOverlayFields> {
  return {
    setup(core): KitPart<KitOverlayFields> {
      if (!core.dom) throw new Error('withOverlay: the overlay needs a DOM (`dom: false` is set)');
      return {
        fields: {
          ui: createKitOverlay({
            ...opts,
            surface: core.surface,
            renderer: core.renderer,
            design: core.design,
            host: core.host,
          }),
        },
      };
    },
  };
}
