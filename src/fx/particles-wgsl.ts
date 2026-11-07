import { WGSL_GLOBALS, WGSL_LIGHTS } from '../render/wgsl';

const COMMON = /* wgsl */ `
struct Particle {
  posVel: vec4f,  // pos.xy, vel.xy (logical px, px/s)
  c0: vec4f,      // colour at birth (linear, premultiplied by nothing)
  c1: vec4f,      // colour at death
  life: vec4f,    // age, lifetime, size at birth, size at death
  phys: vec4f,    // gravity.xy, drag, emissive
};
struct Sim {
  dt: f32,
  floorY: f32,
  bounce: f32,
  time: f32,
  capacity: f32,
  stretch: f32,
  spawnCount: f32,
  _pad: f32,
};
`;

export const PARTICLE_COMPUTE_WGSL = /* wgsl */ `
${COMMON}
struct Spawn {
  a: vec4f,   // x, y, shapeA, shapeB
  b: vec4f,   // angle, spread, speedMin, speedMax
  c: vec4f,   // lifeMin, lifeMax, sizeStart, sizeEnd
  c0: vec4f,
  c1: vec4f,
  d: vec4f,   // gravX, gravY, drag, shapeKind (0 point, 1 circle, 2 rect, 3 line)
  e: vec4f,   // start, count, seed, emissive
};
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read> spawns: array<Spawn>;
@group(0) @binding(2) var<uniform> sim: Sim;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(state: ptr<function, u32>) -> f32 {
  *state = pcg(*state);
  return f32(*state) / 4294967295.0;
}

@compute @workgroup_size(64) fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.y) >= sim.spawnCount) { return; }
  let cmd = spawns[gid.y];
  let i = gid.x;
  if (f32(i) >= cmd.e.y) { return; }
  let cap = u32(sim.capacity);
  let idx = (u32(cmd.e.x) + i) % cap;
  var st = pcg(i ^ pcg(u32(cmd.e.z)));

  var pos = cmd.a.xy;
  let kind = cmd.d.w;
  if (kind > 0.5 && kind < 1.5) {
    let r = sqrt(rnd(&st)) * cmd.a.z;
    let th = rnd(&st) * 6.2831853;
    pos += vec2f(cos(th), sin(th)) * r;
  } else if (kind > 1.5 && kind < 2.5) {
    pos += (vec2f(rnd(&st), rnd(&st)) - 0.5) * cmd.a.zw;
  } else if (kind > 2.5) {
    pos += cmd.a.zw * rnd(&st);
  }
  let ang = cmd.b.x + (rnd(&st) - 0.5) * cmd.b.y;
  let speed = mix(cmd.b.z, cmd.b.w, rnd(&st));
  let life = mix(cmd.c.x, cmd.c.y, rnd(&st));
  let sj = 0.7 + 0.6 * rnd(&st);

  var p: Particle;
  p.posVel = vec4f(pos, vec2f(cos(ang), sin(ang)) * speed);
  p.c0 = cmd.c0;
  p.c1 = cmd.c1;
  p.life = vec4f(0.0, max(life, 1e-3), cmd.c.z * sj, cmd.c.w * sj);
  p.phys = vec4f(cmd.d.xyz, cmd.e.w);
  particles[idx] = p;
}

@compute @workgroup_size(64) fn update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (f32(i) >= sim.capacity) { return; }
  var p = particles[i];
  if (p.life.x >= p.life.y) { return; }
  let dt = sim.dt;
  p.life.x += dt;
  var v = p.posVel.zw + p.phys.xy * dt;
  v *= exp(-p.phys.z * dt);
  var pos = p.posVel.xy + v * dt;
  if (pos.y > sim.floorY && v.y > 0.0) {
    pos.y = sim.floorY;
    v = vec2f(v.x * 0.75, -v.y * sim.bounce);
  }
  p.posVel = vec4f(pos, v);
  particles[i] = p;
}
`;

export const PARTICLE_RENDER_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
${COMMON}
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<uniform> sim: Sim;

