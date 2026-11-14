/**
 * The actor shaders: the pose pass (compute: one workgroup per slot, one thread per node) and
 * the draw (vertex skinning from the bone buffer through the per-view visible lists).
 */
import { CORE_VIEW_WGSL, MAX_VIEWS } from '../render/core/view';
import { ACTOR_RECORD as R } from './record';

/** Words per model in the rig table's header area. */
export const RIG_HEADER_WORDS = 20;
/** Word offsets in a model's header. */
export const RIG = {
  nodes: 0,
  joints: 1,
  drawBase: 2,
  meshes: 3,
  radius: 4,
  cx: 5,
  cy: 6,
  cz: 7,
  clips: 8,
  clipsAt: 9,
  parentsAt: 10,
  jointNodesAt: 11,
  inverseBindAt: 12,
  restAt: 13,
  /** The model's own LOD distance count (0: the system's), then four distances at 16. */
  lodCount: 14,
  lods: 16,
} as const;
/** Words per clip entry: frames at, frame count, fps (f32), loop. */
export const RIG_CLIP_WORDS = 4;
/** Bytes of the pose pass's parameters. */
export const ACTOR_PARAMS_BYTES = 48;
/** Most LOD distances. */
export const ACTOR_MAX_LODS = 4;

/** The fixed sizes the shaders are generated with. */
export interface ActorShaderConsts {
  bones: number;
  stride: number;
  maxDraws: number;
  slots: number;
  views: number;
  /** Words per (view, model mesh) argument cell: 5, and 4 more per per-actor vertex count. */
  argsWords: number;
  /** The `'actor'` sets' vertex counts per visible actor (empty: none). */
  actorVertices: readonly number[];
  /** Word of `args` where the per-view vertex counters start (the vertex cap's). */
  counters: number;
  /** A game table is bound (`ActorSystemOptions.table`). */
  table: boolean;
  /** `ActorSystemOptions.poseWgsl`, or empty. */
  pose: string;
  /** The record fields' `ACTOR_FIELD_*` constants (for the pose hook). */
  fieldConsts: string;
}

function consts(c: ActorShaderConsts): string {
  return `
const ACTOR_BONES = ${c.bones}u;
const ACTOR_STRIDE = ${c.stride}u;
const ACTOR_MAX_DRAWS = ${c.maxDraws}u;
const ACTOR_LIST = ${c.slots}u;
const ACTOR_VIEWS = ${c.views}u;
const ACTOR_NONE = 0xffffffffu;`;
}

