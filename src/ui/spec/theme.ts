/**
 * A spec panel's look (ws/ui-spec): tokens, not parsed CSS. `theme(tokens)` resolves a partial set
 * over the defaults; the DOM presenter writes them on its host as `--tcs-*` custom properties
 * (one structural stylesheet reads them), and a world presenter reads the same tokens directly.
 * Sizes are spec units (CSS px at UI scale 1).
 */

import { SPEC_MONO, SPEC_SANS, SPEC_SERIF } from './measure';

/** A spec look's tokens. */
export interface SpecTokens {
  /** Type stacks by `SPEC_TYPE` family. */
  readonly fontSans: string;
  readonly fontSerif: string;
  readonly fontMono: string;
  /** The panel's surface (a HUD's panels are usually see-through), and a word's own (buttons, slots, fields). */
  readonly surface: string;
  readonly surfaceAlt: string;
  /** Pressed or selected. */
  readonly surfaceOn: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  /** Lit runs (`marked` text), a meter's fill, a selected tab's line. */
  readonly accent: string;
  readonly accentText: string;
  readonly warn: string;
  readonly danger: string;
  readonly good: string;
  /** The keyboard focus ring. */
  readonly focus: string;
  /** A meter's empty track. */
  readonly track: string;
  /** Corner radius, border width and focus ring width (units). */
  readonly radius: number;
  readonly borderWidth: number;
  readonly focusRing: number;
  /** Padding inside a button or field (units, each side). */
  readonly padX: number;
  /** A shadow under panels with a surface (CSS `box-shadow`; 'none' for none). */
  readonly shadow: string;
  /** A short transition (ms): presses, fades, meter fills. */
  readonly fast: number;
}

/** The default look: dark glass, warm accent. */
export const defaultSpecTokens: SpecTokens = {
  fontSans: SPEC_SANS,
  fontSerif: SPEC_SERIF,
  fontMono: SPEC_MONO,
  surface: 'rgba(14, 16, 24, 0.86)',
  surfaceAlt: 'rgba(36, 40, 54, 0.92)',
  surfaceOn: 'rgba(78, 70, 44, 0.95)',
  border: 'rgba(224, 180, 90, 0.35)',
  text: '#ece6d8',
  textMuted: '#a7a091',
  accent: '#e0b45a',
  accentText: '#1a1408',
  warn: '#f0b45a',
  danger: '#e8766a',
  good: '#8fd18a',
  focus: '#ffd27a',
  track: 'rgba(255, 255, 255, 0.12)',
  radius: 6,
  borderWidth: 1,
  focusRing: 2,
  padX: 10,
  shadow: '0 6px 24px rgba(0, 0, 0, 0.5)',
  fast: 120,
};

/** A resolved look: its tokens, and each one as a CSS custom property (`--tcs-<name>`). */
export interface SpecTheme {
  readonly tokens: SpecTokens;
  /** `[property, value]` pairs, written on a presenter's host. */
  readonly vars: readonly (readonly [string, string])[];
}

const NUMERIC_MS: ReadonlySet<keyof SpecTokens> = new Set(['fast']);

/** `fontSans` → `--tcs-font-sans`. */
export function specTokenVar(name: keyof SpecTokens): string {
  return `--tcs-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** A look from `tokens` over the defaults (sizes in units: the presenter scales them). */
export function theme(tokens: Partial<SpecTokens> = {}): SpecTheme {
  const t: SpecTokens = { ...defaultSpecTokens, ...tokens };
  const vars: [string, string][] = [];
  for (const k of Object.keys(t) as (keyof SpecTokens)[]) {
    const v = t[k];
    // Numbers are units, scaled by the presenter with `--tcs-scale` (ms stay ms).
    const css =
      typeof v === 'number'
        ? NUMERIC_MS.has(k)
          ? `${v}ms`
          : `calc(${v}px * var(--tcs-scale, 1))`
        : v;
    vars.push([specTokenVar(k), css]);
  }
  return { tokens: t, vars };
}