struct PVOut {
  @builtin(position) clip: vec4f,
  @location(0) q: vec2f,
  @location(1) color: vec4f,
  @location(2) emissive: f32,
};
struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PVOut {
  var o: PVOut;
  let p = particles[ii];
  if (p.life.x >= p.life.y) {
    o.clip = vec4f(0.0, 0.0, 2.0, 1.0);
    return o;
  }
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );
  let q = corners[vi];
  let t = p.life.x / p.life.y;
  let size = max(mix(p.life.z, p.life.w, t), 0.0);
  let vel = p.posVel.zw;
  let speed = length(vel);
  var dir = vec2f(1.0, 0.0);
  if (speed > 1e-3) { dir = vel / speed; }
  let len = size + speed * sim.stretch;
  let perp = vec2f(-dir.y, dir.x);
  let world = p.posVel.xy + dir * (q.x * len * 0.5) + perp * (q.y * size * 0.5);
  o.clip = camera.view_proj * vec4f(world, 0.0, 1.0);
  o.q = q;
  o.color = mix(p.c0, p.c1, t);
  o.emissive = p.phys.w;
  return o;
}

@fragment fn fs(in: PVOut) -> FragOut {
  let d = length(in.q);
  var a = clamp(1.0 - d, 0.0, 1.0);
  a = a * a * in.color.a;
  let c = in.color.rgb * a;
  var o: FragOut;
  o.color = vec4f(c, a);
  o.emissive = vec4f(c * in.emissive, a);
  return o;
}
`;

// ------------------------------------------------------------------ the extended kernel
// One kernel for world space and for the extended 2D system (ws/fx-3): 3D positions (z = 0 in
// 2D), spin, sprite-sheet tiles, multi-stop curves, forces, sub-emission and mesh emission. The
// plain 2D shaders above stay byte-for-byte what they were (E-008: 2D particles pixel-identical).

/** Particles per `Particle` struct below: 10 vec4 = 160 bytes. */
export const FX_PARTICLE_FLOATS = 40;
/** Floats per extended spawn record (`Spawn` below). */
export const FX_SPAWN_FLOATS = 52;
/** Forces the extended sim block carries. */
export const MAX_FORCES = 8;
/** Floats of the extended sim block: 20 scalars + 8 forces × 3 vec4. */
export const FX_SIM_FLOATS = 20 + MAX_FORCES * 12;
/** Floats per size-curve slot (count, 8 stops, 3 pad) and per colour-curve slot (count + pad, 8 RGBA). */
export const SIZE_CURVE_FLOATS = 12;
export const COLOR_CURVE_FLOATS = 36;
/** Floats per sub-emission request (`Req` below). */
export const FX_REQUEST_FLOATS = 8;
/** Floats per mesh-surface triangle (p0 + cdf, p1, p2, n0, n1, n2). */
export const SURFACE_TRI_FLOATS = 24;

function fxCommon(world: boolean): string {
  return /* wgsl */ `
const WORLD_SPACE: bool = ${world};
struct Particle {
  pos: vec4f,     // xyz, rotation (rad)
  vel: vec4f,     // xyz, spin (rad/s)
  c0: vec4f,
  c1: vec4f,
  life: vec4f,    // age, lifetime, size at birth (or the size-curve scale), size at death
  phys: vec4f,    // gravity xyz, drag
  wind: vec4f,    // wind xyz, emissive
  tile: vec4f,    // tile from, tile to, tile rate (fps, 0 = over life), flags (1 align to velocity)
  curve: vec4f,   // size slot, colour slot, death slot, life slot (-1 none)
  sub: vec4f,     // death count, life rate, life carry, unused
};
struct Force {
  a: vec4f,       // kind (0 attract, 1 vortex, 2 turbulence, 3 drag), x, y, z
  b: vec4f,       // strength, radius, frequency, seed
  c: vec4f,       // vortex axis xyz | attract falloff (0 constant, 1 linear, 2 inverse-square), dead zone; drag amount
};
struct Sim {
  dt: f32,
  floorY: f32,
  bounce: f32,
  time: f32,
  capacity: f32,
  stretch: f32,
  spawnCount: f32,
  spawnTotal: f32,
  fadeNear: f32,
  fadeFar: f32,
  softness: f32,
  softOn: f32,
  lit: f32,
  textured: f32,
  columns: f32,
  rows: f32,
  forceCount: f32,
  colorBase: f32,
  maxRequests: f32,
  _pad: f32,
  forces: array<Force, ${MAX_FORCES}>,
};
`;
}

const FX_RANDOM = /* wgsl */ `
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(state: ptr<function, u32>) -> f32 {
  *state = pcg(*state);
  return f32(*state) / 4294967295.0;
}
`;

/**
 * The extended compute kernel: \`spawn\` (CPU emits), \`advance\` (one thread: the ring head
 * moves past this frame's emits and the sub-emission request count resets), \`update\`
 * (integrate, forces, floor, spin, sub-emission requests) and \`subspawn\` (one thread per
 * request: the children, one level deep).
 */
function fxComputeWgsl(world: boolean): string {
  return /* wgsl */ `
