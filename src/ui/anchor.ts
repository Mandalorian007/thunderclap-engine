import { logicalToClient, type Vec2 } from '../platform/letterbox';

/** A rectangle: origin top-left, y down (the shape of `Camera.screen` and `Surface.rect`). */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What anchors read from a camera: `Camera` from `@thunderclap/engine/render` fits. `screen` is
 * in logical px, or a fraction of the canvas when it lies inside the unit square (the renderer's
 * viewport rule).
 */
export interface AnchorCamera {
  readonly viewProjection: ArrayLike<number>;
  readonly screen: Readonly<AnchorRect>;
}

/**
 * Where the canvas is: `rect` in CSS px relative to the overlay's parent and the logical (design)
 * size it shows. `Surface` fits; `overlay.anchors` passes its own frame and design size.
 */
export interface AnchorSurface {
  readonly rect: Readonly<AnchorRect>;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
}

export interface AnchorOptions {
  /** CSS px added to the projected point. Default `[0, 0]`. */
  offset?: readonly [number, number];
  /**
   * The point of the element's box placed on the anchor, as fractions of its size. Default
   * `[0.5, 0.5]` (centred); `[0.5, 1]` sits the element on top of the point.
   */
  align?: readonly [number, number];
  /**
   * Keep the element inside the camera's viewport, `margin` CSS px from its edges, when the point
   * leaves it or goes behind the camera (an off-screen marker). A clamped anchor is never hidden;
   * while pinned to an edge it carries `data-anchor-clamped`. Default false.
   */
  clamp?: boolean;
  /** Edge margin for `clamp`, CSS px. Default 16. */
  margin?: number;
  /**
   * `'distance'` scales the element by `distance / w` (w is the clip w: the view depth under a
   * perspective camera, 1 under an orthographic one), kept within `min`..`max`. Default `'none'`.
   */
  scale?: 'none' | 'distance';
  /** The depth at which `scale: 'distance'` draws at 1. Default 10. */
  distance?: number;
  /** Scale bounds for `scale: 'distance'`. Default 0.25 and 2. */
  min?: number;
  max?: number;
  /**
   * Hide the element (`hidden` attribute) when the point is behind the camera or outside clip
   * space. Default true; ignored when `clamp` is on.
   */
  hideBehind?: boolean;
  /** The layer to place the element in (a key of `AnchorsOptions.layers`). Default: `root`. */
  layer?: string;
}

/** One anchored element. */
export interface AnchorHandle {
  readonly el: HTMLElement;
  /** False while hidden by `hideBehind`, as of the last `update()`. */
  readonly visible: boolean;
  /** True while `clamp` holds the element at the viewport's edge. */
  readonly clamped: boolean;
  /** The anchor point in the layer, CSS px, as of the last `update()` (offset included). */
  readonly x: number;
  readonly y: number;
  /** The scale applied, as of the last `update()` (1 unless `scale: 'distance'`). */
  readonly scale: number;
  /** Move the anchor to a world point (copied). */
  set(world: ArrayLike<number>): void;
  /** Stop placing the element and take it out of the layer. */
  remove(): void;
}

export interface AnchorsOptions {
  /** The default layer. It should be laid over the frame (the canvas rect), like `ui.layers.hud`. */
  root: HTMLElement;
  surface: AnchorSurface;
  /** The camera to project through, read on every `update()`. */
  camera: () => AnchorCamera;
  /** Other layers by name, for `AnchorOptions.layer`. */
  layers?: Readonly<Record<string, HTMLElement>>;
  /**
   * Is the named layer laid over the frame (true) or over the frame's parent (false, so the
   * frame's offset is added)? Default: every layer is on the frame.
   */
  onFrame?: (layer: string) => boolean;
}

const BEHIND = 1e-6;
/** How far past the viewport an off-screen point is pushed before clamping (clip units). */
const FAR = 1e6;

/** Typed OM parts reused for one element, so a move allocates nothing where the API exists. */
interface TypedTransform {
  x: CSSUnitValue;
  y: CSSUnitValue;
  s: CSSUnitValue;
  value: CSSTransformValue;
}

