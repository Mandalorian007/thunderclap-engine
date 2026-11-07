/**
 * Tooltips (ws/ui-3): one shared `role="tooltip"` element per overlay that follows either a DOM
 * element (hover after a delay and focus show it; pointer leave, blur and Escape hide it) or a
 * world point (an `AnchorHandle` or `[x, y, z]`, riding `Anchors` and hidden with it). The
 * element lives on the `toasts` layer, which is never inert, so a tooltip reads over a modal
 * panel's controls as well as over the HUD. Placement is the pure `placeTooltip`: the asked
 * side, flipped to its opposite when it would leave the layer, centred on the anchor and clamped.
 */
import type { AnchorHandle, Anchors } from './anchor';
import { h } from './dom';
import type { Rect } from './overlay';
import { toFrameUnits } from './text-scale';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';
export type TooltipPlacement = TooltipSide | 'auto';

/** What a tooltip follows: an element, an anchored element, or a world point. */
export type TooltipTarget = HTMLElement | AnchorHandle | ArrayLike<number>;

export interface TooltipOptions {
  /** ms from pointer enter to show (focus shows at once). Default 400. */
  delay?: number;
  /** The side of the target to sit on; `auto` tries top, bottom, right, left. Default `auto`. */
  placement?: TooltipPlacement;
  /** Draw the arrow. Default true. */
  arrow?: boolean;
  /** Keep it up while the pointer is over the tooltip itself (links, buttons). Default false. */
  interactive?: boolean;
  /** CSS px between the target and the tooltip. Default 8. */
  gap?: number;
}

export interface Tooltip {
  /** The overlay's shared tooltip element (`role="tooltip"`). */
  readonly element: HTMLElement;
  readonly target: TooltipTarget;
  /** True while this tooltip owns the shared element and it is shown. */
  readonly visible: boolean;
  /** The side it landed on (`placeTooltip`'s choice), or null while hidden. */
  readonly placement: TooltipSide | null;
  set(content: string | Node): void;
  show(): void;
  hide(): void;
  /** Unhook the target (and drop a world point's anchor). */
  dispose(): void;
}

/** What the tooltips need from their overlay (`Overlay` fits). */
export interface TooltipHost {
  readonly layers: { readonly hud: HTMLElement; readonly toasts: HTMLElement };
  /** The overlay's box: in `css` units the toasts layer covers it. */
  readonly rect: Readonly<Rect>;
  /**
   * @deprecated (ws/ui-4) The frame is read from `anchors().frame.rect` once a camera built the
   * anchors; this is only read before then (an element target with no camera yet).
   */
  readonly frame?: Readonly<Rect>;
  /** In `frame` units the toasts layer is the frame (`anchors().frame.rect`), else the box. */
  readonly units: 'frame' | 'css';
  /** The overlay's `Anchors`; throws until a camera built it. Needed for world-point targets. */
  anchors(): Anchors;
}

/** The overlay's tooltip set: one element, many targets. */
export interface Tooltips {
  readonly element: HTMLElement;
  /** The tooltip showing now, if any. */
  readonly active: Tooltip | null;
  tooltip(target: TooltipTarget, content: string | Node, opts?: TooltipOptions): Tooltip;
  /** Re-place a shown world tooltip (after `anchors.update()`); `overlay.updateAnchors` calls it. */
  update(): void;
  dispose(): void;
}

export interface TooltipPlace {
  x: number;
  y: number;
  side: TooltipSide;
  /** The arrow's distance along the tooltip's near edge, from its left or top. */
  arrow: number;
}

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};
const ORDER: readonly TooltipSide[] = ['top', 'bottom', 'right', 'left'];

/**
 * Where a tooltip of `size` goes beside `anchor` inside `frame` (same units). `auto` takes the
 * first of top, bottom, right, left that fits, else the side with the most room; a named side
 * flips to its opposite when it does not fit and the opposite does. The box is centred on the
 * anchor along the other axis and clamped into the frame; `arrow` says where the anchor's centre
 * is along the near edge, kept `inset` from the corners.
 */