${fxCommon(world)}
struct Spawn {
  a: vec4f,   // x, y, z, shapeKind (0 point, 1 circle, 2 rect, 3 line, 4 box, 5 sphere, 6 mesh)
  b: vec4f,   // shapeA, shapeB, shapeC, spread
  c: vec4f,   // angle, vz, speedMin, speedMax
  d: vec4f,   // lifeMin, lifeMax, sizeStart, sizeEnd
  c0: vec4f,
  c1: vec4f,
  e: vec4f,   // gravity xyz, drag
  f: vec4f,   // wind xyz, emissive
  g: vec4f,   // start (relative to the frame's head), count, seed, inherit
  h: vec4f,   // tile from, tile to, tile rate, flags (1 align to velocity, 2 along normal)
  i: vec4f,   // rotation min, max, spin min, max
  j: vec4f,   // size slot, colour slot, death slot, life slot
  k: vec4f,   // death count, life rate, mesh offset (vec4s), mesh triangles
};
struct Req {
  pos: vec4f,   // xyz, slot
  vel: vec4f,   // xyz (already scaled by inherit), count
};
struct State {
  head: atomic<u32>,
  count: atomic<u32>,
  _a: u32,
  _b: u32,
  reqs: array<Req>,
};
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read> spawns: array<Spawn>;
@group(0) @binding(2) var<uniform> sim: Sim;
@group(0) @binding(3) var<storage, read_write> state: State;
@group(0) @binding(4) var<storage, read> subs: array<Spawn>;
@group(0) @binding(5) var<storage, read> surface: array<vec4f>;
${FX_RANDOM}
// A uniform direction in the cone of half-angle \`half\` around the unit vector \`axis\`.
fn cone(axis: vec3f, half: f32, st: ptr<function, u32>) -> vec3f {
  let cz = mix(cos(half), 1.0, rnd(st));
  let sz = sqrt(max(1.0 - cz * cz, 0.0));
  let ph = rnd(st) * 6.2831853;
  var t1 = cross(axis, vec3f(0.0, 0.0, 1.0));
  if (dot(t1, t1) < 1e-6) { t1 = vec3f(1.0, 0.0, 0.0); }
  t1 = normalize(t1);
  let t2 = cross(axis, t1);
  return axis * cz + (t1 * cos(ph) + t2 * sin(ph)) * sz;
}
// Launch direction: a 2D fan of \`spread\` around \`axis\` in the XY plane, or a 3D cone.
fn launch(axis: vec3f, spread: f32, st: ptr<function, u32>) -> vec3f {
  if (WORLD_SPACE) {
    return cone(axis, clamp(spread * 0.5, 0.0, 3.14159265), st);
  }
  let base = atan2(axis.y, axis.x);
  let ang = base + (rnd(st) - 0.5) * spread;
  return vec3f(cos(ang), sin(ang), 0.0);
}
// Value noise on the integer lattice, seeded; and the curl of three such fields.
fn lattice(p: vec3i, seed: u32) -> f32 {
  let h = pcg((u32(p.x) * 73856093u) ^ (u32(p.y) * 19349663u) ^ (u32(p.z) * 83492791u) ^ seed);
  return f32(h) / 4294967295.0;
}
fn vnoise(p: vec3f, seed: u32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let c000 = lattice(i, seed);
  let c100 = lattice(i + vec3i(1, 0, 0), seed);
  let c010 = lattice(i + vec3i(0, 1, 0), seed);
  let c110 = lattice(i + vec3i(1, 1, 0), seed);
  let c001 = lattice(i + vec3i(0, 0, 1), seed);
  let c101 = lattice(i + vec3i(1, 0, 1), seed);
  let c011 = lattice(i + vec3i(0, 1, 1), seed);
  let c111 = lattice(i + vec3i(1, 1, 1), seed);
  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
fn curl(p: vec3f, seed: u32) -> vec3f {
  let e = 0.05;
  let dx = vec3f(e, 0.0, 0.0);
  let dy = vec3f(0.0, e, 0.0);
  let dz = vec3f(0.0, 0.0, e);
  let sx = seed;
  let sy = seed + 1u;
  let sz = seed + 2u;
  let dzdy = vnoise(p + dy, sz) - vnoise(p - dy, sz);
  let dydz = vnoise(p + dz, sy) - vnoise(p - dz, sy);
  let dxdz = vnoise(p + dz, sx) - vnoise(p - dz, sx);
  let dzdx = vnoise(p + dx, sz) - vnoise(p - dx, sz);
  let dydx = vnoise(p + dx, sy) - vnoise(p - dx, sy);
  let dxdy = vnoise(p + dy, sx) - vnoise(p - dy, sx);
  return vec3f(dzdy - dydz, dxdz - dzdx, dydx - dxdy) / (2.0 * e);
}
// Binary search of the surface's cumulative-area table: the triangle at \`u\`.
fn surface_tri(offset: u32, count: u32, u: f32) -> u32 {
  var lo = 0u;
  var hi = count - 1u;
  for (var k = 0u; k < 32u; k++) {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    if (surface[offset + mid * 6u].w < u) { lo = mid + 1u; } else { hi = mid; }
  }
  return lo;
}

// A particle from a spawn record: at \`origin\` + the shape, with \`inherit\` added to its launch.
fn make(cmd: Spawn, origin: vec3f, inherit: vec3f, idx: u32, st: ptr<function, u32>, child: bool) {
  var pos = origin + cmd.a.xyz;
  let kind = cmd.a.w;
  let s = cmd.b.xyz;
  var axis = vec3f(cos(cmd.c.x), sin(cmd.c.x), 0.0);
  if (kind > 0.5 && kind < 1.5) {
    let r = sqrt(rnd(st)) * s.x;
    let th = rnd(st) * 6.2831853;
    pos += vec3f(cos(th), sin(th), 0.0) * r;
  } else if (kind > 1.5 && kind < 2.5) {
    pos += vec3f((vec2f(rnd(st), rnd(st)) - 0.5) * s.xy, 0.0);
  } else if (kind > 2.5 && kind < 3.5) {
    pos += s * rnd(st);
  } else if (kind > 3.5 && kind < 4.5) {
    pos += (vec3f(rnd(st), rnd(st), rnd(st)) - 0.5) * s;
  } else if (kind > 4.5 && kind < 5.5) {
    let r = pow(rnd(st), 1.0 / 3.0) * s.x;
    pos += cone(vec3f(0.0, 1.0, 0.0), 3.14159265, st) * r;
  } else if (kind > 5.5) {
    let count = u32(cmd.k.w);
    if (count > 0u) {
      let base = u32(cmd.k.z);
      let tri = base + surface_tri(base, count, rnd(st)) * 6u;
      let r1 = sqrt(rnd(st));
      let r2 = rnd(st);
      let w = vec3f(1.0 - r1, r1 * (1.0 - r2), r1 * r2);
      pos += surface[tri].xyz * w.x + surface[tri + 1u].xyz * w.y + surface[tri + 2u].xyz * w.z;
      if ((u32(cmd.h.w) & 2u) != 0u) {
        let n = surface[tri + 3u].xyz * w.x + surface[tri + 4u].xyz * w.y + surface[tri + 5u].xyz * w.z;
        if (dot(n, n) > 1e-8) { axis = normalize(n); }
      }
    }
  }
  let dir = launch(axis, cmd.b.w, st);
  let speed = mix(cmd.c.z, cmd.c.w, rnd(st));
  let life = mix(cmd.d.x, cmd.d.y, rnd(st));
  let sj = 0.7 + 0.6 * rnd(st);
  let rot = mix(cmd.i.x, cmd.i.y, rnd(st));
  let spin = mix(cmd.i.z, cmd.i.w, rnd(st));

  var p: Particle;
  p.pos = vec4f(pos, rot);
  p.vel = vec4f(dir * speed + vec3f(0.0, 0.0, cmd.c.y) + inherit, spin);
  p.c0 = cmd.c0;
  p.c1 = cmd.c1;
  if (cmd.j.x >= 0.0) {
    p.life = vec4f(0.0, max(life, 1e-3), sj, sj);
  } else {
    p.life = vec4f(0.0, max(life, 1e-3), cmd.d.z * sj, cmd.d.w * sj);
  }
  p.phys = cmd.e;
  p.wind = cmd.f;
  p.tile = cmd.h;
  if (child) {
    p.curve = vec4f(cmd.j.xy, -1.0, -1.0);
    p.sub = vec4f(0.0);
  } else {
    p.curve = cmd.j;
    p.sub = vec4f(cmd.k.x, cmd.k.y, 0.0, 0.0);
  }
  particles[idx] = p;
}

@compute @workgroup_size(64) fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.y) >= sim.spawnCount) { return; }
  let cmd = spawns[gid.y];
  let i = gid.x;
  if (f32(i) >= cmd.g.y) { return; }
  let cap = u32(sim.capacity);
  let idx = (atomicLoad(&state.head) + u32(cmd.g.x) + i) % cap;
  var st = pcg(i ^ pcg(u32(cmd.g.z)));
  make(cmd, vec3f(0.0), vec3f(0.0), idx, &st, false);
}

