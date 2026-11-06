/**
 * World-panel painting: a Canvas2D the panel texture is uploaded from, the theme read by value
 * from `theme.ts`, and the small set of drawing helpers the widgets share. The canvas is
 * injectable (`PanelCanvas`) so tests paint into a stub; `makePanelCanvas` picks `OffscreenCanvas`,
 * then `document.createElement('canvas')`.
 */
import { cssPxTheme, defaultTheme, type ThemeTokens } from '../theme';
import type { PanelRect } from './layout';

/** The Canvas2D subset the panel paints with (a `CanvasRenderingContext2D` satisfies it). */
export interface PanelContext2D {
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** A canvas the panel owns: `width`/`height` in px and a 2D context. */
export interface PanelCanvas {
  readonly width: number;
  readonly height: number;
  getContext(kind: '2d', opts?: { alpha?: boolean }): PanelContext2D | null;
}

/** `OffscreenCanvas`, else a `<canvas>`; throws where neither exists. */
export function makePanelCanvas(width: number, height: number): PanelCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height) as unknown as PanelCanvas;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c as unknown as PanelCanvas;
  }
  throw new Error('world panel: no OffscreenCanvas or document to make a canvas');
}

/** Theme tokens as numbers and strings the painter reads each paint. */
export interface PanelTheme {
  tokens: ThemeTokens;
  font: string;
  fontSizeS: number;
  fontSizeM: number;
  fontSizeL: number;
  space1: number;
  space2: number;
  space3: number;
  space4: number;
  radiusS: number;
  radiusM: number;
  borderWidth: number;
  focusRing: number;
}

/** `'12px'` → 12 (any other unit or junk → `fallback`). */
export function tokenPx(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The panel's theme: `cssPxTheme` (the design tokens at CSS px, so a 256 px/unit panel reads at
 * arm's length) under `overrides`. Every value is read once here; widgets paint from the result.
 */
export function resolvePanelTheme(overrides?: Partial<ThemeTokens>): PanelTheme {
  const tokens: ThemeTokens = { ...defaultTheme, ...cssPxTheme, ...overrides };
  return {
    tokens,
    font: tokens.fontUi,
    fontSizeS: tokenPx(tokens.fontSizeS, 14),
    fontSizeM: tokenPx(tokens.fontSizeM, 16),
    fontSizeL: tokenPx(tokens.fontSizeL, 20),
    space1: tokenPx(tokens.space1, 2),
    space2: tokenPx(tokens.space2, 4),
    space3: tokenPx(tokens.space3, 8),
    space4: tokenPx(tokens.space4, 12),
    radiusS: tokenPx(tokens.radiusS, 4),
    radiusM: tokenPx(tokens.radiusM, 8),
    borderWidth: tokenPx(tokens.borderWidth, 1),
    focusRing: tokenPx(tokens.focusRing, 2),
  };
}

/** Trace a rounded rect path (`r` clamped to half the shorter side). */
export function roundRectPath(
  ctx: PanelContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * The painter the widgets draw through: the context, the theme and a text-width cache keyed by
 * font and string (cleared when the font loads).
 */
export class Painter {
  private readonly widths = new Map<string, number>();

  constructor(
    readonly ctx: PanelContext2D,
    readonly theme: PanelTheme,
  ) {}

  /** `size`px of the theme font as a CSS font string. */
  font(size: number, weight = 500): string {
    return `${weight} ${size}px ${this.theme.font}`;
  }

  /** Text width in px for `font`, measured once per (font, text). */
  measure(text: string, font: string): number {
    const key = `${font}\u0000${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  /** Drop every cached width (after the font loaded). */
  clearMeasures(): void {
    this.widths.clear();
  }

  fillRoundRect(r: PanelRect, radius: number, fill: string): void {
    const ctx = this.ctx;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  strokeRoundRect(r: PanelRect, radius: number, stroke: string, width: number): void {
    const ctx = this.ctx;
    const half = width / 2;
    roundRectPath(
      ctx,
      r.x + half,
      r.y + half,
      r.w - width,
      r.h - width,
      Math.max(0, radius - half),
    );
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /** The focus ring: a stroke of `focusRing` px just outside `r`. */
  focusRing(r: PanelRect, radius: number): void {
    const t = this.theme;
    const w = t.focusRing;
    const ctx = this.ctx;
    roundRectPath(ctx, r.x - w / 2, r.y - w / 2, r.w + w, r.h + w, radius + w / 2);
    ctx.strokeStyle = t.tokens.colorFocus;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  /**
   * One line of `text` at `size`px, clipped to `r`, `align`ed inside it with `padX` px of inset
   * and vertically centred.
   */
  text(
    text: string,
    r: PanelRect,
    size: number,
    color: string,
    align: 'left' | 'center' | 'right' = 'left',
    padX = 0,
    weight = 500,
  ): void {
    if (text.length === 0 || r.w <= 0 || r.h <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.font = this.font(size, weight);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = align;
    const x = align === 'left' ? r.x + padX : align === 'right' ? r.x + r.w - padX : r.x + r.w / 2;
    ctx.fillText(text, x, r.y + r.h / 2);
    ctx.restore();
  }
}
