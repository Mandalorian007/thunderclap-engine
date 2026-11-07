/**
 * `NavBakeOptions` defaults and validation (ws/nav-6). Every numeric option but `cellSize` has a
 * default derived from it, and a value that would bake NaN cells (non-finite, negative, out of
 * range) throws a `NavBakeError` naming the option instead of yielding an empty mesh. Bake-time
 * code; `scripts/bake-nav.mjs` resolves its options through the same function.
 */
import type { NavBakeOptions } from './voxelize';

/** Thrown by `bakeNavMesh` (and `resolveNavBakeOptions`) for an option it cannot bake with. */
export class NavBakeError extends Error {
  /** The option's name, as in `NavBakeOptions`. */
  readonly option: string;
  /** The value given. */
  readonly value: unknown;
  constructor(option: string, value: unknown, rule: string) {
    super(`bakeNavMesh: ${option} must be ${rule}, got ${showValue(value)}`);
    this.name = 'NavBakeError';
    this.option = option;
    this.value = value;
  }
}

/** `NavBakeOptions` with every default filled in. */
export type ResolvedNavBakeOptions = Required<NavBakeOptions>;

/** The fixed defaults; the rest derive from `cellSize` (see `resolveNavBakeOptions`). */
export const NAV_BAKE_DEFAULTS = Object.freeze({
  agentHeight: 2,
  agentMaxSlope: 45,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
});

function showValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v);
  return typeof v;
}

function num(
  opts: NavBakeOptions,
  key: keyof NavBakeOptions,
  fallback: number,
  min: number,
  minOpen: boolean,
  max = Number.POSITIVE_INFINITY,
): number {
  const v = (opts as unknown as Record<string, unknown>)[key];
  if (v === undefined) return fallback;
  const rule =
    max === Number.POSITIVE_INFINITY
      ? `a finite number ${minOpen ? '>' : '>='} ${min}`
      : `a number in ${min}..${max}`;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new NavBakeError(key, v, rule);
  if (minOpen ? v <= min : v < min) throw new NavBakeError(key, v, rule);
  if (v > max) throw new NavBakeError(key, v, rule);
  return v;
}

/**
 * Fills the defaults and validates: `cellHeight = cellSize / 2`, `agentHeight = 2`,
 * `agentRadius = cellSize * 2`, `agentMaxClimb = cellHeight * 2`, `agentMaxSlope = 45`,
 * `minRegionArea = 8`, `mergeRegionArea = 20`, `maxEdgeLength = 12 * cellSize`,
 * `maxSimplification = 1.3 * cellSize`, `maxVertsPerPoly = 6`. Throws a `NavBakeError` for a
 * missing `cellSize` or any value that is not a finite number in range.
 */
export function resolveNavBakeOptions(opts: NavBakeOptions): ResolvedNavBakeOptions {
  if (opts === null || typeof opts !== 'object') {
    throw new NavBakeError('options', opts, 'an object with a cellSize');
  }
  const cs = (opts as { cellSize?: unknown }).cellSize;
  if (typeof cs !== 'number' || !Number.isFinite(cs) || cs <= 0) {
    throw new NavBakeError('cellSize', cs, 'a finite number > 0 (it has no default)');
  }
  const cellHeight = num(opts, 'cellHeight', cs / 2, 0, true);
  const nvp = num(opts, 'maxVertsPerPoly', NAV_BAKE_DEFAULTS.maxVertsPerPoly, 3, false, 6);
  if (!Number.isInteger(nvp)) throw new NavBakeError('maxVertsPerPoly', nvp, 'an integer in 3..6');
  return {
    cellSize: cs,
    cellHeight,
    agentHeight: num(opts, 'agentHeight', NAV_BAKE_DEFAULTS.agentHeight, 0, true),
    agentRadius: num(opts, 'agentRadius', cs * 2, 0, false),
    agentMaxClimb: num(opts, 'agentMaxClimb', cellHeight * 2, 0, false),
    agentMaxSlope: num(opts, 'agentMaxSlope', NAV_BAKE_DEFAULTS.agentMaxSlope, 0, false, 90),
    minRegionArea: num(opts, 'minRegionArea', NAV_BAKE_DEFAULTS.minRegionArea, 0, false),
    mergeRegionArea: num(opts, 'mergeRegionArea', NAV_BAKE_DEFAULTS.mergeRegionArea, 0, false),
    maxEdgeLength: num(opts, 'maxEdgeLength', 12 * cs, 0, false),
    maxSimplification: num(opts, 'maxSimplification', 1.3 * cs, 0, false),
    maxVertsPerPoly: nvp,
  };
}