@compute @workgroup_size(1) fn advance() {
  let cap = u32(sim.capacity);
  let h = atomicLoad(&state.head);
  atomicStore(&state.head, (h + u32(sim.spawnTotal)) % cap);
  atomicStore(&state.count, 0u);
}

fn request(pos: vec3f, vel: vec3f, slot: f32, count: f32) {
  let r = atomicAdd(&state.count, 1u);
  if (f32(r) >= sim.maxRequests) { return; }
  let cmd = subs[u32(slot)];
  var q: Req;
  q.pos = vec4f(pos, slot);
  q.vel = vec4f(vel * cmd.g.w, count);
  state.reqs[r] = q;
}

@compute @workgroup_size(64) fn update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (f32(i) >= sim.capacity) { return; }
  var p = particles[i];
  if (p.life.x >= p.life.y) { return; }
  let dt = sim.dt;
  p.life.x += dt;
  var pos = p.pos.xyz;
  var v = p.vel.xyz;
  var acc = p.phys.xyz;
  var drag = p.phys.w;
  for (var k = 0u; k < u32(sim.forceCount); k++) {
    let f = sim.forces[k];
    let kind = f.a.x;
    if (kind < 0.5) {
      let d = f.a.yzw - pos;
      let r = length(d);
      var w = select(1.0, max(1.0 - r / f.b.y, 0.0), f.b.y > 0.0);
      if (f.c.x > 1.5) { w /= max(r * r, 1e-4); } else if (f.c.x > 0.5) { w *= r; }
      if (r > 1e-4 && r >= f.c.y) { acc += d / r * f.b.x * w; }
    } else if (kind < 1.5) {
      let rel = pos - f.a.yzw;
      let ax = normalize(f.c.xyz);
      let radial = rel - ax * dot(rel, ax);
      let r = length(radial);
      let w = select(1.0, max(1.0 - r / f.b.y, 0.0), f.b.y > 0.0);
      if (r > 1e-4) { acc += cross(ax, radial / r) * f.b.x * w; }
    } else if (kind < 2.5) {
      acc += curl(pos * f.b.z, u32(f.b.w)) * f.b.x;
    } else {
      drag += f.c.w;
    }
  }
  let wind = p.wind.xyz;
  v += acc * dt;
  v = wind + (v - wind) * exp(-drag * dt);
  pos += v * dt;
  if (WORLD_SPACE) {
    if (pos.y < sim.floorY && v.y < 0.0) {
      pos.y = sim.floorY;
      v = vec3f(v.x * 0.75, -v.y * sim.bounce, v.z * 0.75);
    }
  } else {
    if (pos.y > sim.floorY && v.y > 0.0) {
      pos.y = sim.floorY;
      v = vec3f(v.x * 0.75, -v.y * sim.bounce, 0.0);
    }
  }
  p.pos = vec4f(pos, p.pos.w + p.vel.w * dt);
  p.vel = vec4f(v, p.vel.w);
  // Sub-emission: a trail while alive, a burst on the frame the particle dies.
  if (p.curve.w >= 0.0 && p.sub.y > 0.0) {
    p.sub.z += p.sub.y * dt;
    let n = floor(p.sub.z);
    if (n >= 1.0) {
      p.sub.z -= n;
      request(pos, v, p.curve.w, n);
    }
  }
  if (p.life.x >= p.life.y && p.curve.z >= 0.0 && p.sub.x >= 1.0) {
    request(pos, v, p.curve.z, p.sub.x);
  }
  particles[i] = p;
}