/** The pose pass: place, pose, skin, cull per view, pick the LOD and append to the lists. */
export function actorPoseWgsl(c: ActorShaderConsts): string {
  return /* wgsl */ `${CORE_VIEW_WGSL}
${consts(c)}
struct ActorParams {
  time: f32,
  high: u32,
  views: u32,
  models: u32,
  lods: vec4f,
  lodCount: u32,
  lodScale: f32,
  vertexCap: u32,
  _c: u32,
};
@group(0) @binding(0) var<uniform> views: array<CoreView, ${MAX_VIEWS}>;
@group(0) @binding(1) var<uniform> params: ActorParams;
@group(0) @binding(2) var<storage, read> records: array<u32>;
@group(0) @binding(3) var<storage, read> rig: array<u32>;
@group(0) @binding(4) var<storage, read_write> bones: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> lists: array<u32>;
${
  c.table
    ? `@group(0) @binding(7) var<storage, read> actor_table: array<u32>;
/** Word \`i\` of the game's table (\`ActorSystemOptions.table\`). */
fn actor_table_word(i: u32) -> u32 { return actor_table[i]; }
fn actor_table_f32(i: u32) -> f32 { return bitcast<f32>(actor_table[i]); }
`
    : ''
}
var<workgroup> wm: array<vec4f, ${c.bones * 3}>;

struct Trs { t: vec3f, q: vec4f, s: vec3f };
struct M34 { r0: vec4f, r1: vec4f, r2: vec4f };

fn rf(i: u32) -> f32 { return bitcast<f32>(rig[i]); }
fn recf(i: u32) -> f32 { return bitcast<f32>(records[i]); }

fn readTrs(at: u32) -> Trs {
  return Trs(vec3f(rf(at), rf(at + 1u), rf(at + 2u)),
    vec4f(rf(at + 3u), rf(at + 4u), rf(at + 5u), rf(at + 6u)),
    vec3f(rf(at + 7u), rf(at + 8u), rf(at + 9u)));
}

fn mixTrs(a: Trs, b: Trs, w: f32) -> Trs {
  let wb = select(w, -w, dot(a.q, b.q) < 0.0);
  let q = a.q * (1.0 - w) + b.q * wb;
  let len = length(q);
  return Trs(a.t * (1.0 - w) + b.t * w, select(vec4f(0.0), q / len, len > 0.0),
    a.s * (1.0 - w) + b.s * w);
}

fn sampleLayer(hdr: u32, clip: u32, phase: f32, node: u32, nodes: u32) -> Trs {
  let ce = rig[hdr + ${RIG.clipsAt}u] + clip * ${RIG_CLIP_WORDS}u;
  let at = rig[ce];
  let n = rig[ce + 1u];
  let nf = f32(n);
  var f = phase * rf(ce + 2u);
  var i0: u32;
  var i1: u32;
  if (rig[ce + 3u] != 0u) {
    f = f - floor(f / nf) * nf;
    i0 = min(u32(floor(f)), n - 1u);
    i1 = select(i0 + 1u, 0u, i0 + 1u >= n);
  } else {
    f = clamp(f, 0.0, nf - 1.0);
    i0 = min(u32(floor(f)), n - 1u);
    i1 = min(i0 + 1u, n - 1u);
  }
  let a = f - f32(i0);
  return mixTrs(readTrs(at + (i0 * nodes + node) * 10u), readTrs(at + (i1 * nodes + node) * 10u), a);
}

fn trsMatrix(p: Trs) -> M34 {
  let x = p.q.x; let y = p.q.y; let z = p.q.z; let w = p.q.w;
  return M34(
    vec4f((1.0 - 2.0 * (y * y + z * z)) * p.s.x, 2.0 * (x * y - w * z) * p.s.y, 2.0 * (x * z + w * y) * p.s.z, p.t.x),
    vec4f(2.0 * (x * y + w * z) * p.s.x, (1.0 - 2.0 * (x * x + z * z)) * p.s.y, 2.0 * (y * z - w * x) * p.s.z, p.t.y),
    vec4f(2.0 * (x * z - w * y) * p.s.x, 2.0 * (y * z + w * x) * p.s.y, (1.0 - 2.0 * (x * x + y * y)) * p.s.z, p.t.z));
}

fn mulRow(a: vec4f, b: M34) -> vec4f {
  return a.x * b.r0 + a.y * b.r1 + a.z * b.r2 + vec4f(0.0, 0.0, 0.0, a.w);
}
fn mul(a: M34, b: M34) -> M34 { return M34(mulRow(a.r0, b), mulRow(a.r1, b), mulRow(a.r2, b)); }
fn wmAt(i: u32) -> M34 { return M34(wm[i * 3u], wm[i * 3u + 1u], wm[i * 3u + 2u]); }
fn wmSet(i: u32, m: M34) { wm[i * 3u] = m.r0; wm[i * 3u + 1u] = m.r1; wm[i * 3u + 2u] = m.r2; }

${
  c.pose
    ? `${c.fieldConsts}
/** Word \`word\` of actor \`actor\`'s record. */
fn actor_word(actor: u32, word: u32) -> u32 { return records[actor * ACTOR_STRIDE + word]; }
${c.pose}`
    : ''
}
@compute @workgroup_size(${c.bones})
fn pose(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) b: u32) {
  let s = wg.x;
  let r = s * ACTOR_STRIDE;
  let model = records[r + ${R.model}u];
  let live = model < params.models;
  let hdr = select(0u, model, live) * ${RIG_HEADER_WORDS}u;
  let nodes = select(0u, rig[hdr + ${RIG.nodes}u], live);
  let joints = select(0u, rig[hdr + ${RIG.joints}u], live);
  let clips = rig[hdr + ${RIG.clips}u];
  if (b < nodes) {
    var p = readTrs(rig[hdr + ${RIG.restAt}u] + b * 10u);
    let c0 = records[r + ${R.clip}u];
    if (c0 < clips) {
      p = sampleLayer(hdr, c0, (params.time - recf(r + ${R.clipStart}u)) * recf(r + ${R.clipRate}u), b, nodes);
    }
    let c1 = records[r + ${R.clip2}u];
    let w = min(recf(r + ${R.blend}u), 1.0);
    if (c1 < clips && w > 0.0) {
      let p1 = sampleLayer(hdr, c1, (params.time - recf(r + ${R.clip2Start}u)) * recf(r + ${R.clip2Rate}u), b, nodes);
      p = mixTrs(p, p1, w);
    }${c.pose ? '\n    p = actor_pose(s, model, b, p, params.time);' : ''}
    wmSet(b, trsMatrix(p));
  }
  workgroupBarrier();
  if (b == 0u && live) {
    let dt = params.time - recf(r + ${R.since}u);
    let yaw = recf(r + ${R.yaw}u);
    let k = recf(r + ${R.scale}u);
    let cs = cos(yaw);
    let sn = sin(yaw);
    let pos = vec3f(recf(r + ${R.x}u), recf(r + ${R.y}u), recf(r + ${R.z}u))
      + vec3f(recf(r + ${R.vx}u), recf(r + ${R.vy}u), recf(r + ${R.vz}u)) * dt;
    let actor = M34(vec4f(cs * k, 0.0, sn * k, pos.x), vec4f(0.0, k, 0.0, pos.y),
      vec4f(-sn * k, 0.0, cs * k, pos.z));
    let parentsAt = rig[hdr + ${RIG.parentsAt}u];
    for (var i = 0u; i < nodes; i++) {
      let par = rig[parentsAt + i];
      if (par == ACTOR_NONE) {
        wmSet(i, mul(actor, wmAt(i)));
      } else {
        wmSet(i, mul(wmAt(par), wmAt(i)));
      }
    }
    // Cull per view and pick the LOD; the visible slot joins its draw's list.
    let c = vec4f(rf(hdr + ${RIG.cx}u), rf(hdr + ${RIG.cy}u), rf(hdr + ${RIG.cz}u), 1.0);
    let center = vec3f(dot(actor.r0, c), dot(actor.r1, c), dot(actor.r2, c));
    // The record's own cull radius (world units) when set, else the model's, scaled.
    let own = recf(r + ${R.cullRadius}u);
    let radius = select(rf(hdr + ${RIG.radius}u) * abs(k), own, own > 0.0);
    // The model's own LOD distances when it has them, else the system's.
    let ml = rig[hdr + ${RIG.lodCount}u];
    let lodCount = select(params.lodCount, ml, ml > 0u);
    let lods = select(params.lods, vec4f(rf(hdr + ${RIG.lods}u), rf(hdr + ${RIG.lods + 1}u),
      rf(hdr + ${RIG.lods + 2}u), rf(hdr + ${RIG.lods + 3}u)), ml > 0u);
    let meshes = rig[hdr + ${RIG.meshes}u];
    let drawBase = rig[hdr + ${RIG.drawBase}u];
    let nv = min(params.views, ACTOR_VIEWS);
    for (var v = 0u; v < nv; v++) {
      var inside = true;
      for (var pl = 0u; pl < 6u; pl++) {
        let plane = views[v].planes[pl];
        if (dot(plane.xyz, center) + plane.w < -radius) { inside = false; }
      }
      if (!inside) { continue; }
      let dist = distance(center, views[v].position.xyz);
      var lod = 0u;
      while (lod < lodCount && dist >= lods[lod] * params.lodScale) { lod++; }
      if (lod >= lodCount) { continue; }
      var d = drawBase + min(lod, meshes - 1u);
      if (params.vertexCap > 0u) {
        // Past the view's vertex cap, the coarsest mesh instead.
        let coarse = drawBase + meshes - 1u;
        let n = atomicLoad(&args[(v * ACTOR_MAX_DRAWS + d) * ${c.argsWords}u]);
        let used = atomicAdd(&args[${c.counters}u + v], n);
        if (d != coarse && used + n > params.vertexCap) {
          atomicSub(&args[${c.counters}u + v], n);
          d = coarse;
          atomicAdd(&args[${c.counters}u + v], atomicLoad(&args[(v * ACTOR_MAX_DRAWS + d) * ${c.argsWords}u]));
        }
      }
      let cell = v * ACTOR_MAX_DRAWS + d;
      let at = atomicAdd(&args[cell * ${c.argsWords}u + 1u], 1u);
      lists[cell * ACTOR_LIST + at] = s;${c.actorVertices.map((_, i) => `\n      atomicAdd(&args[cell * ${c.argsWords}u + ${6 + i * 4}u], 1u);`).join('')}
    }
  }
  workgroupBarrier();
  if (b < joints) {
    let node = rig[rig[hdr + ${RIG.jointNodesAt}u] + b];
    let ib = rig[hdr + ${RIG.inverseBindAt}u] + b * 12u;
    let bind = M34(vec4f(rf(ib), rf(ib + 1u), rf(ib + 2u), rf(ib + 3u)),
      vec4f(rf(ib + 4u), rf(ib + 5u), rf(ib + 6u), rf(ib + 7u)),
      vec4f(rf(ib + 8u), rf(ib + 9u), rf(ib + 10u), rf(ib + 11u)));
    let m = mul(wmAt(node), bind);
    let o = (s * ACTOR_BONES + b) * 3u;
    bones[o] = m.r0;
    bones[o + 1u] = m.r1;
    bones[o + 2u] = m.r2;
  }
}
`;
}

