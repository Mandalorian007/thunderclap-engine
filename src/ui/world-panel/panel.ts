/**
 * World panels (ws/ui-world-panel): a Canvas2D-painted texture on a quad in the scene, with the
 * engine's widgets and theme, hit by the pointer router's rays. Flat screens on walls, a wrist
 * menu in VR, a head-locked HUD: anything a DOM overlay cannot be because it must sit in depth.
 *
 * - The canvas is `width × resolution` by `height × resolution` px; widgets are laid out and hit
 *   in those px. Only the dirty rect is repainted and uploaded, at most once per frame, in
 *   `prepare`; a frame with nothing dirty uploads nothing.
 * - The quad is drawn by `draw` inside the scene pass (`frame.drawable(panel)`), depth-tested by
 *   default; a head-locked panel defaults to `depthTest: false` so the scene never cuts it.
 * - Pointers: `hitTest(ray)` gives panel px; `worldPanelTarget(panel)` is the router's tester;
 *   `poll(router.pointers)` drives hover, press and release from the router each tick, or call
 *   `pointerDown/Move/Up` yourself. Focus walks `focusNext/Prev`, `activate` and `key`.
 */
import type { PointerRouter, RoutedPointer } from '../../input/pointer-router';
import {
  createHit,
  createRay,
  type Hit,
  type HitTester,
  type Ray,
  rayAt,
  transformRayInto,
  type Vec3,
} from '../../input/rays';
import { blendState } from '../../render/blend';
import type { Camera } from '../../render/camera';
import type { Drawable, Frame } from '../../render/frame';
import type { Renderer } from '../../render/renderer';
import type { Texture } from '../../render/texture';
import { Transform } from '../../render/transform';
import { createShaderModule } from '../../render/wgsl';
import type { ThemeTokens } from '../theme';
import { flowLayout, type PanelRect, rectClampSnap, rectContains, rectUnion } from './layout';
import {
  makePanelCanvas,
  Painter,
  type PanelCanvas,
  type PanelTheme,
  resolvePanelTheme,
} from './paint';
import { WORLD_PANEL_UNIFORM_BYTES, WORLD_PANEL_UNIFORM_FLOATS, WORLD_PANEL_WGSL } from './wgsl';
import type { PanelKeyEvent, WorldWidget, WorldWidgetHost } from './widgets';

/** What `attach` needs from the input (`Input` from `@thunderclap/engine/input` fits). */
export interface WorldPanelInput {
  /** The input's pointer router, or null when it has none. */
  getPointers(): PointerRouter<unknown> | null;
  /** Called after every `update()`; returns the remover. */
  onUpdated(fn: () => void): () => void;
}

export interface WorldPanelOptions {
  /** Panel size in world units. */
  width: number;
  height: number;
  /** Canvas px per world unit. Default 256. */
  resolution?: number;
  /** Theme tokens over the CSS-px theme (`cssPxTheme`): colours, fonts, spacing. */
  theme?: Partial<ThemeTokens>;
  /** `panel` (default): the surface colour with a border. `transparent`: widgets only. */
  background?: 'panel' | 'transparent';
  /** Turn to face the camera every `update(camera)`, keeping the position. */
  billboard?: boolean;
  /** Follow the camera: `distance` ahead of the eye, `offset` in view units (x right, y up). */
  headLocked?: { distance: number; offset?: [number, number] };
  /** Depth test against the scene. Default `true`; `false` for a head-locked panel. */
  depthTest?: boolean;
  /** The canvas to paint into (tests); default an `OffscreenCanvas` or a `<canvas>`. */
  canvas?: PanelCanvas;
  label?: string;
}

/** `hitTest`'s result: panel px from the top-left, the widget there (or `null`), the ray's distance. */
export interface WorldPanelHit {
  x: number;
  y: number;
  widget: WorldWidget | null;
  /** World units along the ray. */
  distance: number;
}

export interface WorldPanelStats {
  /** Paints of a dirty rect. */
  repaints: number;
  /** Texture uploads (at most one per `prepare`). */
  uploads: number;
  /** Bytes uploaded in all (dirty rect × 4). */
  bytes: number;
}

const NO_OFFSET: readonly [number, number] = [0, 0];

