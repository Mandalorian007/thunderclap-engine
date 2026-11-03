/**
 * Pure letterbox + coordinate math. No DOM, so it is unit-testable in Node.
 *
 * Terms:
 * - "client" = CSS pixels relative to the container's top-left corner.
 * - "logical" = the fixed design space (default 1920×1080), origin top-left, y down.
 * - "backbuffer" = physical pixels of the canvas drawing buffer.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Letterboxed viewport inside a container, in client (CSS) pixels. */
export interface Letterbox extends Rect {
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

/** How `computeFillWidth` trades bars for crop. */
export interface FillWidthOptions {
  /**
   * The least logical height that must stay on screen. The canvas grows to fill the width only
   * as far as this allows; past it the bars come back (narrower than the contain fit's).
   */
  minVisible: number;
  /** Logical y the visible band is centred on (clamped inside the design). Default: the middle. */
  focusY?: number;
}

/**
 * Like `computeLetterbox`, but on a container wider than the design's aspect the canvas grows
 * to fill the width and the top and bottom are cropped instead (the rect's `y` goes negative
 * and its height overflows the container). Never smaller than the contain fit.
 */
export function computeFillWidth(
  containerW: number,
  containerH: number,
  logicalW: number,
  logicalH: number,
  opts: FillWidthOptions,
): Letterbox {
  const fit = computeLetterbox(containerW, containerH, logicalW, logicalH);
  if (fit.scale === 0) return fit;
  const band = Math.min(logicalH, Math.max(1, opts.minVisible));
  const want = Math.min(containerW / logicalW, containerH / band);
  if (want <= fit.scale) return fit;
  const width = Math.min(containerW, Math.round(logicalW * want));
  const scale = width / logicalW;
  const height = Math.round(logicalH * scale);
  const visible = containerH / scale;
  const focus = opts.focusY ?? logicalH / 2;
  const top = Math.min(Math.max(0, focus - visible / 2), Math.max(0, logicalH - visible));
  return {
    x: Math.floor((containerW - width) / 2),
    y: -Math.round(top * scale) || 0,
    width,
    height,
    scale,
  };
}

/** Map a client point (CSS px relative to the container) into logical space. */
export function clientToLogical(
  box: Rect,
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
  box: Rect,
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
