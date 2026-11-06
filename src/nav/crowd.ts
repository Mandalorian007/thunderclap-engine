/**
 * `Crowd`: local avoidance for many agents on the XZ plane by ORCA (the RVO2 method). Each tick,
 * every agent picks the velocity nearest its preferred one that keeps it clear of its neighbours
 * for `timeHorizon` seconds, then moves by it. Neighbours come from a hashed uniform grid.
 * Everything is allocated at creation for `maxAgents`; `update` allocates nothing.
 */

export interface CrowdOptions {
  maxAgents: number;
  /** Neighbours considered per agent, nearest first. Default 10. */
  maxNeighbors?: number;
  /** Seconds ahead an agent keeps clear of the others. Default 2. */
  timeHorizon?: number;
  /** Agents farther apart than this ignore each other (grid cell size). Default 4. */
  neighborDist?: number;
}

export interface CrowdAgentOptions {
  x: number;
  z: number;
  radius: number;
  maxSpeed: number;
  /** Where it wants to go, world units per second. Default still. */
  prefVelocity?: { x: number; z: number };
}

export interface CrowdAgent {
  /** False for an empty slot. */
  active: boolean;
  x: number;
  z: number;
  /** The velocity the last `update` chose. */
  vx: number;
  vz: number;
  radius: number;
  maxSpeed: number;
  prefX: number;
  prefZ: number;
}

export interface Crowd {
  /** One slot per index up to `maxAgents`; check `active`. The array and its objects never change identity. */
  readonly agents: readonly CrowdAgent[];
  /** Adds an agent and returns its index, or -1 when the crowd is full. */
  add(agent: CrowdAgentOptions): number;
  remove(index: number): void;
  setPrefVelocity(index: number, x: number, z: number): void;
  setPosition(index: number, x: number, z: number): void;
  /** Chooses every agent's velocity, then moves them by `dt` seconds. */
  update(dt: number): void;
}

const EPS = 0.00001;

