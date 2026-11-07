import { type AnchorCamera, Anchors } from './anchor';
import { CaptionCard, type CaptionOptions } from './caption';
import { type CursorOptions, createCursor, type WorldCursor } from './cursor';
import { h } from './dom';
import { createFloats, type Floats, type FloatsOptions } from './floats';
import {
  createHeading,
  createMeter,
  createReticle,
  createSlots,
  type Heading,
  type HeadingOptions,
  type Meter,
  type MeterOptions,
  type Reticle,
  type ReticleOptions,
  type Slots,
  type SlotsOptions,
} from './hud';
import { ensureInventoryStyles } from './inventory';
import { type Card, type CardOptions, card as createCard } from './inventory-card';
import {
  type ContextItem,
  type ContextList,
  type ContextListOptions,
  contextList as createContextList,
} from './inventory-context';
import { createDragContext, type DragContext } from './inventory-drag';
import { grid as createGrid, type Grid, type GridOptions } from './inventory-grid';
import { radial as createRadial, type Radial, type RadialOptions } from './inventory-radial';
import { createLayout, type Layout, type LayoutSpec, type Units } from './layout';
import { createLoading, type LoadingOptions, type LoadingScreen } from './loading';
import {
  type CanvasMinimap,
  type CanvasMinimapOptions,
  createCanvasMinimap,
} from './minimap-canvas';
import { createNotifier, type Notification, type Notifier, type NotifyOptions } from './notify';
import { type PadOwner, PanelStack } from './stack';
import { ensureStyles } from './styles';
import {
  CSS_FONT_PX,
  DESIGN_FONT_PX,
  TEXT_SCALE_VAR,
  textScaleTokens,
  toFrameUnits,
} from './text-scale';
import { cssPxTheme, defaultTheme, type ThemeOverrides, tokenVar } from './theme';
import { Toaster } from './toast';
import {
  createTooltips,
  type Tooltip,
  type TooltipOptions,
  type Tooltips,
  type TooltipTarget,
} from './tooltip';
import { ensureWidgets2Styles } from './widgets-2';
import {
  type Compass,
  type CompassOptions,
  createCompass,
  createRing,
  type Ring,
  type RingOptions,
} from './widgets-3';

/**
 * The attribute holding an overlay control's stable id (ws/input-12). `ButtonOptions.id` sets
 * it; any `<button>` may carry it. It wins over the derived id (`controlId`).
 */
export const CONTROL_ID_ATTR = 'data-tc-id';

/**
 * The attribute naming the page a derived control id starts with (ws/input-12): put it on a
 * screen's container (`data-tc-page="settings"`). Without one, a panel's accessible name (its
 * `title` or `label`) is the page.
 */
export const CONTROL_PAGE_ATTR = 'data-tc-page';

/** The page of a control: the nearest `CONTROL_PAGE_ATTR`, else its panel's accessible name. */
function controlPage(el: Element): string {
  const marked = el.closest(`[${CONTROL_PAGE_ATTR}]`);
  if (marked) return marked.getAttribute(CONTROL_PAGE_ATTR) ?? '';
  const panel = el.closest('[role="dialog"],[role="alertdialog"]');
  if (!panel) return '';
  const label = panel.getAttribute('aria-label');
  if (label) return label;
  const by = panel.getAttribute('aria-labelledby');
  const title = by ? panel.ownerDocument.getElementById(by) : null;
  return title?.textContent?.trim() ?? '';
}

/** A control's id before the duplicate suffix: `page/key`, `key` off any page; null with no key. */
function baseControlId(el: Element): string | null {
  const own = el.getAttribute(CONTROL_ID_ATTR);
  if (own) return own;
  const key = el.getAttribute('aria-label') || el.textContent?.trim() || '';
  if (!key) return null;
  const page = controlPage(el);
  return page ? `${page}/${key}` : key;
}

/**
 * The stable id of an overlay control (ws/input-12): what a recording stores when it fires, so
 * a replay finds the same control by id, never by DOM node. It is the button's
 * `CONTROL_ID_ATTR` (`ButtonOptions.id`) when set; otherwise `page/key`, where the page is the
 * nearest `CONTROL_PAGE_ATTR` or the panel's accessible name (omitted outside both) and the key
 * the button's `aria-label` or text. A derived id shared by earlier buttons in `root` gets
 * `#2`, `#3`, … in document order. Null for an element with no id and no label (it cannot be
 * recorded).
 */
