import { CaptionCard, type CaptionOptions } from './caption';
import { h } from './dom';
import { PanelStack } from './stack';
import { ensureStyles } from './styles';
import { applyTheme, cssPxTheme, defaultTheme, type ThemeOverrides } from './theme';
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
  /**
   * `true` (the default until the Phase 2 scene ports land): the UI is laid out at
   * `designWidth`×`designHeight` and one CSS `scale()` shrinks it into the rect, so sizes are
   * design px. `false`: CSS-px mode. The root is the rect itself in CSS px, nothing is scaled,
   * the theme's sizes are CSS px (`cssPxTheme`), `data-units="css"` is set on the root, and
   * `createLayout` can place regions in it.
   */
  legacyScale?: boolean;
  /** Logical size the UI is laid out at with `legacyScale`. Default 1920×1080. Ignored in CSS-px mode. */
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
  /**
   * `.tc-overlay`. With `legacyScale`, sized designWidth×designHeight and scaled into the rect;
   * in CSS-px mode, the rect itself.
   */
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
  /** True for the scaled design-px overlay, false in CSS-px mode. */
  readonly legacyScale: boolean;
  /** Current scale (CSS px per design px); always 1 in CSS-px mode. */
  readonly scale: number;
  readonly rect: Readonly<Rect>;
  /** Position over the letterboxed canvas. Call on every resize. */
  setRect(rect: Rect): void;
  /** Called after every `setRect` (the layout follows it). Returns unsubscribe. */
  onRect(fn: (rect: Readonly<Rect>) => void): () => void;
  /** Apply token overrides. */
  setTheme(theme: ThemeOverrides): void;
  /**
   * Client (CSS px, viewport) → overlay coordinates (design px, or CSS px relative to the rect in
   * CSS-px mode), or null outside. Uses the parent's bounding box.
   */
  clientToDesign(clientX: number, clientY: number): { x: number; y: number } | null;
  destroy(): void;
}

/**
 * The DOM overlay. With `legacyScale` (the default), layout happens at the design resolution and
 * a single CSS transform scales it into the letterboxed rect, so UI sizes are in design pixels
 * and scale with the canvas. With `legacyScale: false` it is laid out in CSS px over the rect.
 * The root is `pointer-events: none`; only interactive children take the pointer, so clicks on
 * empty space fall through to the canvas.
 */
export function createOverlay(opts: OverlayOptions): Overlay {
  const doc = opts.parent.ownerDocument;
  ensureStyles(doc);
  const legacy = opts.legacyScale !== false;
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
    {
      class: 'tc-overlay',
      style: legacy ? { width: `${dw}px`, height: `${dh}px` } : {},
      dataset: legacy ? {} : { units: 'css' },
    },
    layers.hud,
    layers.captions,
    layers.panels,
    layers.toasts,
  );
  applyTheme(root, { ...defaultTheme, ...(legacy ? {} : cssPxTheme), ...opts.theme });
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

  let rect: Rect = legacy
    ? { x: 0, y: 0, width: dw, height: dh }
    : { x: 0, y: 0, width: opts.parent.clientWidth, height: opts.parent.clientHeight };
  let scale = 1;
  const rectSubs = new Set<(r: Readonly<Rect>) => void>();
  // Where the scaled design canvas starts inside the parent (legacy only).
  const origin = () =>
    legacy
      ? { x: rect.x + (rect.width - dw * scale) / 2, y: rect.y + (rect.height - dh * scale) / 2 }
      : { x: rect.x, y: rect.y };

  const overlay: Overlay = {
    root,
    layers,
    stack,
    toasts,
    caption,
    legacyScale: legacy,
    get scale() {
      return scale;
    },
    get rect() {
      return rect;
    },
    setRect(r) {
      rect = { ...r };
      if (legacy) {
        scale = Math.min(r.width / dw, r.height / dh) || 1;
        // Centre inside the rect if its aspect differs from the design's.
        const o = origin();
        root.style.transform = `translate(${o.x}px, ${o.y}px) scale(${scale})`;
      } else {
        scale = 1;
        root.style.width = `${r.width}px`;
        root.style.height = `${r.height}px`;
        root.style.transform = `translate(${r.x}px, ${r.y}px)`;
      }
      for (const f of rectSubs) f(rect);
    },
    onRect(fn) {
      rectSubs.add(fn);
      return () => rectSubs.delete(fn);
    },
    setTheme(theme) {
      applyTheme(root, theme);
    },
    clientToDesign(cx, cy) {
      const pb = opts.parent.getBoundingClientRect();
      const o = origin();
      const x = (cx - pb.left - o.x) / scale;
      const y = (cy - pb.top - o.y) / scale;
      const w = legacy ? dw : rect.width;
      const hh = legacy ? dh : rect.height;
      return x >= 0 && y >= 0 && x <= w && y <= hh ? { x, y } : null;
    },
    destroy() {
      unwatch();
      rectSubs.clear();
      stack.destroy();
      caption.destroy();
      toasts.clear();
      root.remove();
    },
  };
  overlay.setRect(rect);
  return overlay;
}
