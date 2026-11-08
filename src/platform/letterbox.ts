/**
 * Pure letterbox + coordinate math. No DOM, so it is unit-testable in Node.
 *
 * Terms:
 * - "client" = CSS pixels relative to the container's top-left corner.
 * - "logical" = the fixed design space (default 1920×1080), origin top-left, y down.
 * - "backbuffer" = physical pixels of the canvas drawing buffer.
 */

export interface LetterboxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Letterboxed viewport inside a container, in client (CSS) pixels. */
export interface Letterbox extends LetterboxRect {
  /** CSS pixels per logical unit. */
  scale: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Fit a logicalW×logicalH design space into a container, preserving aspect ratio and centring
 * it. Size is snapped to whole CSS pixels so the canvas edges stay crisp.
 */
export function computeLetterbox(
  containerW: number,
  containerH: number,
  logicalW: number,
  logicalH: number,
): Letterbox {
  if (!(containerW > 0) || !(containerH > 0) || !(logicalW > 0) || !(logicalH > 0)) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  const fit = Math.min(containerW / logicalW, containerH / logicalH);
  const width = Math.max(1, Math.min(containerW, Math.round(logicalW * fit)));
  const height = Math.max(1, Math.min(containerH, Math.round(logicalH * fit)));
  const x = Math.floor((containerW - width) / 2);
  const y = Math.floor((containerH - height) / 2);
  return { x, y, width, height, scale: width / logicalW };
}

/**
 * How far a cover fit may crop the design (`SurfaceOptions.fit`, `computeCover`). The limits
 * are a band of the design that always stays on screen: a 16:9 game with its safe content in
 * the middle 1920×810 passes `minVisibleHeight: 810` and never crops past it on a wide phone.
 */
export interface CoverOptions {
  /**
   * In a frame wider than the design: the least logical height kept on screen. The canvas grows
   * to fill the width only as far as this allows; past it the bars come back (narrower than the
   * letterbox's). Default 0: cover the frame whatever it crops. The design height never crops.
   */
  minVisibleHeight?: number;
  /**
   * In a frame taller than the design (an upright phone): the least logical width kept on
   * screen, the sides cropping instead. Default 0. The design width keeps the letterbox there.
   */
  minVisibleWidth?: number;
  /** Logical x the visible band is centred on (clamped inside the design). Default the middle. */
  focusX?: number;
  /** Logical y the visible band is centred on (clamped inside the design). Default the middle. */
  focusY?: number;
  /**
   * Cover only while the whole container's letterbox scale (`Surface.fitRect.scale`, CSS px per
   * logical unit) is below this; at or above it the surface letterboxes. `PHONE_SCALE` keeps
   * tablets and desktops showing the whole design and covers phones. Default: always cover.
   * Read by the surface; `computeCover` ignores it.
   */
  belowScale?: number;
}

/**
 * Cover a frameW×frameH frame with a logicalW×logicalH design, cropped to `opts`'s band: in a
 * frame wider than the design the canvas fills the width and the top and bottom overflow (`y`
 * goes negative, `height` exceeds the frame); in a taller one it fills the height and the sides
 * overflow. Never smaller than `computeLetterbox`'s fit, and whole CSS px like it. The visible
 * band is centred on `focusX` / `focusY`.
 */
export function computeCover(
  frameW: number,
  frameH: number,
  logicalW: number,
  logicalH: number,
  opts: CoverOptions = {},
): Letterbox {
  const fit = computeLetterbox(frameW, frameH, logicalW, logicalH);
  if (fit.scale === 0) return fit;
  if (frameW * logicalH < frameH * logicalW) {
    const keep = Math.min(logicalW, Math.max(1, opts.minVisibleWidth ?? 0));
    const want = Math.min(frameH / logicalH, frameW / keep);
    if (want <= fit.scale) return fit;
    const height = Math.min(frameH, Math.round(logicalH * want));
    const scale = height / logicalH;
    const width = Math.round(logicalW * scale);
    const visible = frameW / scale;
    const focus = opts.focusX ?? logicalW / 2;
    const left = Math.min(Math.max(0, focus - visible / 2), Math.max(0, logicalW - visible));
    return {
      x: -Math.round(left * scale) || 0,
      y: Math.floor((frameH - height) / 2),
      width,
      height,
      scale,
    };
  }
  const keep = Math.min(logicalH, Math.max(1, opts.minVisibleHeight ?? 0));
  const want = Math.min(frameW / logicalW, frameH / keep);
  if (want <= fit.scale) return fit;
  const width = Math.min(frameW, Math.round(logicalW * want));
  const scale = width / logicalW;
  const height = Math.round(logicalH * scale);
  const visible = frameH / scale;
  const focus = opts.focusY ?? logicalH / 2;
  const top = Math.min(Math.max(0, focus - visible / 2), Math.max(0, logicalH - visible));
  return {
    x: Math.floor((frameW - width) / 2),
    y: -Math.round(top * scale) || 0,
    width,
    height,
    scale,
  };
}

/**
 * The part of the design a canvas at `box` shows through `clip` (both in client px, e.g. the
 * surface's rect and its frame), in logical units. Empty (all zero) when they do not overlap.
 * Writes into `out` when given.
 */
export function visibleLogicalRect(
  box: LetterboxRect,
  clip: LetterboxRect,
  logicalW: number,
  logicalH: number,
  out: LetterboxRect = { x: 0, y: 0, width: 0, height: 0 },
): LetterboxRect {
  const x0 = Math.max(box.x, clip.x);
  const y0 = Math.max(box.y, clip.y);
  const x1 = Math.min(box.x + box.width, clip.x + clip.width);
  const y1 = Math.min(box.y + box.height, clip.y + clip.height);
  if (!(box.width > 0) || !(box.height > 0) || !(x1 > x0) || !(y1 > y0)) {
    out.x = 0;
    out.y = 0;
    out.width = 0;
    out.height = 0;
    return out;
  }
  const kx = logicalW / box.width;
  const ky = logicalH / box.height;
  out.x = (x0 - box.x) * kx;
  out.y = (y0 - box.y) * ky;
  out.width = (x1 - x0) * kx;
  out.height = (y1 - y0) * ky;
  return out;
}

/** Map a client point (CSS px relative to the container) into logical space. */
export function clientToLogical(
  box: LetterboxRect,
  logicalW: number,
  logicalH: number,
  cx: number,
  cy: number,
  out: Vec2 = { x: 0, y: 0 },
): Vec2 {
  if (box.width <= 0 || box.height <= 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  out.x = ((cx - box.x) / box.width) * logicalW;
  out.y = ((cy - box.y) / box.height) * logicalH;
  return out;
}

/** Map a logical point back to client CSS px relative to the container. */
export function logicalToClient(
  box: LetterboxRect,
  logicalW: number,
  logicalH: number,
  lx: number,
  ly: number,
  out: Vec2 = { x: 0, y: 0 },
): Vec2 {
  out.x = box.x + (lx / logicalW) * box.width;
  out.y = box.y + (ly / logicalH) * box.height;
  return out;
}

export interface BackbufferSize {
  width: number;
  height: number;
  /** Effective pixel ratio actually used (after caps). */
  pixelRatio: number;
}

/**
 * Choose drawing-buffer size for a CSS rect: devicePixelRatio, capped by `maxDpr`, then scaled
 * down further if the total pixel count would exceed `maxPixels` (perf budget on iGPUs).
 */
export function computeBackbuffer(
  cssW: number,
  cssH: number,
  devicePixelRatio: number,
  maxDpr = 2,
  maxPixels = Number.POSITIVE_INFINITY,
): BackbufferSize {
  if (!(cssW > 0) || !(cssH > 0)) return { width: 1, height: 1, pixelRatio: 1 };
  let ratio = Math.min(Math.max(devicePixelRatio || 1, 0.25), maxDpr);
  const px = cssW * ratio * cssH * ratio;
  if (px > maxPixels) ratio *= Math.sqrt(maxPixels / px);
  return {
    width: Math.max(1, Math.round(cssW * ratio)),
    height: Math.max(1, Math.round(cssH * ratio)),
    pixelRatio: ratio,
  };
}