function det(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Lines are `dirX, dirY, pointX, pointY`; the result of a solve lands in `resX`, `resY`. */
let resX = 0;
let resY = 0;

function linearProgram1(
  lines: Float64Array,
  lineNo: number,
  radius: number,
  optX: number,
  optY: number,
  dirOpt: boolean,
): boolean {
  const dx = lines[lineNo * 4]!;
  const dy = lines[lineNo * 4 + 1]!;
  const px = lines[lineNo * 4 + 2]!;
  const py = lines[lineNo * 4 + 3]!;
  const dot = px * dx + py * dy;
  const disc = dot * dot + radius * radius - (px * px + py * py);
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  let tLeft = -dot - sq;
  let tRight = -dot + sq;
  for (let i = 0; i < lineNo; i++) {
    const idx = lines[i * 4]!;
    const idy = lines[i * 4 + 1]!;
    const denominator = det(dx, dy, idx, idy);
    const numerator = det(idx, idy, px - lines[i * 4 + 2]!, py - lines[i * 4 + 3]!);
    if (Math.abs(denominator) <= EPS) {
      if (numerator < 0) return false;
      continue;
    }
    const t = numerator / denominator;
    if (denominator >= 0) {
      if (t < tRight) tRight = t;
    } else if (t > tLeft) tLeft = t;
    if (tLeft > tRight) return false;
  }
  let t: number;
  if (dirOpt) {
    t = optX * dx + optY * dy > 0 ? tRight : tLeft;
  } else {
    t = dx * (optX - px) + dy * (optY - py);
    if (t < tLeft) t = tLeft;
    else if (t > tRight) t = tRight;
  }
  resX = px + t * dx;
  resY = py + t * dy;
  return true;
}

function linearProgram2(
  lines: Float64Array,
  count: number,
  radius: number,
  optX: number,
  optY: number,
  dirOpt: boolean,
): number {
  if (dirOpt) {
    resX = optX * radius;
    resY = optY * radius;
  } else {
    const l2 = optX * optX + optY * optY;
    if (l2 > radius * radius) {
      const s = radius / Math.sqrt(l2);
      resX = optX * s;
      resY = optY * s;
    } else {
      resX = optX;
      resY = optY;
    }
  }
  for (let i = 0; i < count; i++) {
    const dx = lines[i * 4]!;
    const dy = lines[i * 4 + 1]!;
    if (det(dx, dy, lines[i * 4 + 2]! - resX, lines[i * 4 + 3]! - resY) > 0) {
      const tx = resX;
      const ty = resY;
      if (!linearProgram1(lines, i, radius, optX, optY, dirOpt)) {
        resX = tx;
        resY = ty;
        return i;
      }
    }
  }
  return count;
}

function linearProgram3(
  lines: Float64Array,
  count: number,
  beginLine: number,
  radius: number,
  proj: Float64Array,
): void {
  let distance = 0;
  for (let i = beginLine; i < count; i++) {
    const idx = lines[i * 4]!;
    const idy = lines[i * 4 + 1]!;
    const ipx = lines[i * 4 + 2]!;
    const ipy = lines[i * 4 + 3]!;
    if (det(idx, idy, ipx - resX, ipy - resY) <= distance) continue;
    let np = 0;
    for (let j = 0; j < i; j++) {
      const jdx = lines[j * 4]!;
      const jdy = lines[j * 4 + 1]!;
      const jpx = lines[j * 4 + 2]!;
      const jpy = lines[j * 4 + 3]!;
      const denominator = det(idx, idy, jdx, jdy);
      let px: number;
      let py: number;
      if (Math.abs(denominator) <= EPS) {
        if (idx * jdx + idy * jdy > 0) continue;
        px = 0.5 * (ipx + jpx);
        py = 0.5 * (ipy + jpy);
      } else {
        const t = det(jdx, jdy, ipx - jpx, ipy - jpy) / denominator;
        px = ipx + t * idx;
        py = ipy + t * idy;
      }
      let ddx = jdx - idx;
      let ddy = jdy - idy;
      const len = Math.sqrt(ddx * ddx + ddy * ddy);
      if (len > 0) {
        ddx /= len;
        ddy /= len;
      }
      proj[np * 4] = ddx;
      proj[np * 4 + 1] = ddy;
      proj[np * 4 + 2] = px;
      proj[np * 4 + 3] = py;
      np++;
    }
    const tx = resX;
    const ty = resY;
    if (linearProgram2(proj, np, radius, -idy, idx, true) < np) {
      resX = tx;
      resY = ty;
    }
    distance = det(idx, idy, ipx - resX, ipy - resY);
  }
}

/** A crowd with room for `maxAgents`. */
export function createCrowd(opts: CrowdOptions): Crowd {
  const maxAgents = Math.max(1, opts.maxAgents);
  const maxNeighbors = Math.max(1, opts.maxNeighbors ?? 10);
  const timeHorizon = opts.timeHorizon ?? 2;
  const neighborDist = opts.neighborDist ?? 4;
  const agents: CrowdAgent[] = [];
  for (let i = 0; i < maxAgents; i++) {
    agents.push({
      active: false,
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      radius: 0.5,
      maxSpeed: 0,
      prefX: 0,
      prefZ: 0,
    });
  }
  // Hashed uniform grid, rebuilt every update by counting sort.
  let tableSize = 1;
  while (tableSize < maxAgents * 2) tableSize *= 2;
  const cellStart = new Int32Array(tableSize + 1);
  const cellFill = new Int32Array(tableSize);
  const cellItems = new Int32Array(maxAgents);
  const cellOf = new Int32Array(maxAgents);
  const neighIdx = new Int32Array(maxNeighbors);
  const neighD2 = new Float64Array(maxNeighbors);
  const lines = new Float64Array(maxNeighbors * 4);
  const proj = new Float64Array(maxNeighbors * 4);
  const newVx = new Float64Array(maxAgents);
  const newVz = new Float64Array(maxAgents);
  const invCell = 1 / neighborDist;
  const neighborDist2 = neighborDist * neighborDist;

  const hash = (cx: number, cz: number): number =>
    ((cx * 73856093) ^ (cz * 19349663)) & (tableSize - 1);

  const computeNewVelocity = (i: number, dt: number, nn: number): void => {
    const a = agents[i]!;
    const invTimeHorizon = 1 / timeHorizon;
    let nl = 0;
    for (let k = 0; k < nn; k++) {
      const o = agents[neighIdx[k]!]!;
      const rpx = o.x - a.x;
      const rpy = o.z - a.z;
      const rvx = a.vx - o.vx;
      const rvy = a.vz - o.vz;
      const distSq = rpx * rpx + rpy * rpy;
      const cr = a.radius + o.radius;
      const crSq = cr * cr;
      let dx: number;
      let dy: number;
      let ux: number;
      let uy: number;
      if (distSq > crSq) {
        // No collision yet: the velocity obstacle is a truncated cone.
        const wx = rvx - invTimeHorizon * rpx;
        const wy = rvy - invTimeHorizon * rpy;
        const wLenSq = wx * wx + wy * wy;
        const dot1 = wx * rpx + wy * rpy;
        if (dot1 < 0 && dot1 * dot1 > crSq * wLenSq) {
          // Project on the cut-off circle.
          const wLen = Math.sqrt(wLenSq);
          const uwx = wx / wLen;
          const uwy = wy / wLen;
          dx = uwy;
          dy = -uwx;
          const s = cr * invTimeHorizon - wLen;
          ux = s * uwx;
          uy = s * uwy;
        } else {
          // Project on a leg.
          const leg = Math.sqrt(distSq - crSq);
          if (det(rpx, rpy, wx, wy) > 0) {
            dx = (rpx * leg - rpy * cr) / distSq;
            dy = (rpx * cr + rpy * leg) / distSq;
          } else {
            dx = -(rpx * leg + rpy * cr) / distSq;
            dy = -(-rpx * cr + rpy * leg) / distSq;
          }
          const dot2 = rvx * dx + rvy * dy;
          ux = dot2 * dx - rvx;
          uy = dot2 * dy - rvy;
        }
      } else {
        // Already overlapping: separate within this time step.
        const invDt = 1 / dt;
        const wx = rvx - invDt * rpx;
        const wy = rvy - invDt * rpy;
        const wLen = Math.sqrt(wx * wx + wy * wy);
        let uwx: number;
        let uwy: number;
        if (wLen > 0) {
          uwx = wx / wLen;
          uwy = wy / wLen;
        } else {
          // Coincident and still: push along a fixed direction.
          uwx = 1;
          uwy = 0;
        }
        dx = uwy;
        dy = -uwx;
        const s = cr * invDt - wLen;
        ux = s * uwx;
        uy = s * uwy;
      }
      lines[nl * 4] = dx;
      lines[nl * 4 + 1] = dy;
      lines[nl * 4 + 2] = a.vx + 0.5 * ux;
      lines[nl * 4 + 3] = a.vz + 0.5 * uy;
      nl++;
    }
    const fail = linearProgram2(lines, nl, a.maxSpeed, a.prefX, a.prefZ, false);
    if (fail < nl) linearProgram3(lines, nl, fail, a.maxSpeed, proj);
    newVx[i] = resX;
    newVz[i] = resY;
  };

  const update = (dt: number): void => {
    if (dt <= 0) return;
    // Bin the agents.
    cellStart.fill(0);
    for (let i = 0; i < maxAgents; i++) {
      const a = agents[i]!;
      if (!a.active) continue;
      const c = hash(Math.floor(a.x * invCell), Math.floor(a.z * invCell));
      cellOf[i] = c;
      cellStart[c + 1]!++;
    }
    for (let c = 0; c < tableSize; c++) cellStart[c + 1]! += cellStart[c]!;
    cellFill.fill(0);
    for (let i = 0; i < maxAgents; i++) {
      if (!agents[i]!.active) continue;
      const c = cellOf[i]!;
      cellItems[cellStart[c]! + cellFill[c]!++] = i;
    }
    // Choose velocities from the current state, then apply them all at once.
    for (let i = 0; i < maxAgents; i++) {
      const a = agents[i]!;
      if (!a.active) continue;
      let nn = 0;
      const cx = Math.floor(a.x * invCell);
      const cz = Math.floor(a.z * invCell);
      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          const c = hash(cx + ox, cz + oz);
          const end = cellStart[c + 1]!;
          for (let k = cellStart[c]!; k < end; k++) {
            const j = cellItems[k]!;
            if (j === i) continue;
            const o = agents[j]!;
            // A hash bucket may hold far cells too: the distance test sorts it out.
            const ddx = o.x - a.x;
            const ddz = o.z - a.z;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 > neighborDist2) continue;
            if (nn === maxNeighbors && d2 >= neighD2[nn - 1]!) continue;
            // Sorted insertion, nearest first.
            let at = nn < maxNeighbors ? nn : maxNeighbors - 1;
            while (at > 0 && neighD2[at - 1]! > d2) {
              neighD2[at] = neighD2[at - 1]!;
              neighIdx[at] = neighIdx[at - 1]!;
              at--;
            }
            neighD2[at] = d2;
            neighIdx[at] = j;
            if (nn < maxNeighbors) nn++;
          }
        }
      }
      computeNewVelocity(i, dt, nn);
    }
    for (let i = 0; i < maxAgents; i++) {
      const a = agents[i]!;
      if (!a.active) continue;
      a.vx = newVx[i]!;
      a.vz = newVz[i]!;
      a.x += a.vx * dt;
      a.z += a.vz * dt;
    }
  };

  return {
    agents,
    add(o) {
      for (let i = 0; i < maxAgents; i++) {
        const a = agents[i]!;
        if (a.active) continue;
        a.active = true;
        a.x = o.x;
        a.z = o.z;
        a.vx = 0;
        a.vz = 0;
        a.radius = o.radius;
        a.maxSpeed = o.maxSpeed;
        a.prefX = o.prefVelocity?.x ?? 0;
        a.prefZ = o.prefVelocity?.z ?? 0;
        return i;
      }
      return -1;
    },
    remove(index) {
      const a = agents[index];
      if (a) a.active = false;
    },
    setPrefVelocity(index, x, z) {
      const a = agents[index];
      if (!a) return;
      a.prefX = x;
      a.prefZ = z;
    },
    setPosition(index, x, z) {
      const a = agents[index];
      if (!a) return;
      a.x = x;
      a.z = z;
    },
    update,
  };
}
