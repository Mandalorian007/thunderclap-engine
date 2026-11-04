/**
 * Text size: the density tokens `--tc-text-scale` and `--tc-text-min` on the overlay root.
 *
 * - `--tc-text-scale` is the player's text size as a factor (1, 1.25, 1.5 …). A game passes each
 *   stylesheet through `scaleFontSizes()` when it injects it, so all overlay text follows the
 *   token live. `applyTextScale()` sets it, plus the engine's own font tokens to match.
 * - `--tc-text-min` is a floor for every scaled font size, in design px. Unset (0) unless a
 *   device mode sets it (`platform/device-mode.ts` does on phones).
 *
 * Small text scales fully. Large display text is already big, so it only grows as far as needed
 * to stay at least as large as scaled body text: a size N becomes max(N, min(N, 30) × scale).
 * At 150%, 24 px → 36, 30 → 45, 40 → 45, 56 → 56.
 */
export const TEXT_SCALE_VAR = '--tc-text-scale';
/** Smallest font size in design px; every scaled size floors at it. */
export const TEXT_MIN_VAR = '--tc-text-min';
const MIN = `var(${TEXT_MIN_VAR}, 0px)`;

/** Sizes up to this scale fully; above it, text is only kept from falling behind. */
const BODY_PX = 30;

/** The scaled value of `px` at `scale` (1 = 100%). */
export function scaledPx(px: number, scale: number): number {
  return Math.max(px, Math.min(px, BODY_PX) * scale);
}

/** A CSS length for `px` that follows `--tc-text-scale` and floors at `--tc-text-min`. */
export function scalePxCss(px: number): string {
  const v = `var(${TEXT_SCALE_VAR}, 1)`;
  if (px <= BODY_PX) return `max(calc(${px}px * ${v}), ${MIN})`;
  if (px < BODY_PX * 1.5) return `max(${px}px, calc(${BODY_PX}px * ${v}), ${MIN})`;
  return `${px}px`;
}

/** Rewrites every `font-size: Npx` (and `font: … Npx/…` shorthand) in a stylesheet. */
export function scaleFontSizes(css: string): string {
  return css
    .replace(/font-size:\s*(\d+(?:\.\d+)?)px/g, (_, n: string) => `font-size: ${scalePxCss(+n)}`)
    .replace(
      /(\bfont:\s*(?:\d{3}\s+)?)(\d+(?:\.\d+)?)px(?=\s*\/|\s)/g,
      (_, pre: string, n: string) => `${pre}${scalePxCss(+n)}`,
    );
}

/** Engine theme font tokens at a text scale (the engine's own captions, panels and buttons). */
export function textScaleTokens(scale: number): Record<string, string> {
  const base = { fontSizeS: 24, fontSizeM: 30, fontSizeL: 40, fontSizeXl: 56, fontSizeXxl: 84 };
  const out: Record<string, string> = {};
  for (const [k, px] of Object.entries(base)) {
    const v = Math.round(scaledPx(px, scale));
    out[k] = v < 50 ? `max(${v}px, ${MIN})` : `${v}px`;
  }
  return out;
}

/**
 * Sets the text scale (1 = 100%) on the overlay root: `--tc-text-scale`, and
 * `data-text-scale="<percent>"` when it is not 100% so stylesheets can make room for larger
 * text. `setTheme` (usually `overlay.setTheme`) gets the engine font tokens to match.
 */
export function applyTextScale(
  root: HTMLElement,
  scale: number,
  setTheme?: (t: Record<string, string>) => void,
): void {
  root.style.setProperty(TEXT_SCALE_VAR, String(scale));
  const pct = Math.round(scale * 100);
  if (pct === 100) delete root.dataset.textScale;
  else root.dataset.textScale = String(pct);
  setTheme?.(textScaleTokens(scale));
}