export function placeTooltip(
  anchor: Rect,
  size: { width: number; height: number },
  frame: Rect,
  placement: TooltipPlacement = 'auto',
  gap = 8,
  inset = 12,
): TooltipPlace {
  const room: Record<TooltipSide, number> = {
    top: anchor.y - frame.y - gap,
    bottom: frame.y + frame.height - (anchor.y + anchor.height) - gap,
    right: frame.x + frame.width - (anchor.x + anchor.width) - gap,
    left: anchor.x - frame.x - gap,
  };
  const fits = (s: TooltipSide) =>
    room[s] >= (s === 'left' || s === 'right' ? size.width : size.height);
  let side: TooltipSide;
  if (placement === 'auto') {
    side = ORDER.find(fits) ?? ORDER.reduce((a, b) => (room[b] > room[a] ? b : a));
  } else {
    side = placement;
    if (!fits(side) && fits(OPPOSITE[side])) side = OPPOSITE[side];
  }
  const cx = anchor.x + anchor.width / 2;
  const cy = anchor.y + anchor.height / 2;
  let x: number;
  let y: number;
  switch (side) {
    case 'top':
      x = cx - size.width / 2;
      y = anchor.y - gap - size.height;
      break;
    case 'bottom':
      x = cx - size.width / 2;
      y = anchor.y + anchor.height + gap;
      break;
    case 'right':
      x = anchor.x + anchor.width + gap;
      y = cy - size.height / 2;
      break;
    case 'left':
      x = anchor.x - gap - size.width;
      y = cy - size.height / 2;
      break;
  }
  x = Math.max(frame.x, Math.min(frame.x + frame.width - size.width, x));
  y = Math.max(frame.y, Math.min(frame.y + frame.height - size.height, y));
  const along = side === 'top' || side === 'bottom' ? cx - x : cy - y;
  const span = side === 'top' || side === 'bottom' ? size.width : size.height;
  const arrow = Math.max(inset, Math.min(span - inset, along));
  return { x, y, side, arrow };
}

let tooltipCounter = 0;

const isAnchorHandle = (t: TooltipTarget): t is AnchorHandle =>
  typeof t === 'object' && t !== null && 'el' in t && typeof (t as AnchorHandle).set === 'function';

interface Entry {
  readonly target: TooltipTarget;
  content: string | Node;
  readonly handle: AnchorHandle | null;
  /** True for a world point's proxy, which sits on the tooltip's own layer (no offset). */
  readonly ownsHandle: boolean;
  readonly asked: TooltipPlacement;
  readonly gap: number;
  readonly arrow: boolean;
  readonly interactive: boolean;
  x: number;
  y: number;
  arrowAt: number;
  side: TooltipSide | null;
  showTimer: ReturnType<typeof setTimeout> | null;
  tip: Tooltip;
}