@compute @workgroup_size(64) fn subspawn(@builtin(global_invocation_id) gid: vec3u) {
  let r = gid.x;
  let pending = min(atomicLoad(&state.count), u32(sim.maxRequests));
  if (r >= pending) { return; }
  let q = state.reqs[r];
  let cmd = subs[u32(q.pos.w)];
  let n = u32(q.vel.w);
  let cap = u32(sim.capacity);
  let base = atomicAdd(&state.head, n);
  var st = pcg((r * 7919u) ^ pcg(u32(sim.time * 1000.0)) ^ pcg(base));
  for (var i = 0u; i < n; i++) {
    make(cmd, q.pos.xyz, q.vel.xyz, (base + i) % cap, &st, true);
  }
}
`;
}

/**
 * The extended render kernel: the quad is built from the view rows (world) or the XY axes (2D),
 * aligned to the velocity (streaks) when the particle asks, rotated by its spin, sized and
 * coloured by the curve table or the two-stop sugar, textured from the sprite sheet tile when
 * the system has one (both blend modes; premultiplied on output), with the world-space fades
 * and lighting of before.
 */
function fxRenderWgsl(world: boolean): string {
  return /* wgsl */ `
${WGSL_GLOBALS}
${world ? WGSL_LIGHTS : ''}
${fxCommon(world)}
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<uniform> sim: Sim;
${world ? '@group(1) @binding(2) var scene_depth: texture_depth_2d;' : ''}
@group(1) @binding(3) var<storage, read> curves: array<f32>;
@group(1) @binding(4) var sheet: texture_2d<f32>;
@group(1) @binding(5) var sheet_samp: sampler;

