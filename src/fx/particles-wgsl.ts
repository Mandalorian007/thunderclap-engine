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

// ------------------------------------------------------------------ world space
// A separate struct and separate entry points, so the 2D shaders above stay byte-for-byte what
// they were (E-008: 2D particles pixel-identical).

const WORLD_COMMON = /* wgsl */ `
struct Particle {
  pos: vec4f,     // world xyz, unused
  vel: vec4f,     // world units/s xyz, unused
  c0: vec4f,
  c1: vec4f,
  life: vec4f,    // age, lifetime, size at birth, size at death (world units)
  phys: vec4f,    // gravity xyz, drag
  wind: vec4f,    // wind xyz (the velocity drag pulls toward), emissive
};
struct Sim {
  dt: f32,
  floorY: f32,
  bounce: f32,
  time: f32,
  capacity: f32,
  stretch: f32,
  spawnCount: f32,
  _pad3: f32,
  fadeNear: f32,
  fadeFar: f32,
  softness: f32,
  softOn: f32,
  lit: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
`;

export const PARTICLE_WORLD_COMPUTE_WGSL = /* wgsl */ `
${WORLD_COMMON}
struct Spawn {
  a: vec4f,   // x, y, z, shapeKind (0 point, 1 circle, 2 rect, 3 line, 4 box, 5 sphere)
  b: vec4f,   // shapeA, shapeB, shapeC, spread
  c: vec4f,   // angle, vz, speedMin, speedMax
  d: vec4f,   // lifeMin, lifeMax, sizeStart, sizeEnd
  c0: vec4f,
  c1: vec4f,
  e: vec4f,   // gravity xyz, drag
  f: vec4f,   // wind xyz, emissive
  g: vec4f,   // start, count, seed, unused
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

@compute @workgroup_size(64) fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.y) >= sim.spawnCount) { return; }
  let cmd = spawns[gid.y];
  let i = gid.x;
  if (f32(i) >= cmd.g.y) { return; }
  let cap = u32(sim.capacity);
  let idx = (u32(cmd.g.x) + i) % cap;
  var st = pcg(i ^ pcg(u32(cmd.g.z)));

  var pos = cmd.a.xyz;
  let kind = cmd.a.w;
  let s = cmd.b.xyz;
  if (kind > 0.5 && kind < 1.5) {
    let r = sqrt(rnd(&st)) * s.x;
    let th = rnd(&st) * 6.2831853;
    pos += vec3f(cos(th), sin(th), 0.0) * r;
  } else if (kind > 1.5 && kind < 2.5) {
    pos += vec3f((vec2f(rnd(&st), rnd(&st)) - 0.5) * s.xy, 0.0);
  } else if (kind > 2.5 && kind < 3.5) {
    pos += s * rnd(&st);
  } else if (kind > 3.5 && kind < 4.5) {
    pos += (vec3f(rnd(&st), rnd(&st), rnd(&st)) - 0.5) * s;
  } else if (kind > 4.5) {
    let r = pow(rnd(&st), 1.0 / 3.0) * s.x;
    pos += cone(vec3f(0.0, 1.0, 0.0), 3.14159265, &st) * r;
  }
  let axis = vec3f(cos(cmd.c.x), sin(cmd.c.x), 0.0);
  let dir = cone(axis, clamp(cmd.b.w * 0.5, 0.0, 3.14159265), &st);
  let speed = mix(cmd.c.z, cmd.c.w, rnd(&st));
  let life = mix(cmd.d.x, cmd.d.y, rnd(&st));
  let sj = 0.7 + 0.6 * rnd(&st);

  var p: Particle;
  p.pos = vec4f(pos, 0.0);
  p.vel = vec4f(dir * speed + vec3f(0.0, 0.0, cmd.c.y), 0.0);
  p.c0 = cmd.c0;
  p.c1 = cmd.c1;
  p.life = vec4f(0.0, max(life, 1e-3), cmd.d.z * sj, cmd.d.w * sj);
  p.phys = cmd.e;
  p.wind = cmd.f;
  particles[idx] = p;
}

@compute @workgroup_size(64) fn update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (f32(i) >= sim.capacity) { return; }
  var p = particles[i];
  if (p.life.x >= p.life.y) { return; }
  let dt = sim.dt;
  p.life.x += dt;
  let wind = p.wind.xyz;
  var v = p.vel.xyz + p.phys.xyz * dt;
  v = wind + (v - wind) * exp(-p.phys.w * dt);
  var pos = p.pos.xyz + v * dt;
  if (pos.y < sim.floorY && v.y < 0.0) {
    pos.y = sim.floorY;
    v = vec3f(v.x * 0.75, -v.y * sim.bounce, v.z * 0.75);
  }
  p.pos = vec4f(pos, 0.0);
  p.vel = vec4f(v, 0.0);
  particles[i] = p;
}
`;

