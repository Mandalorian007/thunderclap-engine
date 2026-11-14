/**
 * How a spec panel moves (ws/ui-fit, from Forge Wilds' `ui/spec/motion.ts`): a list's rows sliding
 * (a `slide` move) and a body sliding in and out (`PanelSpec.slide`) run the same time, reach and
 * ease on the page (CSS, the Web Animations API) and on a world surface (painted steps), and both
 * stand still while motion is reduced.
 */

/** Rows that moved further than this (units) don't slide: a jump across the list. */
export const SPEC_SLIDE_MAX = 2000;
/** How long a list's slide takes, ms. */
export const SPEC_SLIDE_MS = 220;

/** CSS's cubic-bezier(x1, 0, x2, 1) at `t` in 0..1. */
function ease(t: number, x1: number, x2: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // The curve's parameter u where its x is t (x rises with u: halving finds it), then its y.
  let a = 0;
  let b = 1;
  for (let i = 0; i < 24; i++) {
    const u = (a + b) / 2;
    if (3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u < t) a = u;
    else b = u;
  }
  const u = (a + b) / 2;
  return 3 * u * u * (1 - u) + u * u * u;
}

/** CSS's `ease-out` at `t` in 0..1: how far along a slide is. */
export function specEaseOut(t: number): number {
  return ease(t, 0, 0.58);
}

/** CSS's `ease-in` at `t` in 0..1 (a body sliding out, a fade going). */
export function specEaseIn(t: number): number {
  return ease(t, 0.42, 1);
}

let reduce: MediaQueryList | null | undefined;
let still: boolean | null = null;

/**
 * The game's own reduced-motion setting (its options menu): true stills every panel, false moves
 * them even with the system's set, null (the default) follows the system's.
 */
export function setSpecStill(on: boolean | null): void {
  still = on;
}

/** Motion is reduced (the game's setting, `setSpecStill`, else the system's): nothing slides. */
export function specStill(): boolean {
  if (still !== null) return still;
  if (reduce === undefined)
    reduce =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return reduce?.matches === true;
}

/** The clock a world presenter's motion reads (ms). */
export function specNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