struct PVOut {
  @builtin(position) clip: vec4f,
  @location(0) q: vec2f,
  @location(1) color: vec4f,
  @location(2) emissive: f32,
  @location(3) world: vec3f,
  @location(4) view_z: f32,
  @location(5) side: vec3f,
  @location(6) uv: vec2f,
};
struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

fn view_row(r: u32) -> vec3f {
  return vec3f(camera.view[0][r], camera.view[1][r], camera.view[2][r]);
}

// Piecewise-linear over n stops spread evenly on 0..1.
fn size_at(slot: f32, t: f32, s0: f32, s1: f32) -> f32 {
  if (slot < 0.0) { return mix(s0, s1, t); }
  let base = u32(slot) * ${SIZE_CURVE_FLOATS}u;
  let n = u32(curves[base]);
  let x = clamp(t, 0.0, 1.0) * f32(n - 1u);
  let i = min(u32(floor(x)), n - 2u);
  return mix(curves[base + 1u + i], curves[base + 2u + i], x - f32(i)) * s0;
}
fn color_at(slot: f32, t: f32, c0: vec4f, c1: vec4f) -> vec4f {
  if (slot < 0.0) { return mix(c0, c1, t); }
  let base = u32(sim.colorBase) + u32(slot) * ${COLOR_CURVE_FLOATS}u;
  let n = u32(curves[base]);
  let x = clamp(t, 0.0, 1.0) * f32(n - 1u);
  let i = min(u32(floor(x)), n - 2u);
  let a = base + 4u + i * 4u;
  let ca = vec4f(curves[a], curves[a + 1u], curves[a + 2u], curves[a + 3u]);
  let cb = vec4f(curves[a + 4u], curves[a + 5u], curves[a + 6u], curves[a + 7u]);
  return mix(ca, cb, x - f32(i));
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PVOut {
  var o: PVOut;
  let p = particles[ii];
  if (p.life.x >= p.life.y) {
    o.clip = vec4f(0.0, 0.0, 2.0, 1.0);
    return o;
  }
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );
  let q = corners[vi];
  let t = p.life.x / p.life.y;
  let size = max(size_at(p.curve.x, t, p.life.z, p.life.w), 0.0);
  var right = vec3f(1.0, 0.0, 0.0);
  var up = vec3f(0.0, 1.0, 0.0);
  if (WORLD_SPACE) {
    right = view_row(0u);
    up = view_row(1u);
  }
  let vel = p.vel.xyz;
  let v2 = vec2f(dot(vel, right), dot(vel, up));
  let speed = length(v2);
  var dir = vec2f(1.0, 0.0);
  var len = size;
  if ((u32(p.tile.w) & 1u) != 0u) {
    if (speed > 1e-4) { dir = v2 / speed; }
    len = size + speed * sim.stretch;
  }
  let cr = cos(p.pos.w);
  let sr = sin(p.pos.w);
  dir = vec2f(dir.x * cr - dir.y * sr, dir.x * sr + dir.y * cr);
  let axis = right * dir.x + up * dir.y;
  let perp = up * dir.x - right * dir.y;
  let world = p.pos.xyz + axis * (q.x * len * 0.5) + perp * (q.y * size * 0.5);
  o.clip = camera.view_proj * vec4f(world, 1.0);
  o.q = q;
  var color = color_at(p.curve.y, t, p.c0, p.c1);
  if (WORLD_SPACE && sim.fadeFar > sim.fadeNear) {
    let d = length(world - camera.camera_pos.xyz);
    color.a *= 1.0 - smoothstep(sim.fadeNear, sim.fadeFar, d);
  }
  o.color = color;
  o.emissive = p.wind.w;
  o.world = world;
  o.view_z = (camera.view * vec4f(world, 1.0)).z;
  o.side = axis * q.x + perp * q.y;
  // Sprite sheet tile: a fixed tile, a flipbook over life, or at a fixed rate looping.
  let frames = max(p.tile.y - p.tile.x + 1.0, 1.0);
  var tile = p.tile.x;
  if (p.tile.z > 0.0) {
    tile += floor(p.life.x * p.tile.z) % frames;
  } else {
    tile += min(floor(t * frames), frames - 1.0);
  }
  let col = tile % sim.columns;
  let row = floor(tile / sim.columns);
  let qv = select(0.5 - q.y * 0.5, 0.5 + q.y * 0.5, !WORLD_SPACE);
  o.uv = (vec2f(col, row) + vec2f(q.x * 0.5 + 0.5, qv)) / vec2f(sim.columns, sim.rows);
  return o;
}