/**
 * World-space render: camera-facing quads built from the view rows, stretched along the
 * velocity's projection on the view plane, depth-tested, with distance and soft-depth fades
 * and an optional sphere-normal Lambert through the engine lighting block.
 */
export const PARTICLE_WORLD_RENDER_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
${WGSL_LIGHTS}
${WORLD_COMMON}
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<uniform> sim: Sim;
@group(1) @binding(2) var scene_depth: texture_depth_2d;

struct PVOut {
  @builtin(position) clip: vec4f,
  @location(0) q: vec2f,
  @location(1) color: vec4f,
  @location(2) emissive: f32,
  @location(3) world: vec3f,
  @location(4) view_z: f32,
  @location(5) side: vec3f,
};
struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

fn view_row(r: u32) -> vec3f {
  return vec3f(camera.view[0][r], camera.view[1][r], camera.view[2][r]);
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
  let size = max(mix(p.life.z, p.life.w, t), 0.0);
  let right = view_row(0u);
  let up = view_row(1u);
  let vel = p.vel.xyz;
  let v2 = vec2f(dot(vel, right), dot(vel, up));
  let speed = length(v2);
  var dir = vec2f(1.0, 0.0);
  if (speed > 1e-4) { dir = v2 / speed; }
  let len = size + speed * sim.stretch;
  let axis = right * dir.x + up * dir.y;
  let perp = up * dir.x - right * dir.y;
  let world = p.pos.xyz + axis * (q.x * len * 0.5) + perp * (q.y * size * 0.5);
  o.clip = camera.view_proj * vec4f(world, 1.0);
  o.q = q;
  var color = mix(p.c0, p.c1, t);
  if (sim.fadeFar > sim.fadeNear) {
    let d = length(world - camera.camera_pos.xyz);
    color.a *= 1.0 - smoothstep(sim.fadeNear, sim.fadeFar, d);
  }
  o.color = color;
  o.emissive = p.wind.w;
  o.world = world;
  o.view_z = (camera.view * vec4f(world, 1.0)).z;
  o.side = axis * q.x + perp * q.y;
  return o;
}

// View-space z of a depth-buffer value under camera.proj (any perspective or ortho matrix).
fn view_z_of(d: f32) -> f32 {
  let p = camera.proj;
  let den = d * p[2][3] - p[2][2];
  return (p[3][2] - d * p[3][3]) / select(den, 1e-6, abs(den) < 1e-6);
}

@fragment fn fs(in: PVOut) -> FragOut {
  let r = length(in.q);
  var a = clamp(1.0 - r, 0.0, 1.0);
  a = a * a * in.color.a;
  if (sim.softOn > 0.5) {
    let dims = vec2i(textureDimensions(scene_depth));
    let px = clamp(vec2i(in.clip.xy), vec2i(0), dims - 1);
    let scene_z = view_z_of(textureLoad(scene_depth, px, 0));
    a *= saturate(abs(scene_z - in.view_z) / max(sim.softness, 1e-4));
  }
  var rgb = in.color.rgb;
  if (sim.lit > 0.5) {
    let back = view_row(2u);
    let n = normalize(in.side + back * sqrt(max(1.0 - dot(in.side, in.side), 0.0)));
    rgb *= engine_lambert(n, in.world);
  }
  let c = rgb * a;
  var o: FragOut;
  o.color = vec4f(c, a);
  o.emissive = vec4f(c * in.emissive, a);
  return o;
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
 * \`lifeAt\` (age in x, lifetime in y).
 */
export const PARTICLE_COUNT_WGSL = /* wgsl */ `
struct CountParams {
  capacity: u32,
  stride: u32,
  lifeAt: u32,
  _pad: u32,
};
@group(0) @binding(0) var<storage, read> data: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> alive: atomic<u32>;
@group(0) @binding(2) var<uniform> params: CountParams;
@compute @workgroup_size(64) fn count(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.capacity) { return; }
  let life = data[gid.x * params.stride + params.lifeAt];
  if (life.x < life.y) { atomicAdd(&alive, 1u); }
}
`;
