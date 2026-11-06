/**
 * Level-building shapes assembled from the sweeps and primitives: `stairs` and `arch`. Both are
 * centred on the origin (their axis-aligned box's centre) like every builder; `recenter` and
 * `transformGeometry` move them.
 */
import { type Geometry, type GeometryOptions, mergeGeometry, transformGeometry } from './geometry';
import { recenter } from './ops';
import { box } from './primitives';
import { extrude } from './sweep';

export interface StairsOptions extends GeometryOptions {
  /** Number of steps (≥ 1). Default 4. */
  steps?: number;
  /** Extent along x. Default 1. */
  width?: number;
  /** Height of each step. Default 0.25. */
  rise?: number;
  /** Depth of each step along z. Default 0.3. */
  run?: number;
  /** Close the two sides (the solid's x faces). Default true; `false` leaves them open. */
  sides?: boolean;
}

/** Profile x → world +z, profile y → y, extrusion z → world -x (a rotation about y, det +1). */
// biome-ignore format: matrix
const PROFILE_TO_Z = [
  0, 0, -1, 0,
  0, 1,  0, 0,
  1, 0,  0, 0,
];

/**
 * A solid flight of stairs climbing along +z: `steps` steps of `rise` by `run`, `width` wide,
 * flat normals, the underside and back closed (a block with a sawtooth top). The sides are the
 * extrusion's caps, so `sides: false` leaves them open. Centred on the origin.
 */
export function stairs(opts: StairsOptions = {}): Geometry {
  const steps = Math.floor(opts.steps ?? 4);
  if (!(steps >= 1)) throw new Error(`geom: stairs steps must be at least 1, got ${steps}`);
  const width = opts.width ?? 1;
  const rise = opts.rise ?? 0.25;
  const run = opts.run ?? 0.3;
  // Counter-clockwise in (run, height): along the bottom, up the back, then down the steps.
  const profile: number[] = [0, 0, steps * run, 0, steps * run, steps * rise];
  for (let k = steps; k >= 1; k--) {
    profile.push((k - 1) * run, k * rise);
    if (k > 1) profile.push((k - 1) * run, (k - 1) * rise);
  }
  const g = extrude(profile, {
    depth: width,
    caps: opts.sides ?? true,
    color: opts.color,
    uvScale: opts.uvScale,
  });
  return recenter(transformGeometry(g, PROFILE_TO_Z));
}

export interface ArchOptions extends GeometryOptions {
  /** Outer extent along x. Default 1. */
  width?: number;
  /** Outer extent along y, at least `thickness + width / 2`. Default 1. */
  height?: number;
  /** Extent along z. Default 0.25. */
  depth?: number;
  /** Wall thickness around the opening (less than `width / 2`). Default 0.15. */
  thickness?: number;
  /** Straight segments in the semicircle (≥ 2). Default 16. */
  segments?: number;
}

/**
 * A rectangular wall of `width` × `height` × `depth` pierced by a round-topped opening:
 * two legs (`box`) under a lintel whose underside is a semicircle of radius
 * `width / 2 - thickness` (an `extrude` of the lintel's outline). Flat normals; a height of
 * exactly `thickness + width / 2` has no legs. Centred on the origin.
 */
export function arch(opts: ArchOptions = {}): Geometry {
  const width = opts.width ?? 1;
  const height = opts.height ?? 1;
  const depth = opts.depth ?? 0.25;
  const thickness = opts.thickness ?? 0.15;
  const segments = Math.floor(opts.segments ?? 16);
  if (!(segments >= 2)) throw new Error(`geom: arch segments must be at least 2, got ${segments}`);
  const ri = width / 2 - thickness;
  if (!(ri > 0)) throw new Error(`geom: arch thickness ${thickness} must be under width / 2`);
  const spring = height - thickness - ri;
  if (spring < -1e-9) {
    throw new Error(`geom: arch height ${height} must be at least thickness + width / 2`);
  }
  const hw = width / 2;
  // Lintel outline, counter-clockwise in (x, y): across the top, down the outside, in along the
  // springing line, over the inner semicircle, out to the far leg, back up.
  const outline: number[] = [-hw, height, -hw, spring, -ri, spring];
  for (let k = 1; k < segments; k++) {
    const a = Math.PI - (k / segments) * Math.PI;
    outline.push(ri * Math.cos(a), spring + ri * Math.sin(a));
  }
  outline.push(ri, spring, hw, spring, hw, height);
  const common = { color: opts.color, uvScale: opts.uvScale };
  const lintel = extrude(outline, { depth, ...common });
  if (spring <= 1e-9) return recenter(lintel);
  const leg = (x: number) => {
    const g = box({ size: [thickness, spring, depth], ...common });
    // biome-ignore format: matrix
    return transformGeometry(g, [
      1, 0, 0, x,
      0, 1, 0, spring / 2,
      0, 0, 1, 0,
    ]);
  };
  return recenter(mergeGeometry(lintel, leg(-hw + thickness / 2), leg(hw - thickness / 2)));
}