// View-space z of a depth-buffer value under camera.proj (any perspective or ortho matrix).
fn view_z_of(d: f32) -> f32 {
  let p = camera.proj;
  let den = d * p[2][3] - p[2][2];
  return (p[3][2] - d * p[3][3]) / select(den, 1e-6, abs(den) < 1e-6);
}

@fragment fn fs(in: PVOut) -> FragOut {
  let tex = textureSample(sheet, sheet_samp, in.uv);
  var a: f32;
  var rgb: vec3f;
  if (sim.textured > 0.5) {
    a = in.color.a * tex.a;
    rgb = in.color.rgb * tex.rgb;
  } else {
    let r = length(in.q);
    a = clamp(1.0 - r, 0.0, 1.0);
    a = a * a * in.color.a;
    rgb = in.color.rgb;
  }
${
  world
    ? /* wgsl */ `
  if (sim.softOn > 0.5) {
    let dims = vec2i(textureDimensions(scene_depth));
    let px = clamp(vec2i(in.clip.xy), vec2i(0), dims - 1);
    let scene_z = view_z_of(textureLoad(scene_depth, px, 0));
    a *= saturate(abs(scene_z - in.view_z) / max(sim.softness, 1e-4));
  }
  if (sim.lit > 0.5) {
    let back = view_row(2u);
    let n = normalize(in.side + back * sqrt(max(1.0 - dot(in.side, in.side), 0.0)));
    rgb *= engine_lambert(n, in.world);
  }`
    : ''
}
  let c = rgb * a;
  var o: FragOut;
  o.color = vec4f(c, a);
  o.emissive = vec4f(c * in.emissive, a);
  return o;
}
`;
}

/** The extended 2D kernel (`extended: true`, or implied by `texture`, `forces`, `collide`). */
export const PARTICLE_EXT_COMPUTE_WGSL = fxComputeWgsl(false);
export const PARTICLE_EXT_RENDER_WGSL = fxRenderWgsl(false);
/** World space: the same extended kernel with a 3D cone launch, y-up floor and the view-row quad. */
export const PARTICLE_WORLD_COMPUTE_WGSL = fxComputeWgsl(true);
export const PARTICLE_WORLD_RENDER_WGSL = fxRenderWgsl(true);

/**
 * Depth collision (world space, \`readsDepth\` + \`collide\`): runs in the depth hook over this
 * frame's opaque depth. A live particle whose projected depth lies behind the scene by less
 * than \`thickness\` (view-ray units) is pushed out along the surface normal (from the depth's
 * neighbours) onto the surface, so a resting particle does not creep along the view ray, and its
 * velocity is reflected about that normal, scaled by
 * \`bounce\` normally and by \`1 - friction\` tangentially. A particle deeper than that is
 * swept: if its position one step back (\`pos - vel * dt\`) was in front of the scene it
 * crossed the surface this frame and is put back there, so a slow frame does not tunnel.
 */
export const PARTICLE_COLLIDE_WGSL = /* wgsl */ `
${fxCommon(true)}
struct Collide {
  view_proj: mat4x4f,
  inv_view_proj: mat4x4f,
  viewport: vec4f,   // x, y, width, height (target px)
  params: vec4f,     // bounce, friction, thickness, last step dt
};
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> col: Collide;
@group(0) @binding(2) var scene_depth: texture_depth_2d;