/** One shared tooltip element on the host's `toasts` layer. See the module comment. */
export function createTooltips(host: TooltipHost): Tooltips {
  const layer = host.layers.toasts;
  const doc = layer.ownerDocument;
  ensureTooltipStyles(doc);
  const id = `tc-tooltip-${++tooltipCounter}`;
  const body = h('div', { class: 'tc-tooltip-body' });
  const arrowEl = h('span', { class: 'tc-tooltip-arrow', 'aria-hidden': 'true' });
  const element = h(
    'div',
    { class: 'tc-tooltip', role: 'tooltip', id, hidden: true },
    body,
    arrowEl,
  );
  layer.append(element);

  let active: Entry | null = null;
  let hoveringTip = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const anchorRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  const frameRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  const size = { width: 0, height: 0 };
  const NO_FRAME: Readonly<Rect> = { x: 0, y: 0, width: 0, height: 0 };
  // The overlay's anchors once a world point built them: their frame is the one source for
  // where the frame is (ws/ui-4); before that the host's own (deprecated) `frame`.
  let anchors: Anchors | null = null;
  const frameOf = (): Readonly<Rect> => anchors?.frame.rect ?? host.frame ?? NO_FRAME;

  function place(entry: Entry): void {
    const t = entry.target;
    if (t instanceof HTMLElement) {
      const lr = layer.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      anchorRect.x = r.left - lr.left;
      anchorRect.y = r.top - lr.top;
      anchorRect.width = r.width;
      anchorRect.height = r.height;
    } else {
      const handle = entry.handle!;
      if (!handle.visible) {
        if (!element.hidden) element.hidden = true;
        entry.side = null;
        return;
      }
      // Our proxy rides the tooltip layer; a caller's handle rides the hud layer (the frame),
      // which the toasts layer only matches in frame units (in css units it is the whole root).
      const shift = entry.ownsHandle || host.units === 'frame';
      const fr = frameOf();
      anchorRect.x = handle.x + (shift ? 0 : fr.x);
      anchorRect.y = handle.y + (shift ? 0 : fr.y);
      anchorRect.width = 0;
      anchorRect.height = 0;
    }
    if (element.hidden) element.hidden = false;
    size.width = element.offsetWidth;
    size.height = element.offsetHeight;
    const box = host.units === 'frame' ? frameOf() : host.rect;
    frameRect.width = box.width;
    frameRect.height = box.height;
    const p = placeTooltip(anchorRect, size, frameRect, entry.asked, entry.gap);
    if (p.x !== entry.x || p.y !== entry.y) {
      entry.x = p.x;
      entry.y = p.y;
      element.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    if (p.side !== entry.side) {
      entry.side = p.side;
      element.dataset.placement = p.side;
    }
    if (p.arrow !== entry.arrowAt) {
      entry.arrowAt = p.arrow;
      element.style.setProperty('--tc-tooltip-arrow', `${p.arrow}px`);
    }
  }

  const clearShow = (entry: Entry) => {
    if (entry.showTimer) {
      clearTimeout(entry.showTimer);
      entry.showTimer = null;
    }
  };

  function activate(entry: Entry): void {
    clearShow(entry);
    if (active && active !== entry) deactivate(active);
    active = entry;
    body.replaceChildren(entry.content);
    element.toggleAttribute('data-interactive', entry.interactive);
    element.toggleAttribute('data-no-arrow', !entry.arrow);
    if (entry.target instanceof HTMLElement) entry.target.setAttribute('aria-describedby', id);
    entry.x = entry.y = entry.arrowAt = Number.NaN;
    place(entry);
  }

  function deactivate(entry: Entry): void {
    clearShow(entry);
    if (entry.target instanceof HTMLElement) entry.target.removeAttribute('aria-describedby');
    if (active === entry) {
      active = null;
      element.hidden = true;
      entry.side = null;
    }
  }

  element.addEventListener('pointerenter', () => {
    hoveringTip = true;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  element.addEventListener('pointerleave', () => {
    hoveringTip = false;
    if (active?.interactive) deactivate(active);
  });

  return {
    element,
    get active() {
      return active ? active.tip : null;
    },
    tooltip(target, content, opts = {}) {
      const isEl = target instanceof HTMLElement;
      let handle: AnchorHandle | null = null;
      let ownsHandle = false;
      if (!isEl) {
        if (isAnchorHandle(target)) handle = target;
        else {
          // A world point: a zero-size proxy on the hud layer rides the anchors.
          const proxy = h('span', { class: 'tc-tooltip-anchor', 'aria-hidden': 'true' });
          anchors = host.anchors();
          handle = anchors.add(proxy, target, { layer: 'toasts' });
          ownsHandle = true;
        }
      }
      const delay = opts.delay ?? 400;
      const onEnter = () => {
        if (active === entry) return;
        clearShow(entry);
        entry.showTimer = setTimeout(() => {
          entry.showTimer = null;
          activate(entry);
        }, delay);
      };
      const onLeave = () => {
        clearShow(entry);
        if (active !== entry) return;
        if (!entry.interactive) {
          deactivate(entry);
          return;
        }
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          hideTimer = null;
          if (!hoveringTip && active === entry) deactivate(entry);
        }, 120);
      };
      const onFocus = () => activate(entry);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && active === entry) deactivate(entry);
      };
      const tip: Tooltip = {
        element,
        target,
        get visible() {
          return active === entry && !element.hidden;
        },
        get placement() {
          return active === entry ? entry.side : null;
        },
        set(c) {
          entry.content = c;
          if (active === entry) {
            body.replaceChildren(c);
            entry.x = Number.NaN;
            place(entry);
          }
        },
        show() {
          activate(entry);
        },
        hide() {
          deactivate(entry);
        },
        dispose() {
          deactivate(entry);
          if (isEl) {
            target.removeEventListener('pointerenter', onEnter);
            target.removeEventListener('pointerleave', onLeave);
            target.removeEventListener('focus', onFocus);
            target.removeEventListener('blur', onLeave);
            target.removeEventListener('keydown', onKey);
          }
          if (ownsHandle) handle?.remove();
        },
      };
      const entry: Entry = {
        target,
        content,
        handle,
        ownsHandle,
        asked: opts.placement ?? 'auto',
        gap: opts.gap ?? 8,
        arrow: opts.arrow ?? true,
        interactive: opts.interactive ?? false,
        x: Number.NaN,
        y: Number.NaN,
        arrowAt: Number.NaN,
        side: null,
        showTimer: null,
        tip,
      };
      if (isEl) {
        target.addEventListener('pointerenter', onEnter);
        target.addEventListener('pointerleave', onLeave);
        target.addEventListener('focus', onFocus);
        target.addEventListener('blur', onLeave);
        target.addEventListener('keydown', onKey);
      } else {
        // A world tooltip has no hover: it shows at once and rides the anchor.
        activate(entry);
      }
      return tip;
    },
    update() {
      if (active && !(active.target instanceof HTMLElement)) place(active);
    },
    dispose() {
      if (active) deactivate(active);
      element.remove();
    },
  };
}

