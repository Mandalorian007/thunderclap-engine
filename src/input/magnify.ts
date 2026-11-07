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
  /**
   * Loupe diameter, CSS px. Default 128. A function is read each tick, so the loupe can be
   * smaller where targets are dense (it is rebuilt when the size changes).
   */
  size?: number | (() => number);
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
  /**
   * Areas (client CSS px) the loupe must leave in sight while it shows `target`, for example
   * the target and its neighbours (`keep`), areas it should leave in sight when it can
   * (`spare`, for example labels; ranked below `keep` and the fingertip), and areas it should
   * rather not cover (`avoid`, ranked below `spare`). With one, the loupe goes where
   * `loupeClear` puts it; without, beside the finger (`loupeSpot`).
   */
  clear?: (
    target: MagnifyTarget | null,
    aim: { x: number; y: number },
  ) => { keep: Edges[]; spare?: Edges[]; avoid?: Edges[] } | null;
  /** Draw a thin leader from the loupe's rim to the snapped target (`Loupe` `leader`). */
  leader?: boolean;
}

/** An axis-aligned rectangle by its edges (left, top, right, bottom), client CSS px. */
export interface Edges {
  l: number;
  t: number;
  r: number;
  b: number;
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

/** The loupe diameter `m` asks for now (CSS px). */
export function magnifySize(m: Pick<MagnifyOptions, 'size'>): number {
  const s = typeof m.size === 'function' ? m.size() : m.size;
  return s ?? MAGNIFY_DEFAULTS.size;
}

/** A square grid of cells: `cols × rows`, cell (i, j) spans `left + i·pitch` to `+ pitch`. */
export interface SnapGrid {
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
  g: SnapGrid,
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

/**
 * Where a loupe of diameter `size` goes when it must leave `keep` in sight: the nearest spot to
 * the aim point, 6 px clear of every `keep` rect and of the fingertip (a 44 px disc), its centre
 * never below the finger's (the hand is there), kept 4 px inside the view. Among those spots it
 * takes one that covers the fewest `spare` rects, then one that covers no `avoid` rect, then the
 * nearest. With no spot clear of `keep` it falls back to `loupeSpot`.
 */
export function loupeClear(
  finger: { x: number; y: number },
  aim: { x: number; y: number },
  size: number,
  view: { width: number; height: number },
  keep: Edges[],
  avoid: Edges[] = [],
  spare: Edges[] = [],
): { x: number; y: number } {
  const half = size / 2;
  const gap = 6;
  const inView = (x: number, y: number) =>
    x >= half + 4 && x <= view.width - half - 4 && y >= half + 4 && y <= view.height - half - 4;
  const hits = (x: number, y: number, q: Edges, pad: number) => {
    const dx = Math.max(q.l - x, 0, x - q.r);
    const dy = Math.max(q.t - y, 0, y - q.b);
    return Math.hypot(dx, dy) < half + pad;
  };
  const clearOf = (x: number, y: number) =>
    inView(x, y) &&
    y <= finger.y &&
    Math.hypot(x - finger.x, y - finger.y) >= half + 22 + gap &&
    !keep.some((q) => hits(x, y, q, gap));
  // Candidates: tangent to the kept area on each side and corner, slid along it, beside the
  // finger, and (so a spot clear of the spared rects is found when there is one) a coarse grid
  // over the view.
  const box = keep.reduce(
    (a, q) => ({
      l: Math.min(a.l, q.l),
      t: Math.min(a.t, q.t),
      r: Math.max(a.r, q.r),
      b: Math.max(a.b, q.b),
    }),
    { l: aim.x, t: aim.y, r: aim.x, b: aim.y },
  );
  const xs = [box.l - half - gap, box.r + half + gap];
  const ys = [box.t - half - gap, box.b + half + gap];
  const cands: { x: number; y: number }[] = [loupeSpot(finger, aim, size, view)];
  for (let k = -4; k <= 4; k++) {
    const sx = (k * half) / 2;
    for (const x of xs) cands.push({ x, y: aim.y + sx });
    for (const y of ys) cands.push({ x: aim.x + sx, y });
  }
  if (spare.length > 0 && Number.isFinite(view.width) && Number.isFinite(view.height)) {
    const step = Math.max(8, half / 4);
    for (let y = half + 4; y <= view.height - half - 4; y += step)
      for (let x = half + 4; x <= view.width - half - 4; x += step) cands.push({ x, y });
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let best: { x: number; y: number } | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const c0 of cands) {
    const c = {
      x: clamp(c0.x, half + 4, view.width - half - 4),
      y: clamp(c0.y, half + 4, view.height - half - 4),
    };
    if (!clearOf(c.x, c.y)) continue;
    const cost =
      Math.hypot(c.x - aim.x, c.y - aim.y) +
      (avoid.some((q) => hits(c.x, c.y, q, 0)) ? 1e4 : 0) +
      spare.filter((q) => hits(c.x, c.y, q, 0)).length * 1e6;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best ?? loupeSpot(finger, aim, size, view);
}