class Anchor implements AnchorHandle {
  readonly world = new Float32Array(3);
  visible = true;
  clamped = false;
  x = Number.NaN;
  y = Number.NaN;
  scale = 1;
  removed = false;
  readonly ax: number;
  readonly ay: number;
  readonly ox: number;
  readonly oy: number;
  readonly clamp: boolean;
  readonly margin: number;
  readonly byDistance: boolean;
  readonly distance: number;
  readonly min: number;
  readonly max: number;
  readonly hideBehind: boolean;
  readonly layer: string | null;
  readonly typed: TypedTransform | null;
  /** The string fallback's tail: `scale(…)` is written in front of it. */
  readonly alignCss: string;

  constructor(
    readonly el: HTMLElement,
    world: ArrayLike<number>,
    opts: AnchorOptions,
    private readonly owner: Anchors,
  ) {
    this.set(world);
    [this.ax, this.ay] = opts.align ?? [0.5, 0.5];
    [this.ox, this.oy] = opts.offset ?? [0, 0];
    this.clamp = opts.clamp ?? false;
    this.margin = opts.margin ?? 16;
    this.byDistance = opts.scale === 'distance';
    this.distance = opts.distance ?? 10;
    this.min = opts.min ?? 0.25;
    this.max = opts.max ?? 2;
    this.hideBehind = opts.hideBehind ?? true;
    this.layer = opts.layer ?? null;
    this.alignCss = `translate(${-this.ax * 100}%, ${-this.ay * 100}%)`;
    this.typed = typedTransform(el, this.ax, this.ay);
  }

  set(world: ArrayLike<number>): void {
    this.world[0] = world[0] ?? 0;
    this.world[1] = world[1] ?? 0;
    this.world[2] = world[2] ?? 0;
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.owner.drop(this);
    this.el.remove();
  }