export function controlId(el: Element, root: ParentNode = el.ownerDocument): string | null {
  const base = baseControlId(el);
  if (base === null || el.hasAttribute(CONTROL_ID_ATTR)) return base;
  let n = 1;
  for (const other of root.querySelectorAll('button')) {
    if (other === el) break;
    if (!other.hasAttribute(CONTROL_ID_ATTR) && baseControlId(other) === base) n++;
  }
  return n > 1 ? `${base}#${n}` : base;
}

/** The first enabled `<button>` in `root` whose `controlId` is `id`, or null. */
function findControl(root: HTMLElement, id: string): HTMLButtonElement | null {
  const seen = new Map<string, number>();
  for (const el of root.querySelectorAll('button')) {
    let cid = baseControlId(el);
    if (cid === null) continue;
    if (!el.hasAttribute(CONTROL_ID_ATTR)) {
      const n = (seen.get(cid) ?? 0) + 1;
      seen.set(cid, n);
      if (n > 1) cid = `${cid}#${n}`;
    }
    if (cid === id && !el.disabled) return el;
  }
  return null;
}

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
  /** The frame's logical size (the canvas's design size). Default 1920×1080. */
  designWidth?: number;
  designHeight?: number;
  /** Region tracks per form factor and the form-factor rule (see `Layout`). */
  layout?: LayoutSpec;
  /**
   * Token overrides on top of `defaultTheme`. Sizes are design px: in `frame` units they scale
   * with the frame, in `css` units they are taken as CSS px.
   */
  theme?: ThemeOverrides;
  caption?: CaptionOptions;
  /** Max simultaneous toasts. Default 3. */
  maxToasts?: number;
  /**
   * Where focus goes when the last panel closes and its opener can't or shouldn't get it
   * back (typically the canvas). See `PanelStackFocusOptions.home` and `NO_RESTORE_FOCUS_ATTR`.
   */
  focusHome?: () => HTMLElement | null;
  /**
   * The camera `anchors()` and `floats()` use when called without one (ws/api-core), read each
   * frame. `createGame` passes `() => ctx.camera`. Without it the first `anchors` call needs one.
   */
  camera?: () => AnchorCamera;
}