/** One pointer the panel is tracking from `poll`. */
interface TrackedPointer {
  /** The pointer id handed to `pointerDown/Move/Up` (stable while tracked). */
  id: number;
  key: number;
  source: unknown;
  select: boolean;
  seen: boolean;
  /** The last panel px the pointer was fed (where a pointer that vanishes mid-press releases). */
  x: number;
  y: number;
}

export class WorldPanel implements Drawable, WorldWidgetHost {
  readonly transform = new Transform();
  /** Panel size in world units. */
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  /** Canvas size in px. */
  readonly pxWidth: number;
  readonly pxHeight: number;
  readonly texture: Texture;
  readonly canvas: PanelCanvas;
  readonly painter: Painter;
  readonly theme: PanelTheme;
  readonly stats: WorldPanelStats = { repaints: 0, uploads: 0, bytes: 0 };
  /** Resolves when `document.fonts` is ready (at once without it); the panel repaints then. */
  readonly fontLoaded: Promise<void>;
  /** Draw this in the scene: `frame.drawable(panel.drawable)` (it is the panel itself). */
  readonly drawable: Drawable = this;
  readonly label: string;
  depthTest: boolean;
  /** Widgets in flow order. */
  readonly widgets: WorldWidget[] = [];
  /** The focused widget, or `null`. */
  focused: WorldWidget | null = null;
  /** The widget under the last moved pointer, or `null`. */
  hovered: WorldWidget | null = null;
  /** Draws issued by the last `draw` (0 or 1). */
  draws = 0;

  private readonly device: GPUDevice;
  private readonly background: 'panel' | 'transparent';
  private readonly billboard: boolean;
  private readonly headLocked: { distance: number; offset: readonly [number, number] } | null;
  private readonly dirtyRect: PanelRect = { x: 0, y: 0, w: 0, h: 0 };
  private layoutDirty = true;
  private needsUpload = false;
  private disposed = false;
  /** The press: which widget holds it, by pointer id. */
  private readonly presses = new Map<number, WorldWidget>();
  private pressCount = 0;
  private readonly tracked: TrackedPointer[] = [];
  private nextTrackedId = 1;
  private readonly uniform: GPUBuffer;
  private readonly uniformData = new Float32Array(WORLD_PANEL_UNIFORM_FLOATS);
  private readonly uniformSent = new Float32Array(WORLD_PANEL_UNIFORM_FLOATS);
  private uniformDirty = true;
  private readonly group: GPUBindGroup;
  private readonly pipelineDesc: GPURenderPipelineDescriptor;
  private flatPipeline: GPURenderPipeline | null = null;
  private readonly depthPipelines = new Map<string, GPURenderPipeline>();
  private readonly localRay = createRay();
  private readonly hit: WorldPanelHit = { x: 0, y: 0, widget: null, distance: 0 };
  private readonly routerHit: Hit<WorldPanel>;
  private readonly routerNormal: Vec3 = [0, 0, 0];
  private readonly basis = new Float32Array(12);
  private detachFn: (() => void) | null = null;

