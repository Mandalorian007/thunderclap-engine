/**
 * Canvas minimap (ws/ui-5): a map of the ground plane (x, z) of a bounded world, drawn on its own
 * `<canvas>` in a layout region, round or square. The game paints its layout once into a canvas
 * or `ImageBitmap` covering the world rectangle (`setBackground`); the map draws that, the
 * markers (`setMarkers`, a shape per `kind`) and the player's arrow (`setPlayer`).
 *
 * - **Redrawn only on change.** Every setter compares with what it holds and, on a change,
 *   schedules one draw on the next animation frame; a still map never touches its canvas.
 *   `redraws` counts the draws, `flush()` draws a pending change now.
 * - **Mapping.** The view is centred on the player (or on the world's centre with `center:
 *   'world'`). At `zoom` 1 the world's longer side spans the map; `zoom` 2 shows half that.
 *   `rotate: 'north'` keeps north (−z) up; `'player'` turns the map so the player's heading
 *   points up. `toMap(x, z, out)` and `toWorld(u, v, out)` are the pair (map px from the
 *   top-left corner, in the map's `size` units), exact inverses. `worldRadius` instead of `zoom`
 *   puts the edge that many world units from the centre (a marker farther out is on the rim).
 * - **Pick.** With `onPick`, a click or a tap on the map gives `onPick(worldX, worldZ)` through
 *   `toWorld`: click-to-move from the map. Off a round map's disc it is ignored.
 * - Markers past the view's edge sit on the rim, dimmed; `markerAt(id)` says where one is drawn
 *   and whether it is on the rim, `rim` counts them. A marker may carry an `icon` (a glyph drawn
 *   on it). Colours may be CSS colours or `var(--tc-…)` theme tokens (resolved on each draw).
 * - A marker may carry a `heading` (radians, clockwise from north, as `setPlayer`'s yaw); a kind
 *   with `shape: 'arrow'` draws it as the player's arrow, turned to that heading on the map
 *   (less the player's yaw on a `rotate: 'player'` map). `markerAt(id).angle` is that turn.
 *
 * `ui.minimap(opts)` is this map on the overlay (ws/ui-6 retired ui-4's DOM minimap).
 */
import { h } from './dom';
import { themePx } from './hud';
import type { Layout, RegionName, WidgetHandle, WidgetOptions } from './layout';

/** What the canvas minimap needs from its overlay (`Overlay` fits). */
export interface CanvasMinimapHost {
  readonly layers: { readonly hud: HTMLElement };
  readonly layout: Layout;
}

