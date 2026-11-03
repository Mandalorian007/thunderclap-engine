import { CaptionCard, type CaptionOptions } from './caption';
import { h } from './dom';
import { PanelStack } from './stack';
import { ensureStyles } from './styles';
import { applyTheme, defaultTheme, type ThemeOverrides } from './theme';
import { Toaster } from './toast';

/** A rectangle in CSS pixels relative to the overlay's parent (what platform's letterbox gives). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayOptions {
  /** Element to mount into. It should be `position: relative` (or fixed/absolute) and contain the canvas. */
  parent: HTMLElement;
  /** Logical size the UI is laid out at. Default 1920×1080. */
  designWidth?: number;
  designHeight?: number;
  /** Token overrides on top of `defaultTheme`. */
  theme?: ThemeOverrides;
  caption?: CaptionOptions;
  /** Max simultaneous toasts. Default 3. */
  maxToasts?: number;
  /**
   * Where focus goes when the last panel closes and its opener can't or shouldn't get it
   * back (typically the canvas). See `PanelStackFocusOptions.home` and `NO_RESTORE_FOCUS_ATTR`.
   */
  focusHome?: () => HTMLElement | null;
}

export interface Overlay {
  /** `.tc-overlay`, sized designWidth×designHeight and scaled into the rect. */
  readonly root: HTMLElement;
  /** Layers, bottom to top. Put game HUD in `hud`. Panels sit above captions. */
  readonly layers: {
    hud: HTMLElement;
    captions: HTMLElement;
    panels: HTMLElement;
    toasts: HTMLElement;
  };
  readonly stack: PanelStack;
  readonly toasts: Toaster;
  readonly caption: CaptionCard;
  /** Current scale (CSS px per design px). */
  readonly scale: number;
  readonly rect: Readonly<Rect>;
  /** Position over the letterboxed canvas. Call on every resize. */
  setRect(rect: Rect): void;
  /** Apply token overrides. */
  setTheme(theme: ThemeOverrides): void;
  /** Client (CSS px, viewport) → design coordinates, or null outside. Uses the parent's bounding box. */
  clientToDesign(clientX: number, clientY: number): { x: number; y: number } | null;
  destroy(): void;
}

/**
 * The DOM overlay. Layout happens at the design resolution and a single CSS transform scales it
 * into the letterboxed rect, so UI sizes are in design pixels and scale with the canvas.
 * The root is `pointer-events: none`; only interactive children take the pointer, so clicks on
 * empty space fall through to the canvas.
 */
export function createOverlay(opts: OverlayOptions): Overlay {
  const doc = opts.parent.ownerDocument;
  ensureStyles(doc);
  const dw = opts.designWidth ?? 1920;
  const dh = opts.designHeight ?? 1080;

  const layer = (name: string) => h('div', { class: 'tc-layer', dataset: { layer: name } });
  const layers = {
    hud: layer('hud'),
    captions: layer('captions'),
    panels: layer('panels'),
    toasts: layer('toasts'),
  };
  const root = h(
    'div',
    { class: 'tc-overlay', style: { width: `${dw}px`, height: `${dh}px` } },
    layers.hud,
    layers.captions,
    layers.panels,
    layers.toasts,
  );
  applyTheme(root, { ...defaultTheme, ...opts.theme });
  opts.parent.append(root);

  // Captions and HUD go inert under a modal; toasts stay readable.
  const stack = new PanelStack(layers.panels, [layers.hud, layers.captions], {
    home: opts.focusHome,
  });
  const toasts = new Toaster(layers.toasts, opts.maxToasts ?? 3);
  const caption = new CaptionCard(layers.captions, opts.caption);
  // A modal hides the caption and pauses it, so a line is never read through (or lost under) a
  // dialog; it picks up again when the last modal closes.
  const unwatch = stack.onChange((s) => caption.suspend(s.hasModal));

  let rect: Rect = { x: 0, y: 0, width: dw, height: dh };
  let scale = 1;

  const overlay: Overlay = {
    root,
    layers,
    stack,
    toasts,
    caption,
    get scale() {
      return scale;
    },
    get rect() {
      return rect;
    },
    setRect(r) {
      rect = { ...r };
      scale = Math.min(r.width / dw, r.height / dh) || 1;
      // Centre inside the rect if its aspect differs from the design's.
      const ox = r.x + (r.width - dw * scale) / 2;
      const oy = r.y + (r.height - dh * scale) / 2;
      root.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    },
    setTheme(theme) {
      applyTheme(root, theme);
    },
    clientToDesign(cx, cy) {
      const pb = opts.parent.getBoundingClientRect();
      const ox = rect.x + (rect.width - dw * scale) / 2;
      const oy = rect.y + (rect.height - dh * scale) / 2;
      const x = (cx - pb.left - ox) / scale;
      const y = (cy - pb.top - oy) / scale;
      return x >= 0 && y >= 0 && x <= dw && y <= dh ? { x, y } : null;
    },
    destroy() {
      unwatch();
      stack.destroy();
      caption.destroy();
      toasts.clear();
      root.remove();
    },
  };
  overlay.setRect(rect);
  return overlay;
}