fn unproject(ndc: vec2f, d: f32) -> vec3f {
  let w = col.inv_view_proj * vec4f(ndc, d, 1.0);
  return w.xyz / w.w;
}
fn scene_at(px: vec2i, dims: vec2i) -> vec3f {
  let c = clamp(px, vec2i(0), dims - 1);
  let d = textureLoad(scene_depth, c, 0);
  let ndc = (vec2f(c) + 0.5 - col.viewport.xy) / col.viewport.zw * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  return unproject(ndc, d);
}

@compute @workgroup_size(64) fn collide(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&particles)) { return; }
  var p = particles[i];
  if (p.life.x >= p.life.y) { return; }
  let clip = col.view_proj * vec4f(p.pos.xyz, 1.0);
  if (clip.w <= 1e-5) { return; }
  let ndc = clip.xyz / clip.w;
  if (any(abs(ndc.xy) > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return; }
  let dims = vec2i(textureDimensions(scene_depth));
  let px = vec2i(col.viewport.xy + (ndc.xy * vec2f(0.5, -0.5) + 0.5) * col.viewport.zw);
  let d = textureLoad(scene_depth, clamp(px, vec2i(0), dims - 1), 0);
  if (d >= 1.0 || ndc.z <= d) { return; }
  let near = unproject(ndc.xy, 0.0);
  let hit = unproject(ndc.xy, d);
  let ray = normalize(hit - near);
  let sx = scene_at(px + vec2i(1, 0), dims) - hit;
  let sy = scene_at(px + vec2i(0, 1), dims) - hit;
  var n = cross(sx, sy);
  if (dot(n, n) < 1e-12) { n = -ray; } else { n = normalize(n); }
  if (dot(n, ray) > 0.0) { n = -n; }
  // Out along the surface normal onto the plane through the hit, not back along the view ray:
  // a ray push moves a resting particle toward the camera by its sink depth over tan(grazing
  // angle) every frame, and it creeps off the front edge. dot(hit - pos, n) >= 0 and is at
  // most the depth behind the surface, so a noisy normal cannot throw the particle far.
  var put = p.pos.xyz + n * (max(dot(hit - p.pos.xyz, n), 0.0) + 1e-3);
  if (length(p.pos.xyz - hit) > col.params.z) {
    // Deeper than thickness: a hit only if one step back it was in front of the scene.
    let prev = p.pos.xyz - p.vel.xyz * col.params.w;
    let pc = col.view_proj * vec4f(prev, 1.0);
    if (pc.w <= 1e-5) { return; }
    let pn = pc.xyz / pc.w;
    if (any(abs(pn.xy) > vec2f(1.0)) || pn.z < 0.0 || pn.z > 1.0) { return; }
    let ppx = vec2i(col.viewport.xy + (pn.xy * vec2f(0.5, -0.5) + 0.5) * col.viewport.zw);
    if (pn.z > textureLoad(scene_depth, clamp(ppx, vec2i(0), dims - 1), 0)) { return; }
    put = prev;
  }
  let v = p.vel.xyz;
  let vn = dot(v, n);
  var nv = v;
  if (vn < 0.0) {
    nv = (v - n * vn) * (1.0 - col.params.y) - n * vn * col.params.x;
  }
  p.pos = vec4f(put, p.pos.w);
  p.vel = vec4f(nv, p.vel.w);
  particles[i] = p;
}
`;

/** Copies a depth texture into the particles' own depth32float copy (soft-particle source). */
export const PARTICLE_DEPTH_COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_depth_2d;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @builtin(frag_depth) f32 {
  return textureLoad(src, vec2i(pos.xy), 0);
}
`;

/**
 * Counts live particles of either layout: \`stride\` vec4s per particle, \`life\` at vec4 index
 * \`lifeAt\` (age in x, lifetime in y), and among them those whose y (vec4 \`posAt\`) is below
 * \`belowY\`.
 */
export const PARTICLE_COUNT_WGSL = /* wgsl */ `
struct CountParams {
  capacity: u32,
  stride: u32,
  lifeAt: u32,
  posAt: u32,
  belowY: f32,
  _a: f32,
  _b: f32,
  _c: f32,
};
struct Counts {
  alive: atomic<u32>,
  below: atomic<u32>,
};
@group(0) @binding(0) var<storage, read> data: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> counts: Counts;
@group(0) @binding(2) var<uniform> params: CountParams;
@compute @workgroup_size(64) fn count(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.capacity) { return; }
  let life = data[gid.x * params.stride + params.lifeAt];
  if (life.x < life.y) {
    atomicAdd(&counts.alive, 1u);
    if (data[gid.x * params.stride + params.posAt].y < params.belowY) {
      atomicAdd(&counts.below, 1u);
    }
  }
}
`;