/**
 * Stylesheet for the tooltip (design px, theme tokens).
 *
 * @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Leaves the `ui` entry next
 * minor; tests import it from this file.
 */
export const TOOLTIP_CSS = toFrameUnits(`
.tc-tooltip { position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform; box-sizing: border-box;
  max-width: 560px; padding: var(--tc-space-2) var(--tc-space-3); font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s);
  line-height: 1.35; color: var(--tc-color-text); background: var(--tc-color-surface);
  border: var(--tc-border-width) solid var(--tc-color-border); border-radius: var(--tc-radius-m); box-shadow: var(--tc-shadow);
  animation: tc-fade var(--tc-duration-fast) var(--tc-easing); }
.tc-tooltip[hidden] { display: none; }
.tc-tooltip[data-interactive] { pointer-events: auto; }
.tc-tooltip-body { overflow-wrap: break-word; }
.tc-tooltip-arrow { position: absolute; width: 16px; height: 16px; background: var(--tc-color-surface);
  border: var(--tc-border-width) solid var(--tc-color-border); transform: rotate(45deg); }
.tc-tooltip[data-no-arrow] .tc-tooltip-arrow { display: none; }
.tc-tooltip[data-placement="top"] .tc-tooltip-arrow { left: var(--tc-tooltip-arrow, 50%); bottom: -9px; margin-left: -8px; border-top: 0; border-left: 0; }
.tc-tooltip[data-placement="bottom"] .tc-tooltip-arrow { left: var(--tc-tooltip-arrow, 50%); top: -9px; margin-left: -8px; border-bottom: 0; border-right: 0; }
.tc-tooltip[data-placement="left"] .tc-tooltip-arrow { top: var(--tc-tooltip-arrow, 50%); right: -9px; margin-top: -8px; border-bottom: 0; border-left: 0; }
.tc-tooltip[data-placement="right"] .tc-tooltip-arrow { top: var(--tc-tooltip-arrow, 50%); left: -9px; margin-top: -8px; border-top: 0; border-right: 0; }
.tc-tooltip-anchor { width: 0; height: 0; }
`);

const STYLE_ID = 'tc-ui-tooltip';

/** Add `TOOLTIP_CSS` to `doc` once (the first tooltip does it). */
export function ensureTooltipStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TOOLTIP_CSS;
  doc.head.appendChild(style);
}