/** The world's ground rectangle the background covers. */
export interface MinimapWorld {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export type MinimapRotate = 'north' | 'player';
export type MinimapShape = 'round' | 'square';
/** `arrow` is the player's arrow shape, turned to the marker's `heading` (ws/ui-7). */
export type MinimapMarkerShape = 'dot' | 'square' | 'diamond' | 'triangle' | 'ring' | 'arrow';

/** How a marker kind draws. */
export interface MinimapKindStyle {
  shape?: MinimapMarkerShape;
  /** CSS colour or `var(--tc-…)`. */
  color?: string;
  /** Diameter, map px (an arrow's length; the player's arrow is 16). Default 8. */
  size?: number;
}

/** One marker for `setMarkers`. */
export interface MinimapMarker {
  id: string;
  x: number;
  z: number;
  kind: string;
  /** Over the kind's colour. */
  color?: string;
  /** A short glyph drawn on the marker (one or two characters), in the theme text colour. */
  icon?: string;
  /**
   * Facing, radians clockwise from north (−z), the convention of `setPlayer`'s yaw (ws/ui-7).
   * An `arrow` kind points this way; other shapes do not turn. Default 0 (north).
   */
  heading?: number;
}

/** Where a marker is drawn, as of now (`markerAt`). */
export interface MinimapMarkerPlace {
  /** Map px from the top-left (`size` units), after the rim clamp. */
  x: number;
  y: number;
  /** True while held on the rim (past the view's edge). */
  outside: boolean;
  /**
   * The marker's heading as drawn on the map, radians clockwise from up: `heading` on a north-up
   * map, `heading − yaw` on a player-up one (`heading` defaults to 0, north). An `arrow` is turned
   * by this.
   * `markerAt` always writes it (optional so an `out` from before ws/ui-7 still type-checks).
   */
  angle?: number;
}

export type MinimapBackground = HTMLCanvasElement | ImageBitmap | HTMLImageElement;

export interface CanvasMinimapOptions {
  /** Width and height, design px. Default 200. */
  size?: number;
  world: MinimapWorld;
  /** Default `'north'`. */
  rotate?: MinimapRotate;
  /** Default `'round'`. */
  shape?: MinimapShape;
  /** Default `'player'`. */
  center?: 'player' | 'world';
  /** Default 1 (the world's longer side spans the map). */
  zoom?: number;
  /**
   * World units from the centre to the rim, over `zoom`: a marker farther than this from the
   * centre is held on the rim. Sets `zoom` to match.
   */
  worldRadius?: number;
  background?: MinimapBackground | null;
  /** Styles per marker kind, over the defaults (`self`, `ally`, `enemy`, `objective`, `info`). */
  kinds?: Readonly<Record<string, MinimapKindStyle>>;
  /** Click or tap on the map, in world units. */
  onPick?: (x: number, z: number) => void;
  /** Layout region. Default `right`. */
  region?: RegionName;
  /**
   * Placement per form factor, as `layout.add` takes it; overrides `region`. A phone's side rail
   * is 56 px, so a full-size map usually wants `{ default: 'right', 'phone-landscape': 'cardLane' }`.
   * The map shrinks (square) to fit a smaller fixed region; in a content bar or rail it holds
   * `size` and the track grows to it (ws/ui-11). `toMap`/picks stay in `size` units.
   */
  place?: WidgetOptions['place'];
  order?: number;
  /** Accessible name. Default `'Map'`. */
  label?: string;
}

export interface CanvasMinimap {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly size: number;
  /** Draws so far. */
  readonly redraws: number;
  /** Markers held. */
  readonly markers: number;
  /** Markers held on the rim (past the view's edge) as of the last draw. */
  readonly rim: number;
  /** View zoom; setting it redraws. */
  zoom: number;
  /** Replace the markers (copied; an unchanged list does not redraw). */
  setMarkers(list: readonly MinimapMarker[]): void;
  /** The player's place and heading (radians, clockwise from north, −z). */
  setPlayer(x: number, z: number, yaw: number): void;
  /** The game's painted layout over the world rectangle, or null for none. */
  setBackground(bg: MinimapBackground | null): void;
  /** World → map px (from the top-left, `size` units). Allocates nothing. */
  toMap(x: number, z: number, out: { x: number; y: number }): { x: number; y: number };
  /** Map px → world (`out.x`, `out.y` are world x and z). The inverse of `toMap`. */
  toWorld(u: number, v: number, out: { x: number; y: number }): { x: number; y: number };
  /**
   * Where the marker `id` is drawn now (map px from the top-left, rim-clamped) and whether it is
   * on the rim; null for an unknown id. Writes `out` when given (no allocation).
   */
  markerAt(id: string, out?: MinimapMarkerPlace): MinimapMarkerPlace | null;
  /** Draw a pending change now (normally on the next animation frame). */
  flush(): void;
  remove(): void;
}

const DEFAULT_KINDS: Readonly<Record<string, MinimapKindStyle>> = {
  self: { shape: 'dot', color: 'var(--tc-color-text)' },
  ally: { shape: 'dot', color: 'var(--tc-color-success)' },
  enemy: { shape: 'dot', color: 'var(--tc-color-danger)' },
  objective: { shape: 'diamond', color: 'var(--tc-color-accent)', size: 11 },
  info: { shape: 'square', color: 'var(--tc-color-info)' },
};
const FALLBACK: MinimapKindStyle = { shape: 'dot', color: 'var(--tc-color-info)' };
/** Map px between a rim-held marker's centre and the edge. */
const RIM_INSET = 5;

/** The map (see the module comment). */
export function createCanvasMinimap(
  host: CanvasMinimapHost,
  opts: CanvasMinimapOptions,
): CanvasMinimap {
  const doc = host.layers.hud.ownerDocument;
  const win = doc.defaultView;
  ensureCanvasMinimapStyles(doc);
  const size = Math.max(16, opts.size ?? 200);
  const half = size / 2;
  const world = { ...opts.world };
  const span = Math.max(1e-6, world.maxX - world.minX, world.maxZ - world.minZ);
  const turn = opts.rotate === 'player';
  const round = (opts.shape ?? 'round') === 'round';
  const followWorld = opts.center === 'world';
  const kinds: Record<string, MinimapKindStyle> = { ...DEFAULT_KINDS, ...opts.kinds };
  const onPick = opts.onPick;

  const canvas = h('canvas', { class: 'tc-cminimap-canvas', 'aria-hidden': 'true' });
  const el = h(
    'div',
    {
      class: onPick ? 'tc-cminimap tc-interactive' : 'tc-cminimap',
      role: 'img',
      'aria-label': opts.label ?? 'Map',
      dataset: { shape: round ? 'round' : 'square', rotate: turn ? 'player' : 'north' },
      style: { '--tc-cminimap-size': themePx(size) },
    },
    canvas,
  );

  const rimPx = half - RIM_INSET;
  let zoom = Math.max(
    1e-3,
    opts.worldRadius !== undefined
      ? (rimPx * span) / (size * Math.max(1e-6, opts.worldRadius))
      : (opts.zoom ?? 1),
  );
  let k = (size * zoom) / span;
  let px = (world.minX + world.maxX) / 2;
  let pz = (world.minZ + world.maxZ) / 2;
  let yaw = 0;
  let cos = 1;
  let sin = 0;
  let background: MinimapBackground | null = opts.background ?? null;
  // Markers, flattened and grown as needed (a steady list reuses them).
  const ids: string[] = [];
  const mx: number[] = [];
  const mz: number[] = [];
  const mkind: string[] = [];
  const mcolor: (string | undefined)[] = [];
  const micon: (string | undefined)[] = [];
  const mheading: (number | undefined)[] = [];
  let count = 0;
  let rim = 0;
  let redraws = 0;
  let dirty = false;
  let raf = 0;
  let removed = false;
  const tmp = { x: 0, y: 0 };

  const centre = () => {
    if (followWorld) {
      tmp.x = (world.minX + world.maxX) / 2;
      tmp.y = (world.minZ + world.maxZ) / 2;
    } else {
      tmp.x = px;
      tmp.y = pz;
    }
    return tmp;
  };
  /** The view's rotation: −yaw on a turning map. */
  const setTurn = () => {
    const a = turn ? yaw : 0;
    cos = Math.cos(a);
    sin = Math.sin(a);
  };

  const toMap = (x: number, z: number, out: { x: number; y: number }) => {
    const c = centre();
    const dx = x - c.x;
    const dz = z - c.y;
    // Rotate by −yaw (y down): the heading (sin yaw, −cos yaw) comes out as (0, −1), up.
    out.x = half + (dx * cos + dz * sin) * k;
    out.y = half + (-dx * sin + dz * cos) * k;
    return out;
  };
  const toWorld = (u: number, v: number, out: { x: number; y: number }) => {
    const du = (u - half) / k;
    const dv = (v - half) / k;
    const c = centre();
    const cx = c.x;
    const cz = c.y;
    out.x = cx + du * cos - dv * sin;
    out.y = cz + du * sin + dv * cos;
    return out;
  };

  /** Marker `i`'s heading on the map, radians clockwise from up. */
  const markerAngle = (i: number): number => {
    const hd = mheading[i] ?? 0;
    return turn ? hd - yaw : hd;
  };

  /** Marker `i` on the map, rim-clamped, into `tmp`; true when held on the rim. */
  const placeMarker = (i: number): boolean => {
    toMap(mx[i]!, mz[i]!, tmp);
    const x = tmp.x - half;
    const y = tmp.y - half;
    const d = round ? Math.hypot(x, y) : Math.max(Math.abs(x), Math.abs(y));
    if (d <= rimPx) return false;
    tmp.x = half + (x / d) * rimPx;
    tmp.y = half + (y / d) * rimPx;
    return true;
  };

  // ---- drawing
  const fonts = new Map<number, string>();
  const iconFont = (markerSize: number): string => {
    const px = Math.round(markerSize * 1.1);
    let f = fonts.get(px);
    if (f === undefined) {
      f = `700 ${px}px sans-serif`;
      fonts.set(px, f);
    }
    return f;
  };
  const tokens = new Map<string, string>();
  let computed: CSSStyleDeclaration | null = null;
  const resolve = (color: string): string => {
    const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
    if (!m) return color;
    let v = tokens.get(m[1]!);
    if (v === undefined) {
      computed ??= win?.getComputedStyle(el) ?? null;
      v = computed?.getPropertyValue(m[1]!).trim() || '#fff';
      tokens.set(m[1]!, v);
    }
    return v;
  };

  const marker = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    style: MinimapKindStyle,
    color: string,
    dim: boolean,
    angle: number,
  ) => {
    const r = (style.size ?? 8) / 2;
    ctx.globalAlpha = dim ? 0.55 : 1;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 1.5;
    if (style.shape === 'arrow') {
      arrow(ctx, x, y, r, angle);
      ctx.globalAlpha = 1;
      return;
    }
    ctx.beginPath();
    switch (style.shape ?? 'dot') {
      case 'square':
        ctx.rect(x - r, y - r, r * 2, r * 2);
        break;
      case 'diamond':
        ctx.moveTo(x, y - r * 1.2);
        ctx.lineTo(x + r * 1.2, y);
        ctx.lineTo(x, y + r * 1.2);
        ctx.lineTo(x - r * 1.2, y);
        ctx.closePath();
        break;
      case 'triangle':
        ctx.moveTo(x, y - r * 1.2);
        ctx.lineTo(x + r * 1.1, y + r * 0.9);
        ctx.lineTo(x - r * 1.1, y + r * 0.9);
        ctx.closePath();
        break;
      case 'ring':
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        return;
      default:
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  /** The arrow (half-length `r`; the player's is 8) at (x, y), turned by `angle`; fill and stroke as set. */
  const arrow = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, angle: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.75, r * 0.75);
    ctx.lineTo(0, r * 0.375);
    ctx.lineTo(-r * 0.75, r * 0.75);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  const draw = () => {
    dirty = false;
    redraws++;
    computed = null;
    tokens.clear();
    // Backing store: the canvas's CSS size × devicePixelRatio, else the design size.
    const rect = canvas.getBoundingClientRect?.();
    const dpr = win?.devicePixelRatio ?? 1;
    const bw = Math.max(1, Math.round((rect && rect.width > 0 ? rect.width : size) * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bw) canvas.height = bw;
    const ctx = canvas.getContext?.('2d') ?? null;
    if (!ctx) {
      let onRim = 0;
      for (let i = 0; i < count; i++) if (placeMarker(i)) onRim++;
      rim = onRim;
      return;
    }
    const s = bw / size;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bw);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.save();
    ctx.beginPath();
    if (round) ctx.arc(half, half, half, 0, Math.PI * 2);
    else ctx.rect(0, 0, size, size);
    ctx.clip();
    ctx.fillStyle = resolve('var(--tc-color-surface)');
    ctx.fillRect(0, 0, size, size);
    if (background) {
      // World → map as a canvas transform, then the picture over the world rectangle.
      const c = centre();
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(-(turn ? yaw : 0));
      ctx.scale(k, k);
      ctx.translate(-c.x, -c.y);
      ctx.drawImage(
        background,
        world.minX,
        world.minZ,
        world.maxX - world.minX,
        world.maxZ - world.minZ,
      );
      ctx.restore();
    }
    ctx.restore();
    // Markers, held on the rim past the edge.
    let onRim = 0;
    for (let i = 0; i < count; i++) {
      const dim = placeMarker(i);
      if (dim) onRim++;
      const style = kinds[mkind[i]!] ?? FALLBACK;
      const color = resolve(mcolor[i] ?? style.color ?? '#fff');
      marker(ctx, tmp.x, tmp.y, style, color, dim, markerAngle(i));
      const icon = micon[i];
      if (icon) {
        ctx.globalAlpha = dim ? 0.55 : 1;
        ctx.fillStyle = resolve('var(--tc-color-text)');
        ctx.font = iconFont(style.size ?? 8);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon, tmp.x, tmp.y);
        ctx.globalAlpha = 1;
      }
    }
    rim = onRim;
    // The player's arrow.
    toMap(px, pz, tmp);
    ctx.fillStyle = resolve('var(--tc-color-accent)');
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 1.5;
    arrow(ctx, tmp.x, tmp.y, 8, turn ? 0 : yaw);
  };

