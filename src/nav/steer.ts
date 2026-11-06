/**
 * Local steering on the XZ plane: small vector helpers an agent combines with a path or flow
 * direction each tick. Every function writes `out` and returns it; nothing allocates.
 */
import type { NavPoint } from './grid';

/** A circular obstacle on the XZ plane. */
export interface Disc {
  x: number;
  z: number;
  radius: number;
}

/**
 * Pushes `self` away from every neighbour closer than `radius`: the sum over them of the unit
 * vector away, weighted `(radius - d) / radius`, so a touching neighbour weighs 1 and one at the
 * edge weighs 0. Zero when none is near; a neighbour exactly at `self` is skipped. Scale the
 * result by a speed to make it a velocity.
 */
export function separate(
  self: Readonly<NavPoint>,
  neighbours: ArrayLike<Readonly<NavPoint>>,
  radius: number,
  out: NavPoint,
): NavPoint {
  let x = 0;
  let z = 0;
  const r2 = radius * radius;
  for (let i = 0; i < neighbours.length; i++) {
    const n = neighbours[i]!;
    const dx = self.x - n.x;
    const dz = self.z - n.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r2 || d2 === 0) continue;
    const d = Math.sqrt(d2);
    const w = (radius - d) / radius / d;
    x += dx * w;
    z += dz * w;
  }
  out.x = x;
  out.z = z;
  return out;
}

/**
 * The velocity that reaches `target`: `speed` outside `slowRadius`, scaled down linearly inside
 * it, zero at the target. `slowRadius` 0 never slows.
 */
export function arrive(
  self: Readonly<NavPoint>,
  target: Readonly<NavPoint>,
  speed: number,
  slowRadius: number,
  out: NavPoint,
): NavPoint {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d === 0) {
    out.x = 0;
    out.z = 0;
    return out;
  }
  const s = slowRadius > 0 && d < slowRadius ? (speed * d) / slowRadius : speed;
  out.x = (dx / d) * s;
  out.z = (dz / d) * s;
  return out;
}

/**
 * `velocity` bent around `disc`: when the disc lies ahead within one second of travel and the
 * course passes closer than its radius, a sideways push away from the centre is added, sized by
 * how deep the course cuts in (full speed at a head-on hit, nothing at a graze). Otherwise `out`
 * is `velocity`. A disc behind, or a zero velocity, leaves it alone. `out` may be `velocity`.
 */
export function avoidDisc(
  self: Readonly<NavPoint>,
  velocity: Readonly<NavPoint>,
  disc: Readonly<Disc>,
  out: NavPoint,
): NavPoint {
  const vx = velocity.x;
  const vz = velocity.z;
  const speed = Math.sqrt(vx * vx + vz * vz);
  out.x = vx;
  out.z = vz;
  if (speed === 0) return out;
  const dx = disc.x - self.x;
  const dz = disc.z - self.z;
  // Distance along the course (world units) and the signed distance beside it, measured along
  // the perpendicular `perp = (vz, -vx) / speed`.
  const along = (dx * vx + dz * vz) / speed;
  if (along <= 0 || along > speed + disc.radius) return out;
  const side = (dx * vz - dz * vx) / speed;
  const miss = Math.abs(side);
  if (miss >= disc.radius) return out;
  const push = (speed * (disc.radius - miss)) / disc.radius;
  // Push along `perp` away from the centre (a centre dead ahead goes to +perp).
  const sign = side > 0 ? -1 : 1;
  out.x = vx + (vz / speed) * push * sign;
  out.z = vz + (-vx / speed) * push * sign;
  return out;
}

/** The three helpers as one namespace: `steer.separate`, `steer.arrive`, `steer.avoidDisc`. */
export const steer = { separate, arrive, avoidDisc } as const;
