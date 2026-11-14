import { type AxisIndex, COLOR_MODE, MODEL_VERTEX_FLOATS, ModelBuilder, type V3 } from './builder';
import {
  MAX_MODEL_CHANNELS,
  type MaterialCodeTable,
  type ModelChannel,
  type Part,
  type PartAxis,
  type PartGlow,
  type PartModel,
  type PartMotion,
  type PartShape,
  type PartVec3,
} from './spec';

/** Floats per unit row in the GPU unit table (`ModelUnit.row`). */
export const MODEL_UNIT_FLOATS = 16;

/** Motion kinds as the unit table and the shader number them. */
export const MOTION_KIND = { NONE: 0, SPIN: 1, SWING: 2, HINGE: 3, SLIDE: 4, BOB: 5 } as const;

/**
 * One draw unit of a compiled model: a top-level part that moves or glows (with everything
 * under it), or the model's static parts baked together. Placed into a scene slot on its own.
 */
export interface ModelUnit {
  /** `<model>/<part name or index>`, or `<model>/static`. */
  readonly name: string;
  /** The compiled model it belongs to. */
  readonly owner: ModelUnits;
  /** Its vertices in the model's `verts`: first vertex and count (a multiple of 3). */
  readonly first: number;
  readonly count: number;
  /** Its motion as declared, or null. */
  readonly motion: PartMotion | null;
  /** Its glow as declared, or null (no emissive). */
  readonly glow: PartGlow | null;
  /**
   * Radius about the model origin that holds the unit at any state (a turning part's reach
   * about its pivot, a sliding one's travel). For culling.
   */
  readonly radius: number;
  /** Its `MODEL_UNIT_FLOATS` row of the GPU unit table (motion, glow, channel wraps). */
  readonly row: Float32Array<ArrayBuffer>;
}

/** A compiled part model: its units and their vertices, packed. */
export interface ModelUnits {
  readonly name: string;
  /** The channels its state carries, in index order. */
  readonly channels: readonly ModelChannel[];
  /** The static unit first (if any), then one per moving or glowing top-level part, in order. */
  readonly units: readonly ModelUnit[];
  /** Every unit's vertices, `MODEL_VERTEX_FLOATS` each. */
  readonly verts: Float32Array<ArrayBuffer>;
  /** The largest unit radius. */
  readonly radius: number;
  /** The table the material codes index. */
  readonly materials: MaterialCodeTable;
}

const EMPTY = new Float32Array(0);
const AXIS: Record<PartAxis, AxisIndex> = { x: 0, y: 1, z: 2 };
const ORIGIN: PartVec3 = [0, 0, 0];

const v3 = (v: PartVec3): V3 => [v[0], v[1], v[2]];

/** The code of material `name` in `table` (its index in declaration order); -1 if absent. */
export function materialCode(table: MaterialCodeTable, name: string): number {
  return Object.keys(table).indexOf(name);
}

/**
 * The WGSL name of a material code constant: `MODEL_MAT_` and the name upper-cased, every
 * run of other characters an underscore (`'dark wood'` → `MODEL_MAT_DARK_WOOD`).
 */
