import { WGSL_GLOBALS } from '../render/wgsl';

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
  o.clip = globals.viewProj * vec4f(world, 0.0, 1.0);
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
