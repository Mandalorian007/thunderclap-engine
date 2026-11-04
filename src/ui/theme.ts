/**
 * Theme tokens, exposed as CSS custom properties on the overlay root: `colorAccent` becomes
 * `--tc-color-accent`. Sizes are in **design pixels** (the overlay is laid out at the logical
 * resolution, 1920×1080 by default, and scaled to fit), so 30px reads as ~15px in a 960×540 embed.
 *
 * Fonts are system stacks only: nothing is fetched at runtime. A game may add a self-hosted
 * font with `@font-face` (committed with its licence) and put it first in a stack.
 */
export const defaultTheme = {
  fontBody: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  fontDisplay: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  fontMono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontUi: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",

  fontSizeS: '24px',
  fontSizeM: '30px',
  fontSizeL: '40px',
  fontSizeXl: '56px',
  fontSizeXxl: '84px',
  lineHeight: '1.4',

  colorBg: '#0b0d14',
  colorSurface: 'rgba(18, 21, 30, 0.94)',
  colorSurfaceAlt: 'rgba(32, 36, 48, 0.96)',
  colorBorder: 'rgba(224, 180, 90, 0.35)',
  colorText: '#ece6d8',
  colorTextMuted: '#a7a091',
  colorAccent: '#e0b45a',
  colorAccentText: '#1a1408',
  colorFocus: '#ffd27a',
  colorBackdrop: 'rgba(5, 6, 10, 0.6)',
  colorInfo: '#7cc4e8',
  colorSuccess: '#8fd18a',
  colorWarn: '#f0b45a',
  colorDanger: '#e8766a',

  space1: '4px',
  space2: '8px',
  space3: '16px',
  space4: '24px',
  space5: '40px',
  space6: '64px',

  radiusS: '6px',
  radiusM: '12px',
  radiusL: '20px',
  borderWidth: '2px',
  shadow: '0 12px 48px rgba(0, 0, 0, 0.55)',
  focusRing: '3px',

  durationFast: '120ms',
  durationNormal: '240ms',
  easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
};

export type ThemeTokens = { [K in keyof typeof defaultTheme]: string };
/**
 * Size tokens for a CSS-px overlay (`createOverlay({ legacyScale: false })`), applied over
 * `defaultTheme`: the same scale at screen size (about half the design-px values), so 16 px body
 * text reads as 16 px on every screen. Colours, fonts and timings are shared.
 */
export const cssPxTheme: Partial<ThemeTokens> = {
  fontSizeS: '14px',
  fontSizeM: '16px',
  fontSizeL: '20px',
  fontSizeXl: '28px',
  fontSizeXxl: '40px',
  space1: '2px',
  space2: '4px',
  space3: '8px',
  space4: '12px',
  space5: '20px',
  space6: '32px',
  radiusS: '4px',
  radiusM: '8px',
  radiusL: '12px',
  borderWidth: '1px',
  shadow: '0 6px 24px rgba(0, 0, 0, 0.55)',
  focusRing: '2px',
};

/** Games may add their own tokens too; they become `--tc-<kebab-name>` the same way. */
export type ThemeOverrides = Partial<ThemeTokens> & Record<string, string>;

/** `colorAccent` → `--tc-color-accent`, `fontSizeXl` → `--tc-font-size-xl`, `space1` → `--tc-space-1`. */
export function tokenVar(name: string): string {
  const kebab = name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
  return `--tc-${kebab}`;
}

/** `var(--tc-…)` for use in inline styles. */
export function cssVar(name: keyof ThemeTokens | (string & {})): string {
  return `var(${tokenVar(name)})`;
}

/** CSS declarations for a set of tokens, e.g. for a `:root` or class rule. */
export function themeToCss(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([k, v]) => `${tokenVar(k)}: ${v};`)
    .join('\n');
}

/** Set tokens as custom properties on an element (inherits to children). */
export function applyTheme(el: HTMLElement, tokens: Record<string, string>): void {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(tokenVar(k), v);
}