export function materialConstName(name: string): string {
  return `MODEL_MAT_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function channelsOf(spec: PartModel): ModelChannel[] {
  const out: ModelChannel[] = [];
  for (const c of spec.channels ?? []) {
    const ch = typeof c === 'string' ? { name: c } : c;
    if (out.some((o) => o.name === ch.name)) {
      throw new Error(`model ${spec.name}: channel '${ch.name}' declared twice`);
    }
    out.push(ch.wrap !== undefined ? { name: ch.name, wrap: ch.wrap } : { name: ch.name });
  }
  if (out.length > MAX_MODEL_CHANNELS) {
    throw new Error(`model ${spec.name}: ${out.length} channels (at most ${MAX_MODEL_CHANNELS})`);
  }
  return out;
}

interface Ctx {
  spec: PartModel;
  materials: MaterialCodeTable;
  codes: Map<string, number>;
}

function code(ctx: Ctx, name: string, where: string): number {
  const c = ctx.codes.get(name);
  if (c === undefined) {
    throw new Error(`model ${ctx.spec.name}: ${where}: unknown material '${name}'`);
  }
  return c;
}

function drawShape(
  b: ModelBuilder,
  ctx: Ctx,
  s: PartShape,
  mat: number,
  shade: number,
  where: string,
): void {
  const cap = (m: string | undefined): number | undefined =>
    m === undefined ? undefined : code(ctx, m, where);
  switch (s.type) {
    case 'box':
      b.box(v3(s.from), v3(s.to), mat, shade);
      break;
    case 'cylinder':
      b.cylinder(
        v3(s.center),
        AXIS[s.axis],
        s.radius,
        s.length / 2,
        s.sides ?? 12,
        mat,
        cap(s.cap),
        shade,
      );
      break;
    case 'gear':
      b.gear(v3(s.center), AXIS[s.axis], s.outer, s.root, s.teeth, s.length / 2, mat, shade);
      break;
    case 'ring':
      b.ring(v3(s.center), AXIS[s.axis], s.inner, s.outer, s.length / 2, s.sides ?? 16, mat, shade);
      break;
    case 'prism': {
      const c = cap(s.cap);
      b.extrude(v3(s.center), AXIS[s.axis], s.radii, s.length / 2, mat, {
        shade,
        ...(c !== undefined ? { capMat: c } : {}),
      });
      break;
    }
    case 'frustum': {
      const [cx, y0, cz] = s.center;
      b.frustum(cx, cz, y0, s.bottom, y0 + s.height, s.top, mat, shade);
      break;
    }
    case 'wedge':
      b.wedge(v3(s.from), v3(s.to), mat, cap(s.cap) ?? mat, shade);
      break;
    case 'geometry': {
      const g = s.geometry;
      b.mesh(g.vertices, g.indices, g.layout.floats, mat, shade);
      break;
    }
  }
}

interface Inherit {
  mat: number;
  color: [number, number, number, number];
  shade: number;
}

/** Draws `p` and everything under it: its turn, then its copies (each moved then turned), then its move. */
function drawPart(
  b: ModelBuilder,
  ctx: Ctx,
  p: Part,
  up: Inherit,
  where: string,
  top: boolean,
): void {
  if (!top && (p.motion || p.glow !== undefined)) {
    throw new Error(
      `model ${ctx.spec.name}: ${where}: motion and glow are for top-level parts only`,
    );
  }
  const mat = p.material !== undefined ? code(ctx, p.material, where) : up.mat;
  let color = up.color;
  if (p.color !== undefined) {
    if (p.color === 'instance') color = [0, 0, 0, COLOR_MODE.INSTANCE];
    else if (p.color === 'instance2') color = [0, 0, 0, COLOR_MODE.INSTANCE2];
    else color = [p.color[0], p.color[1], p.color[2], COLOR_MODE.RGB];
  }
  const shade = p.shade ?? up.shade;
  const own: Inherit = { mat, color, shade };
  const body = (): void => {
    if (p.shape) {
      b.color = color;
      drawShape(b, ctx, p.shape, mat, shade, where);
    }
    const kids = p.parts ?? [];
    for (let i = 0; i < kids.length; i++)
      drawPart(b, ctx, kids[i]!, own, `${where}/${kids[i]!.name ?? i}`, false);
  };
  const placed = (): void => (p.move ? b.moved(v3(p.move), body) : body());
  const copies = (): void => {
    const r = p.repeat;
    if (!r || r.count <= 1) {
      placed();
      return;
    }
    const off = r.offset ?? ORIGIN;
    for (let k = 0; k < r.count; k++) {
      const moved = (): void =>
        k === 0 ? placed() : b.moved([off[0] * k, off[1] * k, off[2] * k], placed);
      const t = r.turn;
      if (t && k > 0) b.rotated(AXIS[t.axis], t.angle * k, v3(t.pivot ?? ORIGIN), moved);
      else moved();
    }
  };
  const t = p.turn;
  if (t) b.rotated(AXIS[t.axis], t.angle, v3(t.pivot ?? ORIGIN), copies);
  else copies();
}

function channelIndex(
  ctx: Ctx,
  channels: readonly ModelChannel[],
  name: string,
  where: string,
): number {
  const i = channels.findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`model ${ctx.spec.name}: ${where}: unknown channel '${name}'`);
  return i;
}

/** The unit table row of a unit: motion, glow and the model's channel wraps. */
function unitRow(
  ctx: Ctx,
  channels: readonly ModelChannel[],
  p: Part | null,
  where: string,
): Float32Array<ArrayBuffer> {
  const row = new Float32Array(MODEL_UNIT_FLOATS);
  row[3] = -1; // no glow channel
  const m = p?.motion;
  if (m) {
    row[1] = AXIS[m.axis];
    row[2] = channelIndex(ctx, channels, m.channel, where);
    const pivot = 'pivot' in m && m.pivot ? m.pivot : ORIGIN;
    row[4] = pivot[0];
    row[5] = pivot[1];
    row[6] = pivot[2];
    switch (m.type) {
      case 'spin':
        row[0] = MOTION_KIND.SPIN;
        row[7] = m.ratio ?? 1;
        break;
      case 'swing':
        row[0] = MOTION_KIND.SWING;
        row[7] = m.amplitude;
        row[8] = m.phase ?? 0;
        break;
      case 'hinge':
        row[0] = MOTION_KIND.HINGE;
        row[7] = m.from;
        row[8] = m.to;
        break;
      case 'slide':
        row[0] = MOTION_KIND.SLIDE;
        row[7] = m.from;
        row[8] = m.to;
        break;
      case 'bob':
        row[0] = MOTION_KIND.BOB;
        row[7] = m.amplitude;
        row[8] = m.phase ?? 0;
        break;
    }
  }
  const g = p?.glow;
  if (typeof g === 'number') {
    row[10] = g;
    row[11] = g;
  } else if (g) {
    row[3] = channelIndex(ctx, channels, g.channel, where);
    row[9] = g.scale ?? 1;
    row[10] = g.min ?? 0;
    row[11] = g.max ?? 1;
  }
  for (let c = 0; c < channels.length; c++) row[12 + c] = channels[c]!.wrap ?? 0;
  return row;
}

/** How far a unit's motion can carry a vertex at distance `r` from the origin. */
function reach(r: number, m: PartMotion | null): number {
  if (!m) return r;
  if (m.type === 'slide') return r + Math.max(Math.abs(m.from), Math.abs(m.to));
  if (m.type === 'bob') return r + Math.abs(m.amplitude);
  const p = m.pivot ?? ORIGIN;
  // |R(v - p) + p| <= |v| + 2|p|
  return r + 2 * Math.hypot(p[0], p[1], p[2]);
}

function farthest(v: Float32Array): number {
  let r = 0;
  for (let i = 0; i < v.length; i += MODEL_VERTEX_FLOATS)
    r = Math.max(r, Math.hypot(v[i]!, v[i + 1]!, v[i + 2]!));
  return r;
}

/** Whether a top-level part is its own unit: it moves or glows. */
function bound(p: Part): boolean {
  return !!p.motion || p.glow !== undefined;
}

/**
 * Compile a part model against the game's material table into draw units: the top-level
 * parts that move or glow each become a unit, the rest bake into one static unit, and every
 * unit's vertices pack into one array (`MODEL_VERTEX_FLOATS` each). Pure: the same spec and
 * table give the same arrays. Throws on an unknown material or channel, on motion or glow
 * below the top level, and on more than `MAX_MODEL_CHANNELS` channels.
 */
export function compileModel(spec: PartModel, materials: MaterialCodeTable): ModelUnits {
  const names = Object.keys(materials);
  if (names.length === 0) throw new Error(`model ${spec.name}: the material table is empty`);
  const ctx: Ctx = { spec, materials, codes: new Map(names.map((n, i) => [n, i])) };
  const channels = channelsOf(spec);
  const root: Inherit = { mat: 0, color: [0, 0, 0, COLOR_MODE.MATERIAL], shade: 1 };
  const units: ModelUnit[] = [];
  // The units point back at the result, filled in once it is whole.
  const out = { name: spec.name, channels, units, verts: EMPTY, radius: 0, materials } as {
    -readonly [K in keyof ModelUnits]: ModelUnits[K];
  };
  const chunks: Float32Array[] = [];
  let first = 0;
  const b = new ModelBuilder();
  const push = (name: string, p: Part | null, verts: Float32Array): void => {
    const count = verts.length / MODEL_VERTEX_FLOATS;
    const where = name;
    units.push({
      name: `${spec.name}/${name}`,
      owner: out,
      first,
      count,
      motion: p?.motion ?? null,
      glow: p?.glow ?? null,
      radius: reach(farthest(verts), p?.motion ?? null),
      row: unitRow(ctx, channels, p, where),
    });
    chunks.push(verts);
    first += count;
  };
  const parts = spec.parts;
  let still = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (bound(p)) continue;
    still = true;
    drawPart(b, ctx, p, root, `${p.name ?? i}`, true);
  }
  if (still) push('static', null, b.done());
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!bound(p)) continue;
    const name = p.name ?? String(i);
    drawPart(b, ctx, p, root, name, true);
    push(name, p, b.done());
  }
  const verts = new Float32Array(first * MODEL_VERTEX_FLOATS);
  let o = 0;
  for (const c of chunks) {
    verts.set(c, o);
    o += c.length;
  }
  let radius = 0;
  for (const u of units) radius = Math.max(radius, u.radius);
  out.verts = verts;
  out.radius = radius;
  return out;
}

/** The index of channel `name` in a compiled model, or -1. */
export function channelOf(model: ModelUnits, name: string): number {
  return model.channels.findIndex((c) => c.name === name);
}

/** A unit's pose at given channel values: its angle (radians, about its axis through its pivot), its offset along its axis and its glow. */
export interface UnitPose {
  angle: number;
  offset: number;
  glow: number;
}

/**
 * Where a unit stands for channel `values` (index order; missing ones 0), as the shader puts
 * it: the CPU twin of `model_unit_pose` in the model WGSL, for picking, tests and tools.
 */
export function evaluateUnit(
  unit: ModelUnit,
  values: ArrayLike<number>,
  out: UnitPose = { angle: 0, offset: 0, glow: 0 },
): UnitPose {
  const r = unit.row;
  const value = (c: number): number => {
    let v = values[c] ?? 0;
    const w = r[12 + c]!;
    if (w > 0) v -= Math.floor(v / w) * w;
    return v;
  };
  out.angle = 0;
  out.offset = 0;
  const kind = r[0]!;
  if (kind !== MOTION_KIND.NONE) {
    const v = value(r[2]!);
    const p0 = r[7]!;
    const p1 = r[8]!;
    const t = Math.min(1, Math.max(0, v));
    if (kind === MOTION_KIND.SPIN) out.angle = v * p0;
    else if (kind === MOTION_KIND.SWING) out.angle = p0 * Math.sin(v + p1);
    else if (kind === MOTION_KIND.HINGE) out.angle = p0 + (p1 - p0) * t;
    else if (kind === MOTION_KIND.SLIDE) out.offset = p0 + (p1 - p0) * t;
    else if (kind === MOTION_KIND.BOB) out.offset = p0 * Math.sin(v + p1);
  }
  const gc = r[3]!;
  out.glow = gc < 0 ? r[10]! : Math.min(r[11]!, Math.max(r[10]!, value(gc) * r[9]!));
  return out;
}
