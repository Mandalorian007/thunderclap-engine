/**
 * Magnify: loupe and snap for small touch targets (the `Gestures` `magnify` option).
 *
 * A finger covers about 44 CSS px. When a game's targets are smaller than that, a finger can't
 * see what it is aiming at or hit it reliably. With `magnify`, while one touch pointer is down
 * `Gestures` reports an `aim` each tick:
 *
 * - the aim point is the finger, raised by `lift` CSS px while the finger drags, so the thing
 *   being dragged and its target stay in sight above the fingertip;
 * - `snap` (the game's) turns the aim point into an accepted target, usually the nearest one
 *   within half a pitch (`snapToGrid`);
 * - while the target pitch is below `below` CSS px a round loupe beside the finger shows the
 *   area under the aim point, `zoom` times bigger, with the snapped target ringed.
 *
 * Mouse and pen never aim: they have a precise tip and hover. Everything here is noun-free.
 */

/** A target picked by `snap`: its centre and radius in game space. */
export interface MagnifyTarget {
  x: number;
  y: number;
  r: number;
  /** Anything the game attaches (the cell it snapped to). */
  data?: unknown;
}

export interface MagnifyOptions {
  /** The loupe shows while the target pitch is below this many CSS px. Default 44. */
  below?: number;
  /** Loupe diameter, CSS px. Default 128. */
  size?: number;
  /** Loupe magnification. Default 2.5. */
  zoom?: number;
  /** CSS px the aim point sits above a dragging finger. Default 56. */
  lift?: number;
  /** The current target pitch in CSS px (a grid cell, a list row). */
  pitch: () => number;
  /** While false nothing is aimed (for example nothing is held). Default: always. */
  when?: () => boolean;
  /** The accepted target at a game-space aim point, or `null`. Default: no snapping. */
  snap?: (x: number, y: number) => MagnifyTarget | null;
  /** True where the loupe is useful (over the targets' area). Default: wherever `snap` finds one. */
  over?: (x: number, y: number) => boolean;
  /** Game space to client CSS px (the inverse of the pointer transform), for the loupe's ring. */
  toClient?: (x: number, y: number) => { x: number; y: number };
  /** The canvas the loupe magnifies. Without one no loupe is drawn; `aim` is still reported. */
  source?: HTMLCanvasElement;
  /** Extra class names on the loupe element (`tc-loupe`). */
  className?: string;
  /** Where the loupe element goes. Default the source canvas's document body. */
  parent?: HTMLElement;
}

/** One tick's aim (see `Gestures.aim`). */
export interface Aim {
  /** The aim point in game space (the finger, lifted while dragging). */
  x: number;
  y: number;
  /** False when the aim point is outside the game rect. */
  inside: boolean;
  /** The aim point in client CSS px. */
  client: { x: number; y: number };
  /** The finger in client CSS px. */
  finger: { x: number; y: number };
  /** True while the finger drags (the aim is lifted). */
  lifted: boolean;
  /** The snapped target, or `null`. */
  target: MagnifyTarget | null;
  /** The loupe is wanted this tick (pitch below `below`, and over the targets). */
  loupe: boolean;
  /**
   * True on the one tick after the finger lifted: the aim it lifted at (where a dragged thing
   * lands). The loupe is hidden on that tick.
   */
  ended: boolean;
  /** Where the loupe's centre goes, client CSS px (beside the finger, towards the screen's middle, on screen). */
  at: { x: number; y: number };
}

export const MAGNIFY_DEFAULTS = { below: 44, size: 128, zoom: 2.5, lift: 56 } as const;

/** A square grid of cells: `cols × rows`, cell (i, j) spans `left + i·pitch` to `+ pitch`. */
export interface Grid {
  left: number;
  top: number;
  pitch: number;
  cols: number;
  rows: number;
}

/**
 * The accepted cell nearest a point, within half a pitch of its square (so a point just off the
 * board still finds an edge cell, and a point on a refused cell steps to an accepted neighbour),
 * or `null`. Distances are measured between the point and the cell centres, in pitches.
 */
export function snapToGrid(
  g: Grid,
  x: number,
  y: number,
  ok: (i: number, j: number) => boolean = () => true,
): { x: number; y: number } | null {
  const fx = (x - g.left) / g.pitch;
  const fy = (y - g.top) / g.pitch;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  let best: { x: number; y: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let j = cy - 1; j <= cy + 1; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) continue;
      // Distance from the point to the cell's square, in pitches (0 inside it).
      const ox = Math.max(0, Math.abs(fx - (i + 0.5)) - 0.5);
      const oy = Math.max(0, Math.abs(fy - (j + 0.5)) - 0.5);
      if (ox > 0.5 || oy > 0.5 || !ok(i, j)) continue;
      const d = Math.hypot(fx - (i + 0.5), fy - (j + 0.5));
      if (d < bestD) {
        bestD = d;
        best = { x: i, y: j };
      }
    }
  }
  return best;
}

/**
 * Where a loupe of diameter `size` goes for a finger at `finger` aiming at `aim` (client px) in
 * a `view` of `width × height`: above the aim point and off to the side of the finger towards
 * the middle of the screen, kept 4 px inside the view.
 */
export function loupeSpot(
  finger: { x: number; y: number },
  aim: { x: number; y: number },
  size: number,
  view: { width: number; height: number },
): { x: number; y: number } {
  const half = size / 2;
  const side = finger.x > view.width / 2 ? -1 : 1;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: clamp(finger.x + side * (half + 28), half + 4, view.width - half - 4),
    y: clamp(aim.y - half * 0.6, half + 4, view.height - half - 4),
  };
}
