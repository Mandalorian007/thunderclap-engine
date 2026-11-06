/**
 * World-panel layout: a vertical flow in panel px. Each widget is given the full inner width and
 * the height it asks for; a widget with an explicit `rect` is placed there and skipped by the
 * flow. Pure arithmetic, so it is tested without a canvas.
 */

/** A rect in panel px, from the top-left. */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the flow needs from a widget. */
export interface FlowItem {
  /** An explicit place; the flow leaves it alone. */
  rect: PanelRect | null;
  /** The height wanted for `width` px. */
  measure(width: number): number;
  /** The rect the layout assigned (written by `flowLayout`). */
  readonly layoutRect: PanelRect;
}

export interface FlowOptions {
  width: number;
  padding: number;
  gap: number;
}

/**
 * Lay `items` out top to bottom inside `width` with `padding` on every side and `gap` between
 * rows. Writes each item's `layoutRect` in place and returns the content height used (padding
 * included), so nothing is allocated.
 */
export function flowLayout(items: readonly FlowItem[], opts: FlowOptions): number {
  const inner = Math.max(0, opts.width - opts.padding * 2);
  let y = opts.padding;
  let first = true;
  for (const item of items) {
    const r = item.layoutRect;
    if (item.rect) {
      r.x = item.rect.x;
      r.y = item.rect.y;
      r.w = item.rect.w;
      r.h = item.rect.h;
      continue;
    }
    if (!first) y += opts.gap;
    first = false;
    const h = Math.max(0, Math.round(item.measure(inner)));
    r.x = opts.padding;
    r.y = y;
    r.w = inner;
    r.h = h;
    y += h;
  }
  return y + opts.padding;
}

/** Whether the panel px point lies in `r`. */
export function rectContains(r: PanelRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** Grow `acc` to include `r`; an empty `acc` (w or h ≤ 0) becomes `r`. */
export function rectUnion(acc: PanelRect, r: PanelRect): void {
  if (acc.w <= 0 || acc.h <= 0) {
    acc.x = r.x;
    acc.y = r.y;
    acc.w = r.w;
    acc.h = r.h;
    return;
  }
  const x0 = Math.min(acc.x, r.x);
  const y0 = Math.min(acc.y, r.y);
  const x1 = Math.max(acc.x + acc.w, r.x + r.w);
  const y1 = Math.max(acc.y + acc.h, r.y + r.h);
  acc.x = x0;
  acc.y = y0;
  acc.w = x1 - x0;
  acc.h = y1 - y0;
}

/** Clamp `r` to `[0, w) × [0, h)` and snap it outward to whole px. */
export function rectClampSnap(r: PanelRect, w: number, h: number): void {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w));
  const y1 = Math.min(h, Math.ceil(r.y + r.h));
  r.x = x0;
  r.y = y0;
  r.w = Math.max(0, x1 - x0);
  r.h = Math.max(0, y1 - y0);
}