  constructor(renderer: Renderer, opts: WorldPanelOptions) {
    this.device = renderer.device;
    this.label = opts.label ?? 'world-panel';
    this.width = opts.width;
    this.height = opts.height;
    this.resolution = opts.resolution ?? 256;
    this.pxWidth = Math.max(1, Math.round(this.width * this.resolution));
    this.pxHeight = Math.max(1, Math.round(this.height * this.resolution));
    this.background = opts.background ?? 'panel';
    this.billboard = opts.billboard === true;
    this.headLocked = opts.headLocked
      ? { distance: opts.headLocked.distance, offset: opts.headLocked.offset ?? NO_OFFSET }
      : null;
    this.depthTest = opts.depthTest ?? this.headLocked === null;
    this.theme = resolvePanelTheme(opts.theme);
    this.canvas = opts.canvas ?? makePanelCanvas(this.pxWidth, this.pxHeight);
    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('world panel: no 2D context');
    this.painter = new Painter(ctx, this.theme);
    this.routerHit = createHit<WorldPanel>(this);

    this.texture = renderer.createTexture({
      width: this.pxWidth,
      height: this.pxHeight,
      format: 'rgba8unorm-srgb',
      label: `${this.label}-texture`,
    });
    const device = this.device;
    this.uniform = device.createBuffer({
      label: `${this.label}-uniform`,
      size: WORLD_PANEL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const groupLayout = device.createBindGroupLayout({
      label: `${this.label}-layout`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.group = device.createBindGroup({
      label: this.label,
      layout: groupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: renderer.samplers['linear-clamp'] },
        { binding: 2, resource: this.texture.view },
      ],
    });
    const mod = createShaderModule(device, WORLD_PANEL_WGSL, this.label);
    this.pipelineDesc = {
      label: this.label,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [renderer.globalsLayout, groupLayout],
      }),
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: {
        module: mod,
        entryPoint: 'fs',
        targets: renderer.sceneFormats.map((format) => ({
          format,
          blend: blendState('premultiplied'),
        })),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    };
    this.uniformData[12] = this.width;
    this.uniformData[13] = this.height;
    this.uniformSent.fill(Number.NaN);
    this.markAllDirty();

    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    this.fontLoaded = fonts
      ? fonts.ready.then(() => {
          if (this.disposed) return;
          this.painter.clearMeasures();
          this.relayout();
        })
      : Promise.resolve();
  }

  /** Whether a repaint or an upload is pending. */
  get dirty(): boolean {
    return this.layoutDirty || this.dirtyRect.w > 0 || this.needsUpload;
  }

  // ------------------------------------------------------------------------------------------
  // Widgets

  /** Append a widget to the flow (or place it at its `rect`). */
  add<W extends WorldWidget>(widget: W): W {
    if (widget.host === this) return widget;
    if (widget.host) throw new Error('world panel: widget already on a panel');
    widget.attach(this);
    this.widgets.push(widget);
    this.relayout();
    return widget;
  }

  remove(widget: WorldWidget): void {
    const i = this.widgets.indexOf(widget);
    if (i < 0) return;
    this.widgets.splice(i, 1);
    if (this.focused === widget) this.focused = null;
    if (this.hovered === widget) this.hovered = null;
    for (const [id, w] of this.presses) if (w === widget) this.presses.delete(id);
    this.pressCount = this.presses.size;
    widget.detach();
    this.relayout();
  }

  /** @internal `WorldWidgetHost` */
  invalidate(widget: WorldWidget): void {
    if (this.layoutDirty) return;
    rectUnion(this.dirtyRect, this.ringRect(widget.layoutRect));
  }

  /** @internal `WorldWidgetHost`: re-run the flow and repaint everything next frame. */
  relayout(): void {
    this.layoutDirty = true;
    this.markAllDirty();
  }

  private markAllDirty(): void {
    const d = this.dirtyRect;
    d.x = 0;
    d.y = 0;
    d.w = this.pxWidth;
    d.h = this.pxHeight;
  }

  private readonly ring: PanelRect = { x: 0, y: 0, w: 0, h: 0 };

  /** `r` grown by the focus ring, so a focus change repaints the ring too. */
  private ringRect(r: PanelRect): PanelRect {
    const g = this.theme.focusRing + 1;
    const o = this.ring;
    o.x = r.x - g;
    o.y = r.y - g;
    o.w = r.w + g * 2;
    o.h = r.h + g * 2;
    return o;
  }

  private layout(): void {
    this.layoutDirty = false;
    flowLayout(this.widgets, {
      width: this.pxWidth,
      padding: this.theme.space3,
      gap: this.theme.space2,
    });
  }

  /** The widget at panel px, or `null`. Explicit-rect widgets later in the list win. */
  widgetAt(x: number, y: number): WorldWidget | null {
    if (this.layoutDirty) this.layout();
    const ws = this.widgets;
    for (let i = ws.length - 1; i >= 0; i--) {
      const w = ws[i]!;
      if (rectContains(w.layoutRect, x, y)) return w;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------
  // Painting

  /**
   * Paint what is dirty now (the layout if it changed, then the dirty rect) and queue the upload.
   * `prepare` calls this; call it yourself to paint ahead of the frame.
   */
  repaint(): void {
    if (this.layoutDirty) this.layout();
    const d = this.dirtyRect;
    if (d.w <= 0 || d.h <= 0) return;
    rectClampSnap(d, this.pxWidth, this.pxHeight);
    if (d.w <= 0 || d.h <= 0) {
      d.w = 0;
      d.h = 0;
      return;
    }
    const p = this.painter;
    const ctx = p.ctx;
    const t = this.theme;
    ctx.save();
    ctx.beginPath();
    ctx.rect(d.x, d.y, d.w, d.h);
    ctx.clip();
    ctx.clearRect(d.x, d.y, d.w, d.h);
    if (this.background === 'panel') {
      const all: PanelRect = { x: 0, y: 0, w: this.pxWidth, h: this.pxHeight };
      p.fillRoundRect(all, t.radiusM, t.tokens.colorSurface);
      p.strokeRoundRect(all, t.radiusM, t.tokens.colorBorder, t.borderWidth);
    }
    for (const w of this.widgets) {
      const r = w.layoutRect;
      if (r.w <= 0 || r.h <= 0) continue;
      const g = t.focusRing + 1;
      if (
        r.x - g >= d.x + d.w ||
        r.x + r.w + g <= d.x ||
        r.y - g >= d.y + d.h ||
        r.y + r.h + g <= d.y
      )
        continue;
      ctx.save();
      w.paint(p, r);
      ctx.restore();
    }
    ctx.restore();
    this.stats.repaints++;
    rectUnion(this.uploadRect, d);
    this.needsUpload = true;
    d.w = 0;
    d.h = 0;
  }

  private readonly uploadRect: PanelRect = { x: 0, y: 0, w: 0, h: 0 };

  // ------------------------------------------------------------------------------------------
  // Transform helpers

  /**
   * Per frame, before drawing: a head-locked panel moves in front of `camera`, a billboard turns
   * to face it. A plain panel ignores it.
   */
  update(camera: Camera): void {
    const hl = this.headLocked;
    if (!hl && !this.billboard) return;
    const v = camera.view;
    const b = this.basis;
    // The view's rows are the camera's right, up and back axes in world space.
    const rx = v[0]!;
    const ry = v[4]!;
    const rz = v[8]!;
    const ux = v[1]!;
    const uy = v[5]!;
    const uz = v[9]!;
    const bx = v[2]!;
    const by = v[6]!;
    const bz = v[10]!;
    let px: number;
    let py: number;
    let pz: number;
    if (hl) {
      const eye = camera.position;
      const d = hl.distance;
      const ox = hl.offset[0];
      const oy = hl.offset[1];
      px = eye[0]! - bx * d + rx * ox + ux * oy;
      py = eye[1]! - by * d + ry * ox + uy * oy;
      pz = eye[2]! - bz * d + rz * ox + uz * oy;
    } else {
      const p = this.transform.position;
      px = p.x;
      py = p.y;
      pz = p.z;
    }
    const s = this.transform.scale;
    b[0] = rx * s.x;
    b[1] = ux * s.y;
    b[2] = bx * s.z;
    b[3] = px;
    b[4] = ry * s.x;
    b[5] = uy * s.y;
    b[6] = by * s.z;
    b[7] = py;
    b[8] = rz * s.x;
    b[9] = uz * s.y;
    b[10] = bz * s.z;
    b[11] = pz;
    this.transform.setMatrix(b, 0);
  }

  // ------------------------------------------------------------------------------------------
  // Hit testing and pointers

  /**
   * Where `ray` (world space) meets the panel's plane: px from the top-left (outside the quad
   * allowed) and the distance along the ray, written to `this.hit`. False when the ray is
   * parallel to the plane, points away from it, or the transform is singular.
   */
  private project(ray: Ray): boolean {
    const local = this.localRay;
    const scale = transformRayInto(ray, this.transform.world, local);
    if (scale === 0) return false;
    const dz = local.dir[2];
    if (Math.abs(dz) < 1e-9) return false;
    const t = -local.origin[2] / dz;
    if (t < 0) return false;
    const lx = local.origin[0] + local.dir[0] * t;
    const ly = local.origin[1] + local.dir[1] * t;
    const h = this.hit;
    h.x = (lx + this.width / 2) * this.resolution;
    h.y = (this.height / 2 - ly) * this.resolution;
    h.distance = t * scale;
    return true;
  }

  /**
   * Where `ray` (world space) meets the panel: px from the top-left, the widget there and the
   * distance along the ray; `null` when it misses. The result object is reused.
   */
  hitTest(ray: Ray): WorldPanelHit | null {
    if (!this.project(ray)) return null;
    const h = this.hit;
    if (h.x < 0 || h.x > this.pxWidth || h.y < 0 || h.y > this.pxHeight) return null;
    h.widget = this.widgetAt(h.x, h.y);
    return h;
  }

  /** A `HitTester` for the pointer router whose hit's `target` is this panel. */
  tester(): HitTester<WorldPanel> {
    return (ray) => {
      const h = this.hitTest(ray);
      if (!h) return null;
      const out = this.routerHit;
      rayAt(ray, h.distance, out.point);
      const m = this.transform.world;
      // The panel's +z in world space, turned to face the ray.
      let nx = m[2]!;
      let ny = m[6]!;
      let nz = m[10]!;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const d = ray.dir;
      if (nx * d[0] + ny * d[1] + nz * d[2] > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const n = out.normal ?? this.routerNormal;
      out.normal = n;
      n[0] = nx;
      n[1] = ny;
      n[2] = nz;
      out.distance = h.distance;
      return out;
    };
  }

  private setHover(widget: WorldWidget | null): void {
    const prev = this.hovered;
    if (prev === widget) return;
    if (prev) {
      prev.hover = false;
      this.invalidate(prev);
    }
    this.hovered = widget;
    if (widget) {
      widget.hover = true;
      this.invalidate(widget);
    }
  }

  /** A pointer is over panel px (`x`, `y`); `id` tells pointers apart (default 0). */
  pointerMove(x: number, y: number, id = 0): void {
    const held = this.presses.get(id);
    if (held) {
      held.pointerMove(x, y, true);
      return;
    }
    const w = this.widgetAt(x, y);
    this.setHover(w && !w.disabled ? w : null);
    w?.pointerMove(x, y, false);
  }

  /** The pointer left the panel (no widget is hovered; a held press stays until `pointerUp`). */
  pointerLeave(id = 0): void {
    if (this.presses.has(id)) return;
    this.setHover(null);
  }

  /** A press at panel px: the widget there takes it (and focus when focusable). */
  pointerDown(x: number, y: number, id = 0): void {
    const w = this.widgetAt(x, y);
    if (!w || w.disabled) return;
    if (w.focusable) this.focus(w);
    this.presses.set(id, w);
    this.pressCount = this.presses.size;
    if (!w.pressed) {
      w.pressed = true;
      this.invalidate(w);
    }
    w.pointerDown(x, y);
  }

  /**
   * The press `id` ends at panel px (outside the quad allowed); a release over the pressed widget
   * activates it. `NaN` coordinates cancel: the widget hears a release that is nowhere.
   */
  pointerUp(x: number, y: number, id = 0): void {
    const w = this.presses.get(id);
    if (!w) return;
    this.presses.delete(id);
    this.pressCount = this.presses.size;
    let stillHeld = false;
    for (const other of this.presses.values()) if (other === w) stillHeld = true;
    if (!stillHeld && w.pressed) {
      w.pressed = false;
      this.invalidate(w);
    }
    const inside = rectContains(w.layoutRect, x, y);
    w.pointerUp(x, y, inside);
    const under = this.widgetAt(x, y);
    this.setHover(under && !under.disabled ? under : null);
  }

  /** Wheel over panel px: the widget there scrolls. Returns whether something used it. */
  wheel(x: number, y: number, dy: number): boolean {
    const w = this.widgetAt(x, y);
    return w ? w.wheel(dy) : false;
  }

  /**
   * Drive the panel from the router's live pointers once per tick (after `input.update()`): a
   * pointer whose nearest hit is this panel hovers, its `select` edge presses and releases; one
   * that left releases outside. Pass `router.pointers` (or any array of `RoutedPointer`).
   */
  poll(pointers: readonly RoutedPointer[]): void {
    const tracked = this.tracked;
    for (const t of tracked) t.seen = false;
    for (const p of pointers) {
      const onPanel = p.hit !== null && p.hit.target === this;
      let t = this.trackedFor(p);
      if (!onPanel && !t) continue;
      if (!t) {
        t = {
          id: this.nextTrackedId++,
          key: p.key,
          source: p.source,
          select: false,
          seen: true,
          x: Number.NaN,
          y: Number.NaN,
        };
        tracked.push(t);
      }
      t.seen = true;
      const id = t.id;
      if (onPanel) {
        const h = this.hitTest(p.ray);
        if (!h) continue;
        t.x = h.x;
        t.y = h.y;
        if (p.select && !t.select) this.pointerDown(h.x, h.y, id);
        this.pointerMove(h.x, h.y, id);
        if (!p.select && t.select) this.pointerUp(h.x, h.y, id);
      } else if (t.select) {
        // Held, but the ray left the quad (or something nearer took the hit): the drag goes on
        // over the panel's plane, and the release lands where the ray meets it.
        const on = this.project(p.ray);
        const x = on ? this.hit.x : Number.NaN;
        const y = on ? this.hit.y : Number.NaN;
        t.x = x;
        t.y = y;
        if (p.select) this.pointerMove(x, y, id);
        else {
          this.pointerUp(x, y, id);
          this.pointerLeave(id);
        }
      } else {
        this.pointerLeave(id);
        t.seen = false;
      }
      t.select = p.select;
    }
    for (let i = tracked.length - 1; i >= 0; i--) {
      const t = tracked[i]!;
      if (t.seen) continue;
      const id = t.id;
      // A pointer that vanished while held (a touch down and up within one tick) releases where
      // it was last seen, so a quick tap still presses.
      if (t.select) this.pointerUp(t.x, t.y, id);
      this.pointerLeave(id);
      tracked.splice(i, 1);
    }
  }

  private trackedFor(p: RoutedPointer): TrackedPointer | null {
    for (const t of this.tracked) if (t.key === p.key && t.source === p.source) return t;
    return null;
  }

  /** `router.addTester(panel.tester())`; returns the remover. */
  attachTo(router: PointerRouter<unknown>): () => void {
    return router.addTester(this.tester() as HitTester<unknown>);
  }

  /**
   * Drive the panel on the input tick (ws/ui-4): registers the panel's tester with the input's
   * pointer router and, through `input.onUpdated`, calls `poll(router.pointers)` after every
   * `input.update()` and `update(camera)` with the router's camera (the one the rays go through,
   * `renderer.camera` in a game). Call once; `detach()` (and `dispose()`) undoes it. Manual
   * `poll`/`update` still work for an input without a router.
   */
  attach(input: WorldPanelInput): void {
    this.detach();
    const router = input.getPointers();
    if (!router) throw new Error('WorldPanel.attach: the input has no pointer router');
    const offTester = this.attachTo(router);
    const offTick = input.onUpdated(() => {
      if (this.disposed) return;
      this.poll(router.pointers);
      // The router sees a `RayCamera`; a full `Camera` (a game's `renderer.camera`) has `view`.
      const cam = router.camera;
      if (cam && 'view' in cam) this.update(cam as Camera);
    });
    this.detachFn = () => {
      offTick();
      offTester();
    };
  }

  /** Stop following the input `attach` hooked; nothing without one. */
  detach(): void {
    const off = this.detachFn;
    this.detachFn = null;
    off?.();
  }

  // ------------------------------------------------------------------------------------------
  // Focus and keys

  /** Focus `widget` (`null` clears); a widget that is not focusable is ignored. */
  focus(widget: WorldWidget | null): void {
    if (widget && (!widget.focusable || widget.host !== this)) return;
    const prev = this.focused;
    if (prev === widget) return;
    if (prev) {
      prev.focused = false;
      this.invalidate(prev);
    }
    this.focused = widget;
    if (widget) {
      widget.focused = true;
      this.invalidate(widget);
    }
  }

  private focusStep(dir: 1 | -1): WorldWidget | null {
    const ws = this.widgets;
    const n = ws.length;
    if (n === 0) return null;
    const start = this.focused ? ws.indexOf(this.focused) : -1;
    for (let k = 1; k <= n; k++) {
      const i = ((((start < 0 ? (dir > 0 ? -1 : 0) : start) + dir * k) % n) + n) % n;
      const w = ws[i]!;
      if (w.focusable) {
        this.focus(w);
        return w;
      }
    }
    return null;
  }

  /** Focus the next focusable widget (wrapping); the first when none is focused. */
  focusNext(): WorldWidget | null {
    return this.focusStep(1);
  }

  /** Focus the previous focusable widget (wrapping); the last when none is focused. */
  focusPrev(): WorldWidget | null {
    return this.focusStep(-1);
  }

  /** Activate the focused widget (a button presses, a toggle flips). */
  activate(): void {
    const w = this.focused;
    if (w && !w.disabled) w.activate();
  }

  /**
   * A keyboard event: Tab / Shift+Tab move focus, Enter and Space activate, arrows and the rest
   * go to the focused widget. Returns whether the key was consumed.
   */
  key(event: PanelKeyEvent): boolean {
    if (event.key === 'Tab') {
      if (event.shiftKey) this.focusPrev();
      else this.focusNext();
      return true;
    }
    const w = this.focused;
    if (!w) return false;
    if (event.key === 'Enter' || event.key === ' ') {
      this.activate();
      return true;
    }
    return w.key(event);
  }

  // ------------------------------------------------------------------------------------------
  // Drawable

  /** Repaint what is dirty and upload it (once) before the pass. */
  prepare(_encoder: GPUCommandEncoder, _frame?: Frame): void {
    if (this.disposed) return;
    this.repaint();
    if (this.needsUpload) {
      this.needsUpload = false;
      const u = this.uploadRect;
      this.device.queue.copyExternalImageToTexture(
        { source: this.canvas as unknown as OffscreenCanvas, origin: { x: u.x, y: u.y } },
        { texture: this.texture.texture, origin: { x: u.x, y: u.y }, premultipliedAlpha: true },
        [u.w, u.h],
      );
      this.stats.uploads++;
      this.stats.bytes += u.w * u.h * 4;
      u.w = 0;
      u.h = 0;
    }
    const m = this.transform.world;
    const d = this.uniformData;
    for (let i = 0; i < 12; i++) d[i] = m[i]!;
    const sent = this.uniformSent;
    let same = true;
    for (let i = 0; i < WORLD_PANEL_UNIFORM_FLOATS; i++) {
      if (sent[i] !== d[i]) {
        same = false;
        break;
      }
    }
    if (!same || this.uniformDirty) {
      this.uniformDirty = false;
      sent.set(d);
      this.device.queue.writeBuffer(this.uniform, 0, d.buffer, d.byteOffset, d.byteLength);
    }
  }

  /** Draw the quad inside the scene pass. */
  draw(pass: GPURenderPassEncoder, frame?: Frame): void {
    this.draws = 0;
    if (this.disposed) return;
    const fmt = frame?.depthFormat ?? null;
    pass.setBindGroup(1, this.group);
    pass.setPipeline(this.pipelineFor(fmt));
    pass.draw(6, 1);
    this.draws = 1;
  }

  private pipelineFor(format: GPUTextureFormat | null): GPURenderPipeline {
    if (!format) {
      this.flatPipeline ??= this.device.createRenderPipeline(this.pipelineDesc);
      return this.flatPipeline;
    }
    const key = `${format}:${this.depthTest ? 'test' : 'always'}`;
    let p = this.depthPipelines.get(key);
    if (!p) {
      p = this.device.createRenderPipeline({
        ...this.pipelineDesc,
        label: `${this.label}:${key}`,
        depthStencil: {
          format,
          depthWriteEnabled: false,
          depthCompare: this.depthTest ? 'less-equal' : 'always',
        },
      });
      this.depthPipelines.set(key, p);
    }
    return p;
  }

  /** Release the texture and buffers; the panel draws nothing after. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    for (const w of this.widgets) w.detach();
    this.widgets.length = 0;
    this.focused = null;
    this.hovered = null;
    this.presses.clear();
    this.pressCount = 0;
    this.texture.destroy();
    this.uniform.destroy();
  }

  /** Whether a press is held on some widget. */
  get pressing(): boolean {
    return this.pressCount > 0;
  }
}

/** `new WorldPanel(renderer, opts)`. */
export function createWorldPanel(renderer: Renderer, opts: WorldPanelOptions): WorldPanel {
  return new WorldPanel(renderer, opts);
}

/** The pointer router's `HitTester` for `panel`: `router.addTester(worldPanelTarget(panel))`. */
export function worldPanelTarget(panel: WorldPanel): HitTester<WorldPanel> {
  return panel.tester();
}