export interface Overlay {
  /** `.tc-overlay`: the whole parent, in CSS px. */
  readonly root: HTMLElement;
  /**
   * Layers, bottom to top, all in CSS px.
   * - `hud` and `captions` cover the **frame** (the canvas rect; see `frame`) and clip to it:
   *   world-anchored DOM goes in `hud`, at design coordinates times `--tc-dpx`.
   * - `layout` covers the whole overlay: the layout's regions (`layout`).
   * - `panels` and `toasts` cover the frame in `frame` units and the whole overlay in `css`
   *   units (see `units`).
   */
  readonly layers: {
    hud: HTMLElement;
    captions: HTMLElement;
    layout: HTMLElement;
    panels: HTMLElement;
    toasts: HTMLElement;
  };
  readonly stack: PanelStack;
  readonly toasts: Toaster;
  readonly caption: CaptionCard;
  /** Regions per form factor over the whole overlay; it also picks `units`. */
  readonly layout: Layout;
  /**
   * How the base UI (theme, panels, toasts, captions) is sized in the current form factor (the
   * layout's `FormSpec.units`, also `data-units` on the root):
   * - `frame`: design px scaled with the frame (`--tc-dpx` CSS px each), so the UI keeps its
   *   proportions to the canvas, as a fixed 16:9 game does on desktops and tablets;
   * - `css`: CSS px (`cssPxTheme`), so text and targets keep a readable size on a small screen.
   */
  readonly units: Units;
  /** CSS px per design px of the frame (`--tc-dpx`). */
  readonly scale: number;
  /** The overlay's own box, CSS px (the parent's size; x and y are 0). */
  readonly rect: Readonly<Rect>;
  /** The frame: the canvas rect in overlay CSS px (`--tc-frame-x/y/w/h`). */
  readonly frame: Readonly<Rect>;
  /** Place the frame over the canvas and re-measure the parent. Call on every resize. */
  setFrame(frame: Rect): void;
  /** Called after every `setFrame` (the layout follows it). Returns unsubscribe. */
  onResize(fn: (frame: Readonly<Rect>) => void): () => void;
  /** Apply token overrides (sizes in design px, as `OverlayOptions.theme`). */
  setTheme(theme: ThemeOverrides): void;
  /**
   * Client (CSS px, viewport) → frame coordinates (design px), or null outside the frame. Uses
   * the parent's bounding box.
   */
  clientToDesign(clientX: number, clientY: number): { x: number; y: number } | null;
  /**
   * The overlay's one `Anchors` (DOM that follows world points; see `ui/anchor.ts`), built on the
   * first call with `camera` and laid on the `hud` layer (other layers by name through
   * `AnchorOptions.layer`). A later call with a camera switches it. Without one the first call
   * uses `OverlayOptions.camera` (the game's camera under `createGame`) and throws when that
   * is unset too.
   */
  anchors(camera?: () => AnchorCamera): Anchors;
  /** `anchors().update()` if `anchors` was ever called, else nothing. `createGame` calls it after every frame. */
  updateAnchors(): void;
  /** A reticle centred on the frame (`hud` layer), hidden while a modal is open (`ui/hud.ts`). */
  reticle(opts?: ReticleOptions): Reticle;
  /** A `role="meter"` bar in a layout region. */
  meter(opts?: MeterOptions): Meter;
  /** A strip of slots with key-hint badges and a selected highlight, in a layout region. */
  slots(opts: SlotsOptions): Slots;
  /** A sliding cardinal strip driven by `setYaw`, in a layout region. */
  heading(opts?: HeadingOptions): Heading;
  /** An item grid (`ui/inventory-grid.ts`), registered with `drag`; the game appends `element`. */
  grid(opts: GridOptions): Grid;
  /** An item card (tooltip) on the `hud` layer (`ui/inventory-card.ts`). */
  card(opts: CardOptions): Card;
  /** A radial menu on the `hud` layer, hidden under a modal (`ui/inventory-radial.ts`). */
  radial(opts: RadialOptions): Radial;
  /** A context list on the `toasts` layer, open until picked or cancelled (`ui/inventory-context.ts`). */
  contextList(items: ContextItem[], opts: ContextListOptions): ContextList;
  /** The drag context grids and `slotsTarget`s register with; made on first use (`ui/inventory-drag.ts`). */
  readonly drag: DragContext;
  /**
   * A tooltip on an element (hover after `delay`, focus; leave, blur, Escape hide) or a world
   * point (rides `anchors()`), in the overlay's one shared `role="tooltip"` element on the
   * `toasts` layer (`ui/tooltip.ts`).
   */
  tooltip(target: TooltipTarget, content: string | Node, opts?: TooltipOptions): Tooltip;
  /** The shared tooltip element and the tooltip showing now; made on first use. */
  readonly tooltips: Tooltips;
  /** A pad/keyboard world cursor on the `hud` layer, yielding to modal panels (`ui/cursor.ts`). */
  cursor(opts: CursorOptions): WorldCursor;
  /** `stack.padOwner`: `'stack'` while a modal panel has the gamepad, else `'game'` (ws/ui-4). */
  readonly padOwner: PadOwner;
  /**
   * The overlay's floating text on the `hud` layer (`ui/floats.ts`), made by the first call:
   * `camera` goes to `anchors(camera)` (omitted: `OverlayOptions.camera`, the game's camera
   * under `createGame`) and `opts` set the pool. Later calls return the same
   * `Floats` (their arguments are ignored); `createFloats(ui, camera, opts)` makes another.
   * Call `floats.update(dt)` once per update (ws/ui-6).
   */
  floats(camera?: () => AnchorCamera, opts?: FloatsOptions): Floats;
  /** A radial progress ring in a layout region (`ui/widgets-3.ts`). */
  ring(opts?: RingOptions): Ring;
  /** A compass strip with bearing markers in a layout region (`ui/widgets-3.ts`). */
  compass(opts?: CompassOptions): Compass;
  /**
   * A canvas minimap of a bounded world in a layout region: markers by kind, the player's arrow,
   * north- or player-up, tap to pick (`ui/minimap-canvas.ts`, ws/ui-6).
   */
  minimap(opts: CanvasMinimapOptions): CanvasMinimap;
  /** A loading screen on the `panels` layer; root `aria-busy` while shown (`ui/loading.ts`). */
  loading(opts?: LoadingOptions): LoadingScreen;
  /** A notification card stacked top-right on the `toasts` layer (`ui/notify.ts`). */
  notify(opts: NotifyOptions): Notification;
  /** The notification stack (`dismissAll`, the `menuNav` root); made on first use. */
  readonly notifications: Notifier;
  /**
   * Called when a `<button>` in the overlay is clicked (a pointer, Enter or Space, a pad's A
   * through `PadNav`, or `activate`), before its own handlers, with its stable id (`controlId`;
   * ws/input-12). Buttons with no id are skipped. `createGame` feeds it to `ctx.input.control`,
   * so a recording carries it. Returns unsubscribe.
   */
  onControl(fn: (id: string, el: HTMLElement) => void): () => void;
  /**
   * Click the enabled overlay button whose `controlId` is `id` (ws/input-12): what a replay does
   * for a recorded control. Its handlers run now, and `onControl` sees it. False when no such
   * button is in the overlay.
   */
  activate(id: string): boolean;
  destroy(): void;
}