/**
 * An empty fragment entry for the actor sets' shadow pipelines (ws/actor-post-fit). Without a
 * `shadowFragmentEntry` the core's depth-only shadow pipeline binds the view group alone, and
 * an actor's vertex stage reads its records and bones at group 1: with one, the set's groups
 * stay bound (none of them holds the shadow map), so actors cast, and a warmed idle caster's
 * pipeline is valid.
 */
export const ACTOR_SHADOW_FS = 'actor_shadow_fs';
const ACTOR_SHADOW_FS_WGSL = `\n@fragment fn ${ACTOR_SHADOW_FS}() {}\n`;

/**
 * The default lighting: a fixed key light over an ambient floor, times the record's light word.
 * A game replaces it with `ActorSystemOptions.lightWgsl`, a function of the same signature.
 */
export const ACTOR_DEFAULT_LIGHT_WGSL = /* wgsl */ `
fn actor_light(actor: u32, world: vec3f, normal: vec3f, color: vec3f, light: u32) -> vec3f {
  let key = normalize(vec3f(0.4, 0.8, 0.3));
  return color * unpack4x8unorm(light).rgb * (0.45 + 0.55 * max(dot(normal, key), 0.0));
}
`;

/** The draw: the core prepends the view and `VertexIn`; this reads group 1. */
/** The `ACTOR_FIELD_<NAME>` constants of a record's game fields. */
export function actorFieldConsts(fields: ReadonlyMap<string, { word: number }>): string {
  let names = '';
  for (const [name, f] of fields)
    names += `const ACTOR_FIELD_${name.toUpperCase()} = ${f.word}u;\n`;
  return names;
}