  /** Write the element's place; only what changed touches the DOM. */
  place(x: number, y: number, s: number, visible: boolean, clamped: boolean): void {
    const el = this.el;
    if (visible !== this.visible) {
      this.visible = visible;
      el.hidden = !visible;
    }
    if (clamped !== this.clamped) {
      this.clamped = clamped;
      el.toggleAttribute('data-anchor-clamped', clamped);
    }
    if (!visible || (x === this.x && y === this.y && s === this.scale)) return;
    this.x = x;
    this.y = y;
    this.scale = s;
    const t = this.typed;
    if (t) {
      t.x.value = x;
      t.y.value = y;
      t.s.value = s;
      el.attributeStyleMap.set('transform', t.value);
    } else {
      el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s}) ${this.alignCss}`;
    }
  }
}

/** CSS Typed OM where the browser has it (Chromium, WebKit); null elsewhere (string fallback). */
function typedTransform(el: HTMLElement, ax: number, ay: number): TypedTransform | null {
  if (
    typeof CSSUnitValue === 'undefined' ||
    typeof CSSTransformValue === 'undefined' ||
    !('attributeStyleMap' in el)
  ) {
    return null;
  }
  try {
    const x = new CSSUnitValue(0, 'px');
    const y = new CSSUnitValue(0, 'px');
    const s = new CSSUnitValue(1, 'number');
    const value = new CSSTransformValue([
      new CSSTranslate(x, y, new CSSUnitValue(0, 'px')),
      new CSSScale(s, s),
      new CSSTranslate(
        new CSSUnitValue(-ax * 100, 'percent'),
        new CSSUnitValue(-ay * 100, 'percent'),
      ),
    ]);
    return { x, y, s, value };
  } catch {
    return null;
  }
}

/**
 * DOM elements that follow world points: a name over a character, a damage number, a hint on a
 * tile, a marker that stays on screen for something off it. Each `update()` projects every point
 * through the camera (`viewProjection`), maps clip space onto the camera's `screen` and that onto
 * the canvas rect in CSS px, and writes `transform` on the element (layout never reflows). A
 * point behind the camera or outside clip space hides its element (`hidden`) unless it is
 * clamped. `update()` allocates nothing in steady state where CSS Typed OM exists; elsewhere a
 * moved element gets one transform string.
 *
 * In a game, `ctx.ui.anchors(camera)` builds the overlay's one `Anchors` on `ui.layers.hud`, and
 * `createGame` updates it after every frame.
 */
export class Anchors {
  private readonly list: Anchor[] = [];
  private readonly clip = new Float32Array(4);
  private readonly pt: Vec2 = { x: 0, y: 0 };
  private cam: () => AnchorCamera;

  constructor(private readonly opts: AnchorsOptions) {
    this.cam = opts.camera;
  }

  /** Anchored elements. */
  get size(): number {
    return this.list.length;
  }

  /** Project through another camera from the next `update()` on. */
  setCamera(camera: () => AnchorCamera): void {
    this.cam = camera;
  }

  /**
   * Place `el` at the world point `world` (copied) from the next `update()` on. The element is
   * appended to its layer (`opts.layer`, else `root`) and positioned absolutely at the layer's
   * top-left, moved by `transform` only.
   */
  add(el: HTMLElement, world: ArrayLike<number>, opts: AnchorOptions = {}): AnchorHandle {
    const a = new Anchor(el, world, opts, this);
    const layer = (a.layer !== null && this.opts.layers?.[a.layer]) || this.opts.root;
    const s = el.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.transformOrigin = '0 0';
    s.willChange = 'transform';
    el.classList.add('tc-anchor');
    layer.append(el);
    this.list.push(a);
    return a;
  }

  /** Remove every anchored element. */
  clear(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.list[i]!.remove();
  }

  /** @internal */
  drop(a: Anchor): void {
    const i = this.list.indexOf(a);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Place every element for the camera as it is now. Call once a frame, after the camera moved. */
  update(): void {
    const cam = this.cam();
    const m = cam.viewProjection;
    const sc = cam.screen;
    const surf = this.opts.surface;
    const lw = surf.logicalWidth;
    const lh = surf.logicalHeight;
    const rect = surf.rect;
    // camera.screen → logical px: a rect inside the unit square is a fraction of the canvas.
    const frac = sc.x >= 0 && sc.y >= 0 && sc.x + sc.width <= 1 && sc.y + sc.height <= 1;
    const kx = frac ? lw : 1;
    const ky = frac ? lh : 1;
    const pt = this.pt;
    // The viewport (camera.screen) in frame CSS px.
    logicalToClient(rect, lw, lh, sc.x * kx, sc.y * ky, pt);
    const vx0 = pt.x - rect.x;
    const vy0 = pt.y - rect.y;
    logicalToClient(rect, lw, lh, (sc.x + sc.width) * kx, (sc.y + sc.height) * ky, pt);
    const vx1 = pt.x - rect.x;
    const vy1 = pt.y - rect.y;
    const c = this.clip;
    const onFrame = this.opts.onFrame;

    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i]!;
      const wx = a.world[0]!;
      const wy = a.world[1]!;
      const wz = a.world[2]!;
      for (let r = 0; r < 4; r++) {
        c[r] = m[r]! * wx + m[4 + r]! * wy + m[8 + r]! * wz + m[12 + r]!;
      }
      const w = c[3]!;
      const inside =
        w > BEHIND && Math.abs(c[0]!) <= w && Math.abs(c[1]!) <= w && c[2]! >= 0 && c[2]! <= w;
      if (!inside && !a.clamp && a.hideBehind) {
        a.place(a.x, a.y, a.scale, false, false);
        continue;
      }
      let nx: number;
      let ny: number;
      if (w > BEHIND) {
        nx = c[0]! / w;
        ny = c[1]! / w;
      } else {
        // Behind the eye the projection mirrors; the point's direction is x, y over |w|, and it
        // is off screen whatever its size, so push it far out before clamping.
        const d = Math.max(Math.abs(c[0]!), Math.abs(c[1]!)) || 1;
        nx = (c[0]! / d) * FAR;
        ny = (c[1]! / d) * FAR;
        if (nx === 0 && ny === 0) ny = -FAR;
      }
      // NDC → screen units → logical px → frame CSS px.
      const sx = (sc.x + ((nx + 1) / 2) * sc.width) * kx;
      const sy = (sc.y + ((1 - ny) / 2) * sc.height) * ky;
      logicalToClient(rect, lw, lh, sx, sy, pt);
      let x = pt.x - rect.x + a.ox;
      let y = pt.y - rect.y + a.oy;
      let clamped = false;
      if (a.clamp) {
        const mg = a.margin;
        const cx = Math.min(Math.max(x, vx0 + mg), vx1 - mg);
        const cy = Math.min(Math.max(y, vy0 + mg), vy1 - mg);
        clamped = !inside || cx !== x || cy !== y;
        x = cx;
        y = cy;
      }
      if (a.layer !== null && onFrame && !onFrame(a.layer)) {
        x += rect.x;
        y += rect.y;
      }
      let s = 1;
      if (a.byDistance) {
        s = w > BEHIND ? a.distance / w : a.max;
        s = Math.min(Math.max(s, a.min), a.max);
      }
      a.place(x, y, s, true, clamped);
    }
  }
}
