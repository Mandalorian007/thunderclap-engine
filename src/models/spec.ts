import type { Geometry } from '../geom/geometry';

/** A point or offset in model space: `[x, y, z]`. */
export type PartVec3 = readonly [number, number, number];
/** A linear RGB colour, 0..1 per channel (HDR allowed for emissive). */
export type PartRgb = readonly [number, number, number];
/** A model-space axis. */
export type PartAxis = 'x' | 'y' | 'z';

/**
 * One shape of a part, in model space. Every shape takes its material from its part; a shape
 * with a `cap` paints its end faces with that material instead. Lengths are full lengths along
 * `axis` (a cylinder of `length` 1 reaches 0.5 each side of `center`).
 */
export type PartShape =
  | { type: 'box'; from: PartVec3; to: PartVec3 }
  | {
      type: 'cylinder';
      center: PartVec3;
      axis: PartAxis;
      radius: number;
      length: number;
      /** Sides around (default 12); more than 6 is shaded smooth. */
      sides?: number;
      cap?: string;
    }
  | {
      /** A toothed wheel: `teeth` teeth between `root` and `outer` radius. */
      type: 'gear';
      center: PartVec3;
      axis: PartAxis;
      outer: number;
      root: number;
      teeth: number;
      length: number;
    }
  | {
      /** An annulus (a wheel's rim) between `inner` and `outer`. */
      type: 'ring';
      center: PartVec3;
      axis: PartAxis;
      inner: number;
      outer: number;
      length: number;
      /** Segments around (default 16). */
      sides?: number;
    }
  | {
      /** An extruded star-shaped outline: one radius per evenly spaced angle. */
      type: 'prism';
      center: PartVec3;
      axis: PartAxis;
      radii: readonly number[];
      length: number;
      cap?: string;
    }
  | {
      /** A square frustum along +y from `center` (its bottom's centre); open at the top. */
      type: 'frustum';
      center: PartVec3;
      bottom: number;
      top: number;
      height: number;
    }
  | {
      /** A gable in the box `from`..`to`: two slopes up to a ridge along z over the middle of x. */
      type: 'wedge';
      from: PartVec3;
      to: PartVec3;
      cap?: string;
    }
  | {
      /**
       * Any `geom` builder's output (`VERTEX_LAYOUT_3D`: position, normal, uv, rgba), taken
       * with its own normals; its uv and vertex colour are dropped (the part's material and
       * `color` paint it).
       */
      type: 'geometry';
      geometry: Geometry;
    };

/** A fixed rotation by `angle` radians about `axis` through `pivot` (default the origin). */
export interface PartTurn {
  axis: PartAxis;
  angle: number;
  pivot?: PartVec3;
}

/**
 * Copies of a part: copy `k` (0..count-1) is moved by `k × offset`, then turned by `k × turn`
 * (a wheel's spokes, a fence's posts). Copy 0 is the part itself.
 */
export interface PartRepeat {
  count: number;
  offset?: PartVec3;
  turn?: PartTurn;
}

/**
 * How a top-level part moves with its instance's state. `channel` names one of the model's
 * `channels`; its value `v` at the moment drawn (the placed value carried on by its rate) sets
 * the motion, evaluated in the shader:
 *
 * - `spin`: angle `v × ratio` about `axis` through `pivot` (a wheel; the rate is its speed);
 * - `swing`: angle `amplitude × sin(v + phase)` (a leg, a pendulum; the rate is its pace);
 * - `hinge`: angle `from + (to − from) × clamp(v, 0, 1)` (a door, a lid, a shutter);
 * - `slide`: moved `from + (to − from) × clamp(v, 0, 1)` along `axis` (a piston, a drawer);
 * - `bob`: moved `amplitude × sin(v + phase)` along `axis` (a float, a hammer's stroke).
 *
 * Angles are radians; `pivot` defaults to the origin; `ratio` to 1, `phase` to 0.
 */
export type PartMotion =
  | { type: 'spin'; axis: PartAxis; pivot?: PartVec3; channel: string; ratio?: number }
  | {
      type: 'swing';
      axis: PartAxis;
      pivot?: PartVec3;
      channel: string;
      amplitude: number;
      phase?: number;
    }
  | {
      type: 'hinge';
      axis: PartAxis;
      pivot?: PartVec3;
      channel: string;
      from: number;
      to: number;
    }
  | { type: 'slide'; axis: PartAxis; channel: string; from: number; to: number }
  | { type: 'bob'; axis: PartAxis; channel: string; amplitude: number; phase?: number };

/**
 * How brightly a top-level part's emissive shows: a constant, or `clamp(v × scale, min, max)`
 * of a channel's value (defaults: scale 1, min 0, max 1).
 */
export type PartGlow = number | { channel: string; scale?: number; min?: number; max?: number };

/**
 * A part's colour over its material's: an RGB of its own, or the instance's colour
 * (`'instance'`) or second colour (`'instance2'`) as placed. The material's pattern stays.
 */
export type PartColor = PartRgb | 'instance' | 'instance2';

/**
 * One node of a part tree. A part draws its `shape` (if any) and its children `parts`, all
 * turned by `turn`, moved by `move`, and copied by `repeat` (applied outermost first: turn,
 * then each copy's move and turn, then `move`). `material`, `color` and `shade` pass down to
 * children that do not set their own.
 *
 * `motion` and `glow` are read on top-level parts only: such a part is its own draw unit
 * (with everything under it), placed and moved on its own; every other top-level part is
 * baked into the model's one static unit.
 */
export interface Part {
  /** Names the unit (`<model>/<name>`); default its index among the top-level parts. */
  name?: string;
  shape?: PartShape;
  /** A name in the material table. Default: the parent's, else the table's first. */
  material?: string;
  color?: PartColor;
  /** Brightness multiplier baked into the vertices (default 1). */
  shade?: number;
  turn?: PartTurn;
  move?: PartVec3;
  repeat?: PartRepeat;
  parts?: readonly Part[];
  motion?: PartMotion;
  glow?: PartGlow;
}

/**
 * A named state channel. `wrap`, when set, wraps the value into `[0, wrap)` before use (an
 * angle's 2π), so a value carried on by its rate keeps its precision for as long as it runs.
 */
export interface ModelChannel {
  name: string;
  wrap?: number;
}

/** Most state channels a model declares. */
export const MAX_MODEL_CHANNELS = 4;

/**
 * A procedural part model: a tree of shapes, data only. Model space is the game's (a unit
 * cell, metres); the instance's matrix places it.
 */
export interface PartModel {
  name: string;
  /** The state channels its motions and glows read (at most `MAX_MODEL_CHANNELS`). */
  channels?: readonly (string | ModelChannel)[];
  parts: readonly Part[];
}

/**
 * One material of a game's code table: a base colour and, for glowing parts, an emissive
 * colour (default the base colour) scaled by the part's glow.
 */
export interface ModelMaterial {
  color: PartRgb;
  emissive?: PartRgb;
}

/**
 * The game's material code table: names in declaration order. A material's code is its index
 * (`materialCode`); a custom shade function switches on those codes (`MODEL_MAT_<NAME>`
 * constants are generated). No material is built in.
 */
export type MaterialCodeTable = Readonly<Record<string, ModelMaterial>>;