export function actorDrawWgsl(
  c: ActorShaderConsts,
  light: string,
  fields: ReadonlyMap<string, { word: number }>,
): string {
  const names = actorFieldConsts(fields);
  return /* wgsl */ `${consts(c)}
${names}
@group(1) @binding(0) var<storage, read> bones: array<vec4f>;
@group(1) @binding(1) var<storage, read> lists: array<u32>;
@group(1) @binding(2) var<storage, read> records: array<u32>;

/** Word \`word\` of actor \`actor\`'s record (the header's, or a game field's \`ACTOR_FIELD_*\`). */
fn actor_word(actor: u32, word: u32) -> u32 { return records[actor * ACTOR_STRIDE + word]; }
${light}
struct ActorOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
  @location(1) normal: vec3f,
  @location(2) world: vec3f,
  @location(3) @interpolate(flat) light: u32,
  @location(4) @interpolate(flat) actor: u32,
};

@vertex fn vs(in: VertexIn, @builtin(instance_index) inst: u32) -> ActorOut {
  let actor = lists[(view.index * ACTOR_MAX_DRAWS + in.draw) * ACTOR_LIST + inst];
  var r0 = vec4f(0.0);
  var r1 = vec4f(0.0);
  var r2 = vec4f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let w = in.weights[k];
    if (w > 0.0) {
      let o = (actor * ACTOR_BONES + in.joints[k]) * 3u;
      r0 += bones[o] * w;
      r1 += bones[o + 1u] * w;
      r2 += bones[o + 2u] * w;
    }
  }
  let p = vec4f(in.position, 1.0);
  let world = vec3f(dot(r0, p), dot(r1, p), dot(r2, p));
  let n = in.normal.xyz;
  let wn = vec3f(dot(r0.xyz, n), dot(r1.xyz, n), dot(r2.xyz, n));
  let tint = unpack4x8unorm(actor_word(actor, ${R.tint}u)).rgb;
  var o: ActorOut;
  o.clip = view.viewProj * vec4f(world, 1.0);
  o.color = select(in.color.rgb, in.color.rgb * tint, in.color.a > 0.5);
  o.normal = select(vec3f(0.0, 1.0, 0.0), normalize(wn), dot(wn, wn) > 0.0);
  o.world = world;
  o.light = actor_word(actor, ${R.light}u);
  o.actor = actor;
  return o;
}

@fragment fn fs(in: ActorOut) -> @location(0) vec4f {
  return vec4f(actor_light(in.actor, in.world, normalize(in.normal), in.color, in.light), 1.0);
}
${ACTOR_SHADOW_FS_WGSL}`;
}

