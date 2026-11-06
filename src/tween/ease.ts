/**
 * Easing functions: map linear progress `t` on 0..1 to eased progress. Every entry of `ease`
 * is 0 at 0 and 1 at 1; `back`, `elastic` and `cubicBezier` may leave 0..1 in between.
 *
 * `ease.spring(stiffness, damping)` is not a function of `t`: a spring has no duration, so it
 * describes a `SpringEase` the tween engine simulates until it settles (see `tween.ts`).
 */

/** Maps linear progress 0..1 to eased progress. */
export type Ease = (t: number) => number;

/**
 * A duration-free spring toward the target (unit mass): `a = stiffness · (1 − x) − damping · v`.
 * A tween given one ignores its `seconds`, `loops` and `yoyo` and ends when it has settled.
 */
export interface SpringEase {
  readonly kind: 'spring';
  readonly stiffness: number;
  readonly damping: number;
}

export function isSpring(e: Ease | SpringEase | undefined): e is SpringEase {
  return typeof e === 'object' && e !== null && e.kind === 'spring';
}

const PI = Math.PI;
const HALF_PI = PI / 2;
const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;
const C4 = (2 * PI) / 3;
const C5 = (2 * PI) / 4.5;
const N1 = 7.5625;
const D1 = 2.75;

const linear: Ease = (t) => t;
/** `t² (3 − 2t)`: the smoothstep polynomial, the default of `PostStack.blendTo`. */
const smoothstep: Ease = (t) => t * t * (3 - 2 * t);

const quadIn: Ease = (t) => t * t;
const quadOut: Ease = (t) => 1 - (1 - t) * (1 - t);
const quadInOut: Ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const cubicIn: Ease = (t) => t * t * t;
const cubicOut: Ease = (t) => 1 - (1 - t) ** 3;
const cubicInOut: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const quartIn: Ease = (t) => t * t * t * t;
const quartOut: Ease = (t) => 1 - (1 - t) ** 4;
const quartInOut: Ease = (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - (-2 * t + 2) ** 4 / 2);

const quintIn: Ease = (t) => t * t * t * t * t;
const quintOut: Ease = (t) => 1 - (1 - t) ** 5;
const quintInOut: Ease = (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2);

const sineIn: Ease = (t) => 1 - Math.cos(t * HALF_PI);
const sineOut: Ease = (t) => Math.sin(t * HALF_PI);
const sineInOut: Ease = (t) => -(Math.cos(PI * t) - 1) / 2;

const expoIn: Ease = (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10));
const expoOut: Ease = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const expoInOut: Ease = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;

const circIn: Ease = (t) => 1 - Math.sqrt(1 - t * t);
const circOut: Ease = (t) => Math.sqrt(1 - (t - 1) * (t - 1));
const circInOut: Ease = (t) =>
  t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2;

const backIn: Ease = (t) => C3 * t * t * t - C1 * t * t;
const backOut: Ease = (t) => 1 + C3 * (t - 1) ** 3 + C1 * (t - 1) ** 2;
const backInOut: Ease = (t) =>
  t < 0.5
    ? ((2 * t) ** 2 * ((C2 + 1) * 2 * t - C2)) / 2
    : ((2 * t - 2) ** 2 * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2;

const elasticIn: Ease = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * C4);
const elasticOut: Ease = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1;
const elasticInOut: Ease = (t) =>
  t <= 0
    ? 0
    : t >= 1
      ? 1
      : t < 0.5
        ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * C5)) / 2
        : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * C5)) / 2 + 1;

const bounceOut: Ease = (t) => {
  if (t < 1 / D1) return N1 * t * t;
  if (t < 2 / D1) {
    const u = t - 1.5 / D1;
    return N1 * u * u + 0.75;
  }
  if (t < 2.5 / D1) {
    const u = t - 2.25 / D1;
    return N1 * u * u + 0.9375;
  }
  const u = t - 2.625 / D1;
  return N1 * u * u + 0.984375;
};
const bounceIn: Ease = (t) => 1 - bounceOut(1 - t);
const bounceInOut: Ease = (t) =>
  t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2;

/** `n` equal steps: 0 until the first step, 1 at `t = 1`. */
function steps(n: number): Ease {
  const k = Math.max(1, Math.floor(n));
  return (t) => (t >= 1 ? 1 : Math.floor(t * k) / k);
}

/**
 * The CSS `cubic-bezier(x1, y1, x2, y2)` timing function: the curve from (0,0) through the two
 * control points to (1,1); `x` is solved for `t` by Newton iteration with a bisection fallback.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const ax = 1 - 3 * x2 + 3 * x1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 1 - 3 * y2 + 3 * y1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const x = sampleX(u) - t;
      if (Math.abs(x) < 1e-6) return sampleY(u);
      const d = slopeX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= x / d;
    }
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 32 && hi - lo > 1e-7; i++) {
      if (sampleX(u) < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sampleY(u);
  };
}

/**
 * A duration-free spring (unit mass). Critical damping is `2 · √stiffness`; less overshoots.
 * Default `170, 22`, which settles in about half a second with a slight overshoot.
 */
function spring(stiffness = 170, damping = 22): SpringEase {
  return { kind: 'spring', stiffness, damping };
}

/** The easing table. */
export const ease = {
  linear,
  smoothstep,
  quadIn,
  quadOut,
  quadInOut,
  cubicIn,
  cubicOut,
  cubicInOut,
  quartIn,
  quartOut,
  quartInOut,
  quintIn,
  quintOut,
  quintInOut,
  sineIn,
  sineOut,
  sineInOut,
  expoIn,
  expoOut,
  expoInOut,
  circIn,
  circOut,
  circInOut,
  backIn,
  backOut,
  backInOut,
  elasticIn,
  elasticOut,
  elasticInOut,
  bounceIn,
  bounceOut,
  bounceInOut,
  steps,
  cubicBezier,
  spring,
} as const;

/**
 * Advance a spring state by `dt` seconds: `s[0]` is the position (0 at the start, 1 at the
 * target), `s[1]` the velocity. Semi-implicit Euler in substeps of at most `SPRING_STEP` so a
 * stiff spring stays stable on a slow frame. Returns true once the spring has settled, with
 * the position snapped to 1 and the velocity to 0.
 */
export function stepSpring(s: Float64Array, e: SpringEase, dt: number): boolean {
  let x = s[0]!;
  let v = s[1]!;
  let left = dt;
  while (left > 0) {
    const h = Math.min(left, SPRING_STEP);
    left -= h;
    v += (e.stiffness * (1 - x) - e.damping * v) * h;
    x += v * h;
  }
  if (Math.abs(1 - x) < SPRING_EPSILON && Math.abs(v) < SPRING_EPSILON) {
    s[0] = 1;
    s[1] = 0;
    return true;
  }
  s[0] = x;
  s[1] = v;
  return false;
}

const SPRING_STEP = 1 / 240;
const SPRING_EPSILON = 1e-3;