  const schedule = () => {
    if (removed) return;
    dirty = true;
    if (raf) return;
    const run = () => {
      raf = 0;
      if (dirty && !removed) draw();
    };
    if (win?.requestAnimationFrame) raf = win.requestAnimationFrame(run);
    else {
      raf = 1;
      queueMicrotask(run);
    }
  };

  // ---- pick
  const pickAt = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    const u = ((clientX - r.left) / r.width) * size;
    const v = ((clientY - r.top) / r.height) * size;
    if (round && Math.hypot(u - half, v - half) > half) return;
    toWorld(u, v, tmp);
    onPick?.(tmp.x, tmp.y);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    pickAt(e.clientX, e.clientY);
  };
  if (onPick) el.addEventListener('pointerdown', onDown);

  setTurn();
  const handle: WidgetHandle = host.layout.add(el, {
    place: opts.place ?? { default: opts.region ?? 'right' },
    order: opts.order,
  });
  schedule();

  return {
    el,
    canvas,
    size,
    get redraws() {
      return redraws;
    },
    get markers() {
      return count;
    },
    get rim() {
      return rim;
    },
    get zoom() {
      return zoom;
    },
    set zoom(z) {
      const next = Math.max(1e-3, z);
      if (next === zoom) return;
      zoom = next;
      k = (size * zoom) / span;
      schedule();
    },
    setMarkers(list) {
      let changed = list.length !== count;
      for (let i = 0; i < list.length; i++) {
        const m = list[i]!;
        if (
          !changed &&
          ids[i] === m.id &&
          mx[i] === m.x &&
          mz[i] === m.z &&
          mkind[i] === m.kind &&
          mcolor[i] === m.color &&
          micon[i] === m.icon &&
          mheading[i] === m.heading
        ) {
          continue;
        }
        changed = true;
        ids[i] = m.id;
        mx[i] = m.x;
        mz[i] = m.z;
        mkind[i] = m.kind;
        mcolor[i] = m.color;
        micon[i] = m.icon;
        mheading[i] = m.heading;
      }
      count = list.length;
      if (changed) schedule();
    },
    setPlayer(x, z, y) {
      if (x === px && z === pz && y === yaw) return;
      px = x;
      pz = z;
      yaw = y;
      setTurn();
      schedule();
    },
    setBackground(bg) {
      if (bg === background) return;
      background = bg;
      schedule();
    },
    toMap,
    toWorld,
    markerAt(id, out) {
      for (let i = 0; i < count; i++) {
        if (ids[i] !== id) continue;
        const outside = placeMarker(i);
        const o = out ?? { x: 0, y: 0, outside: false, angle: 0 };
        o.x = tmp.x;
        o.y = tmp.y;
        o.outside = outside;
        o.angle = markerAngle(i);
        return o;
      }
      return null;
    },
    flush() {
      if (dirty && !removed) draw();
    },
    remove() {
      removed = true;
      if (raf && win?.cancelAnimationFrame && raf !== 1) win.cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', onDown);
      handle.remove();
      el.remove();
    },
  };
}

/**
 * Stylesheet for the canvas minimap (theme tokens).
 */
export const CANVAS_MINIMAP_CSS = `
.tc-overlay .tc-cminimap { position: relative; width: var(--tc-cminimap-size); height: auto; aspect-ratio: 1;
  max-width: 100%; max-height: 100%; flex: none;
  box-sizing: border-box; border: var(--tc-border-width) solid var(--tc-color-border); box-shadow: var(--tc-shadow);
  border-radius: var(--tc-radius-m); overflow: hidden; background: var(--tc-color-surface); touch-action: none; }
.tc-overlay .tc-cminimap[data-shape="round"] { border-radius: 50%; }
.tc-overlay .tc-region[data-content] > .tc-cminimap { max-width: none; max-height: none; }
.tc-overlay .tc-cminimap-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
`;

const STYLE_ID = 'tc-ui-cminimap';

/** Add `CANVAS_MINIMAP_CSS` to `doc` once (the first map does it). */
export function ensureCanvasMinimapStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CANVAS_MINIMAP_CSS;
  doc.head.appendChild(style);
}