/**
 * What the core prepends to a set added with `ActorSystem.addDrawSet` (after the view and
 * `VertexIn`): the actor buffers at group 1 and helpers over them. The game's code follows with
 * its own entries.
 */
export function actorSetPreludeWgsl(
  c: ActorShaderConsts,
  light: string,
  fields: ReadonlyMap<string, { word: number }>,
  vertices = 1,
): string {
  return /* wgsl */ `${consts(c)}
${actorFieldConsts(fields)}
const ACTOR_SET_VERTICES = ${Math.max(1, vertices)}u;
struct ActorSetParams { time: f32, high: u32, views: u32, models: u32 };
@group(1) @binding(0) var<storage, read> bones: array<vec4f>;
@group(1) @binding(1) var<storage, read> lists: array<u32>;
@group(1) @binding(2) var<storage, read> records: array<u32>;
@group(1) @binding(3) var<uniform> actor_params: ActorSetParams;

/** Word \`word\` of actor \`actor\`'s record (the header's, or a game field's \`ACTOR_FIELD_*\`). */
fn actor_word(actor: u32, word: u32) -> u32 { return records[actor * ACTOR_STRIDE + word]; }
fn actor_f32(actor: u32, word: u32) -> f32 { return bitcast<f32>(actor_word(actor, word)); }
/** The actor drawn as instance \`inst\` of model mesh \`draw\` in this view. */
fn actor_at(draw: u32, inst: u32) -> u32 {
  return lists[(view.index * ACTOR_MAX_DRAWS + draw) * ACTOR_LIST + inst];
}
/** In an \`'actor'\` set: the model mesh of vertex \`v\` (\`core_vertex\`); \`v % ACTOR_SET_VERTICES\` is the corner. */
fn actor_draw_of(v: u32) -> u32 { return v / ACTOR_SET_VERTICES; }
/** Where the actor stands now (its position moved on by its velocity). */
fn actor_position(actor: u32) -> vec3f {
  let dt = actor_params.time - actor_f32(actor, ${R.since}u);
  return vec3f(actor_f32(actor, ${R.x}u), actor_f32(actor, ${R.y}u), actor_f32(actor, ${R.z}u))
    + vec3f(actor_f32(actor, ${R.vx}u), actor_f32(actor, ${R.vy}u), actor_f32(actor, ${R.vz}u)) * dt;
}
fn actor_yaw(actor: u32) -> f32 { return actor_f32(actor, ${R.yaw}u); }
fn actor_scale(actor: u32) -> f32 { return actor_f32(actor, ${R.scale}u); }
fn actor_model(actor: u32) -> u32 { return actor_word(actor, ${R.model}u); }
/** Joint \`joint\`'s skin matrix rows (world × inverse bind) for actor \`actor\`. */
struct ActorSkin { r0: vec4f, r1: vec4f, r2: vec4f };
fn actor_bone(actor: u32, joint: u32) -> ActorSkin {
  let o = (actor * ACTOR_BONES + joint) * 3u;
  return ActorSkin(bones[o], bones[o + 1u], bones[o + 2u]);
}
/** The skin of a vertex's four joints and weights. */
fn actor_skin(actor: u32, joints: vec4u, weights: vec4f) -> ActorSkin {
  var m = ActorSkin(vec4f(0.0), vec4f(0.0), vec4f(0.0));
  for (var k = 0u; k < 4u; k++) {
    let w = weights[k];
    if (w > 0.0) {
      let b = actor_bone(actor, joints[k]);
      m.r0 += b.r0 * w;
      m.r1 += b.r1 * w;
      m.r2 += b.r2 * w;
    }
  }
  return m;
}
fn actor_point(m: ActorSkin, p: vec3f) -> vec3f {
  let q = vec4f(p, 1.0);
  return vec3f(dot(m.r0, q), dot(m.r1, q), dot(m.r2, q));
}
fn actor_dir(m: ActorSkin, n: vec3f) -> vec3f {
  return vec3f(dot(m.r0.xyz, n), dot(m.r1.xyz, n), dot(m.r2.xyz, n));
}
${light}${ACTOR_SHADOW_FS_WGSL}`;
}