/**
 * The DOM overlay: one root over the whole parent, laid out in CSS px on every form factor. The
 * frame (the canvas rect) is exposed as CSS custom properties on the root, `--tc-frame-x/y/w/h`
 * and `--tc-dpx` (one design px in CSS px), and the `hud` and `captions` layers sit on it, so
 * DOM anchored to the world is placed at `logicalToClient` of its design coordinates. The
 * layout's regions (`overlay.layout`) cover the whole overlay. The root is
 * `pointer-events: none`; only interactive children take the pointer, so clicks on empty space
 * fall through to the canvas.
 */
export function createOverlay(opts: OverlayOptions): Overlay {
  const doc = opts.parent.ownerDocument;
  ensureStyles(doc);
  ensureWidgets2Styles(doc);
  ensureInventoryStyles(doc);
  const dw = opts.designWidth ?? 1920;
  const dh = opts.designHeight ?? 1080;

  const layer = (name: string) => h('div', { class: 'tc-layer', dataset: { layer: name } });
  const layers = {
    hud: layer('hud'),
    captions: layer('captions'),
    layout: layer('layout'),
    panels: layer('panels'),
    toasts: layer('toasts'),
  };
  const root = h(
    'div',
    { class: 'tc-overlay' },
    layers.hud,
    layers.captions,
    layers.layout,
    layers.panels,
    layers.toasts,
  );
  opts.parent.append(root);

  // Captions, HUD and regions go inert under a modal; toasts stay readable.
  const stack = new PanelStack(layers.panels, [layers.hud, layers.captions, layers.layout], {
    home: opts.focusHome,
  });
  const toasts = new Toaster(layers.toasts, opts.maxToasts ?? 3);
  const caption = new CaptionCard(layers.captions, opts.caption);
  // A modal hides the caption and pauses it, so a line is never read through (or lost under) a
  // dialog; it picks up again when the last modal closes.
  const unwatch = stack.onChange((s) => caption.suspend(s.hasModal));

  const measure = (): Rect => ({
    x: 0,
    y: 0,
    width: opts.parent.clientWidth,
    height: opts.parent.clientHeight,
  });
  let rect = measure();
  let frame: Rect = { ...rect };
  let scale = 1;
  let units: Units = 'frame';
  const subs = new Set<(r: Readonly<Rect>) => void>();

  // Theme: the defaults, the game's overrides (design px), then the text-scale tokens, written
  // in the current units.
  const overrides: Record<string, string> = { ...opts.theme };
  const writeTheme = (tokens: Record<string, string>) => {
    for (const [k, v] of Object.entries(tokens)) {
      let css = units === 'frame' ? toFrameUnits(v) : v;
      // Outlines snap down to whole pixels; a scaled ring (the old transform) was drawn
      // antialiased at its full width. Round up so the focus ring never thins.
      if (units === 'frame' && k === 'focusRing') css = `round(up, ${css}, 1px)`;
      root.style.setProperty(tokenVar(k), css);
    }
  };
  const applyUnits = (u: Units) => {
    units = u;
    root.dataset.units = u;
    writeTheme({ ...defaultTheme, ...(u === 'css' ? cssPxTheme : {}), ...overrides });
    // A text scale already applied (`applyTextScale`) is re-derived for the new units.
    const ts = Number.parseFloat(root.style.getPropertyValue(TEXT_SCALE_VAR));
    if (ts > 0) writeTheme(textScaleTokens(ts, u === 'css' ? CSS_FONT_PX : DESIGN_FONT_PX));
  };

  const place = (f: Rect) => {
    frame = { ...f };
    rect = measure();
    scale = Math.min(f.width / dw, f.height / dh) || 1;
    const s = root.style;
    s.setProperty('--tc-frame-x', `${f.x}px`);
    s.setProperty('--tc-frame-y', `${f.y}px`);
    s.setProperty('--tc-frame-w', `${f.width}px`);
    s.setProperty('--tc-frame-h', `${f.height}px`);
    s.setProperty('--tc-dpx', `${scale}px`);
    // The same scale as a number, for `zoom` on native controls (ui/styles.ts).
    s.setProperty('--tc-zoom', String(scale));
  };
  place(frame);
  applyUnits('frame');
  const layout = createLayout(
    {
      root,
      layers,
      caption,
      get rect() {
        return rect;
      },
      onResize: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
    opts.layout,
  );
  applyUnits(layout.state.units);
  const offLayout = layout.onChange((st) => {
    if (st.units !== units) applyUnits(st.units);
  });

  let anchors: Anchors | null = null;
  let drag: DragContext | null = null;
  let tooltips: Tooltips | null = null;
  let notifications: Notifier | null = null;
  let floats: Floats | null = null;

  // Overlay controls (ws/input-12): one capture listener names every button click by id.
  const controlSubs = new Set<(id: string, el: HTMLElement) => void>();
  const onClick = (e: Event): void => {
    if (controlSubs.size === 0) return;
    const t = e.target as Element | null;
    const el = t?.closest?.('button');
    if (!el || !root.contains(el)) return;
    const id = controlId(el, root);
    if (id === null) return;
    for (const fn of controlSubs) fn(id, el);
  };
  root.addEventListener('click', onClick, true);

  const overlay: Overlay = {
    root,
    layers,
    stack,
    toasts,
    caption,
    layout,
    get units() {
      return units;
    },
    get scale() {
      return scale;
    },
    get rect() {
      return rect;
    },
    get frame() {
      return frame;
    },
    setFrame(f) {
      place(f);
      for (const fn of subs) fn(frame);
    },
    onResize(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setTheme(theme) {
      Object.assign(overrides, theme);
      writeTheme(theme);
    },
    clientToDesign(cx, cy) {
      const pb = opts.parent.getBoundingClientRect();
      const x = (cx - pb.left - frame.x) / scale;
      const y = (cy - pb.top - frame.y) / scale;
      return x >= 0 && y >= 0 && x <= dw && y <= dh ? { x, y } : null;
    },
    anchors(camera) {
      if (anchors) {
        if (camera) anchors.setCamera(camera);
        return anchors;
      }
      const cam = camera ?? opts.camera;
      if (!cam) throw new Error('overlay.anchors: the first call needs a camera');
      anchors = new Anchors({
        root: layers.hud,
        camera: cam,
        // The frame is the canvas rect; the design size is the logical size it shows.
        surface: {
          get rect() {
            return frame;
          },
          logicalWidth: dw,
          logicalHeight: dh,
        },
        layers,
        // hud and captions sit on the frame; layout covers the root; panels and toasts follow units.
        onFrame: (l) =>
          l === 'hud' ||
          l === 'captions' ||
          ((l === 'panels' || l === 'toasts') && units === 'frame'),
      });
      return anchors;
    },
    updateAnchors() {
      anchors?.update();
      tooltips?.update();
    },
    reticle(o) {
      return createReticle(overlay, o);
    },
    meter(o) {
      return createMeter(overlay, o);
    },
    slots(o) {
      return createSlots(overlay, o);
    },
    heading(o) {
      return createHeading(overlay, o);
    },
    grid(o) {
      const g = createGrid(o);
      overlay.drag.register(g);
      return g;
    },
    card(o) {
      return createCard(overlay, o);
    },
    radial(o) {
      return createRadial(overlay, o);
    },
    contextList(items, o) {
      return createContextList(overlay, items, o);
    },
    get drag() {
      drag ??= createDragContext(overlay);
      return drag;
    },
    get tooltips() {
      tooltips ??= createTooltips(overlay);
      return tooltips;
    },
    tooltip(target, content, o) {
      return overlay.tooltips.tooltip(target, content, o);
    },
    cursor(o) {
      return createCursor(overlay, o);
    },
    get padOwner() {
      return stack.padOwner;
    },
    floats(camera, o) {
      floats ??= createFloats(overlay, camera, o);
      return floats;
    },
    ring(o) {
      return createRing(overlay, o);
    },
    compass(o) {
      return createCompass(overlay, o);
    },
    minimap(o) {
      return createCanvasMinimap(overlay, o);
    },
    loading(o) {
      return createLoading(overlay, o);
    },
    get notifications() {
      notifications ??= createNotifier(layers.toasts);
      return notifications;
    },
    notify(o) {
      return overlay.notifications.notify(o);
    },
    onControl(fn) {
      controlSubs.add(fn);
      return () => controlSubs.delete(fn);
    },
    activate(id) {
      const el = findControl(root, id);
      if (!el) return false;
      el.click();
      return true;
    },
    destroy() {
      root.removeEventListener('click', onClick, true);
      controlSubs.clear();
      drag?.destroy();
      drag = null;
      tooltips?.dispose();
      tooltips = null;
      floats?.dispose();
      floats = null;
      notifications?.dispose();
      notifications = null;
      anchors?.clear();
      anchors = null;
      unwatch();
      offLayout();
      layout.destroy();
      subs.clear();
      stack.destroy();
      caption.destroy();
      toasts.clear();
      root.remove();
    },
  };
  return overlay;
}
