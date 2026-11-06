/**
 * `Crowd`: local avoidance for many agents on the XZ plane by ORCA (the RVO2 method). Each tick,
 * every agent picks the velocity nearest its preferred one that keeps it clear of its neighbours
 * (and of the obstacles of an `ObstacleSet`, as static lines) for `timeHorizon` seconds, then
 * moves by it. Neighbours come from a hashed uniform grid. Attached to a `NavMesh`, agents walk
 * corridors to targets (`setTarget`, searched through a `PathQueue` or synchronously), their
 * preferred velocity steers along the pulled string, and after each move they are clamped onto
 * the mesh with `y` from its height. Everything is allocated at creation (and at `attach`) for
 * `maxAgents`; `update` allocates nothing.
 */
import { type Corridor, createCorridor } from './corridor';
import { createNavPath3, findMeshPath, type NavPath3 } from './mesh/mesh-path';
import type { NavMesh, NavPoint3 } from './mesh/navmesh';
import type { ObstacleSet } from './obstacles';
import type { PathQueue } from './query-queue';
import { arrive } from './steer';

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
  /** On a mesh: the surface height under the agent (0 otherwise). */
  y: number;
  /** On a mesh: the polygon the agent stands in, -1 off the mesh or unattached. */
  poly: number;
  /** On a mesh: the corridor to the agent's target (null unattached). */
  corridor: Corridor | null;
  /** True once the agent came within `arriveRadius` of its target; false when no target. */
  targetReached: boolean;
}

export interface CrowdAttachOptions {
  /** Searches go through this queue when given, else `findMeshPath` runs inside `setTarget`. */
  queue?: PathQueue;
  /** Corridor capacity per agent. Default 64. */
  maxWaypoints?: number;
  /** An agent this close to its target has reached it. Default: its radius. */
  arriveRadius?: number;
  /** `steer.arrive` slows an agent inside this distance of its target. Default 1. */
  slowRadius?: number;
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
  /**
   * Keeps the agents on `mesh`: every agent gets a corridor, `setTarget` plans through it, and
   * each `update` steers along it and clamps positions (and `y`) onto the mesh. Allocates per
   * agent; call once at setup.
   */
  attach(mesh: NavMesh, opts?: CrowdAttachOptions): void;
  /**
   * Sends an attached agent to `(x, y, z)`: through the queue when attached with one (the agent
   * waits until its path arrives), else by a synchronous search. A corridor that becomes invalid
   * (the mesh version changed) replans the same way. `targetReached` resets to false.
   */
  setTarget(index: number, x: number, y: number, z: number): void;
  /** Keeps agents clear of the set's obstacles (discs and boxes as static ORCA lines); null detaches. */
  obstacles(set: ObstacleSet | null): void;
  /** Corridor replans since creation (a changed mesh under a corridor, or a target set). */
  readonly replans: number;
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
      y: 0,
      poly: -1,
      corridor: null,
      targetReached: false,
    });
  }
  // Mesh attachment state, per agent.
  let mesh: NavMesh | null = null;
  let queue: PathQueue | null = null;
  let arriveRadius = -1;
  let slowRadius = 1;
  let replans = 0;
  const paths: NavPath3[] = [];
  const tickets = new Int32Array(maxAgents);
  const hasTarget = new Uint8Array(maxAgents);
  const targetX = new Float64Array(maxAgents);
  const targetY = new Float64Array(maxAgents);
  const targetZ = new Float64Array(maxAgents);
  const agentPoint: NavPoint3 = { x: 0, y: 0, z: 0 };
  const corner: NavPoint3 = { x: 0, y: 0, z: 0 };
  const self2 = { x: 0, z: 0 };
  const corner2 = { x: 0, z: 0 };
  const pref2 = { x: 0, z: 0 };
  let obstacleSet: ObstacleSet | null = null;
  // Hashed uniform grid, rebuilt every update by counting sort.
  let tableSize = 1;
  while (tableSize < maxAgents * 2) tableSize *= 2;
  const cellStart = new Int32Array(tableSize + 1);
  const cellFill = new Int32Array(tableSize);
  const cellItems = new Int32Array(maxAgents);
  const cellOf = new Int32Array(maxAgents);
  const neighIdx = new Int32Array(maxNeighbors);
  const neighD2 = new Float64Array(maxNeighbors);
  // Room for the neighbours plus as many obstacle lines (nearest obstacles, up to maxNeighbors).
  const lines = new Float64Array(maxNeighbors * 8);
  const proj = new Float64Array(maxNeighbors * 8);
  const newVx = new Float64Array(maxAgents);
  const newVz = new Float64Array(maxAgents);
  const invCell = 1 / neighborDist;
  const neighborDist2 = neighborDist * neighborDist;

  const hash = (cx: number, cz: number): number =>
    ((cx * 73856093) ^ (cz * 19349663)) & (tableSize - 1);

  /**
   * Adds the ORCA half-plane for agent `a` against a disc at `(ox, oz)` moving `(ovx, ovz)` of
   * radius `or`, `a` taking `share` of the needed velocity change (0.5 between agents, 1 against
   * something static). Returns the next line slot.
   */
  const addLine = (
    a: CrowdAgent,
    nl: number,
    dt: number,
    ox: number,
    oz: number,
    ovx: number,
    ovz: number,
    or: number,
    share: number,
  ): number => {
    const invTimeHorizon = 1 / timeHorizon;
    const rpx = ox - a.x;
    const rpy = oz - a.z;
    const rvx = a.vx - ovx;
    const rvy = a.vz - ovz;
    const distSq = rpx * rpx + rpy * rpy;
    const cr = a.radius + or;
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
    lines[nl * 4 + 2] = a.vx + share * ux;
    lines[nl * 4 + 3] = a.vz + share * uy;
    return nl + 1;
  };

  /** Lines for the obstacles within `neighborDist` of `a` (a box through its nearest point). */
  const addObstacleLines = (a: CrowdAgent, nl: number, dt: number): number => {
    if (!obstacleSet) return nl;
    const list = obstacleSet.obstacles;
    const limit = nl + maxNeighbors;
    for (let k = 0; k < list.length && nl < limit; k++) {
      const o = list[k]!;
      if (!o.active) continue;
      const ddx = o.x - a.x;
      const ddz = o.z - a.z;
      const reach = neighborDist + o.radius;
      if (ddx * ddx + ddz * ddz > reach * reach) continue;
      if (o.kind === 'disc') {
        nl = addLine(a, nl, dt, o.x, o.z, 0, 0, o.radius, 1);
      } else {
        // The box's nearest point to the agent, as a zero-radius static disc.
        const c = Math.cos(o.yaw);
        const s = Math.sin(o.yaw);
        const lx = ddx * c + ddz * s;
        const lz = -ddx * s + ddz * c;
        const hw = o.w * 0.5;
        const hd = o.d * 0.5;
        const qx = Math.max(-hw, Math.min(hw, lx));
        const qz = Math.max(-hd, Math.min(hd, lz));
        // Inside the box: push out through the nearest face instead.
        let px: number;
        let pz: number;
        if (qx === lx && qz === lz) {
          const ex = hw - Math.abs(lx);
          const ez = hd - Math.abs(lz);
          px = ex < ez ? (lx < 0 ? -hw : hw) : lx;
          pz = ex < ez ? lz : lz < 0 ? -hd : hd;
        } else {
          px = qx;
          pz = qz;
        }
        const wx = o.x + px * c - pz * s;
        const wz = o.z + px * s + pz * c;
        nl = addLine(a, nl, dt, wx, wz, 0, 0, 0, 1);
      }
    }
    return nl;
  };

  const computeNewVelocity = (i: number, dt: number, nn: number): void => {
    const a = agents[i]!;
    let nl = 0;
    for (let k = 0; k < nn; k++) {
      const o = agents[neighIdx[k]!]!;
      nl = addLine(a, nl, dt, o.x, o.z, o.vx, o.vz, o.radius, 0.5);
    }
    nl = addObstacleLines(a, nl, dt);
    const fail = linearProgram2(lines, nl, a.maxSpeed, a.prefX, a.prefZ, false);
    if (fail < nl) linearProgram3(lines, nl, fail, a.maxSpeed, proj);
    newVx[i] = resX;
    newVz[i] = resY;
  };

  /** Starts (or restarts) the search for agent `i`'s target. */
  const plan = (i: number): void => {
    if (!mesh) return;
    const a = agents[i]!;
    const path = paths[i]!;
    replans++;
    a.corridor!.clear();
    agentPoint.x = a.x;
    agentPoint.y = a.y;
    agentPoint.z = a.z;
    corner.x = targetX[i]!;
    corner.y = targetY[i]!;
    corner.z = targetZ[i]!;
    if (queue) {
      if (tickets[i]! > 0) queue.cancel(tickets[i]!);
      tickets[i] = queue.request(agentPoint, corner, path);
      return;
    }
    if (findMeshPath(mesh, agentPoint, corner, path)) a.corridor!.set(path);
  };

  /** Steers attached agent `i` along its corridor: the preferred velocity for this tick. */
  const steerAgent = (i: number): void => {
    if (!mesh) return;
    const a = agents[i]!;
    if (hasTarget[i] === 0) return;
    const cor = a.corridor!;
    const reach = arriveRadius >= 0 ? arriveRadius : a.radius;
    const tdx = targetX[i]! - a.x;
    const tdz = targetZ[i]! - a.z;
    if (tdx * tdx + tdz * tdz <= reach * reach) {
      a.targetReached = true;
      a.prefX = 0;
      a.prefZ = 0;
      return;
    }
    if (queue && tickets[i]! > 0) {
      const st = queue.status(tickets[i]!);
      if (st === 'pending') {
        a.prefX = 0;
        a.prefZ = 0;
        return;
      }
      tickets[i] = 0;
      if (st === 'done') cor.set(paths[i]!);
    }
    if (cor.count === 0) {
      a.prefX = 0;
      a.prefZ = 0;
      return;
    }
    if (!cor.valid(mesh)) {
      plan(i);
      a.prefX = 0;
      a.prefZ = 0;
      return;
    }
    cor.advance(a.x, a.z, corner);
    self2.x = a.x;
    self2.z = a.z;
    corner2.x = corner.x;
    corner2.z = corner.z;
    const last = cor.path.length <= 2;
    arrive(self2, corner2, a.maxSpeed, last ? slowRadius : 0, pref2);
    a.prefX = pref2.x;
    a.prefZ = pref2.z;
  };

  /** Keeps attached agent `i` on the mesh after a move and reads its height. */
  const clamp = (i: number): void => {
    if (!mesh) return;
    const a = agents[i]!;
    let p = a.poly;
    if (p < 0 || !mesh.containsXZ(p, a.x, a.z)) {
      // Try the corridor's next polygons first, then the neighbourhood.
      const cor = a.corridor!;
      p = -1;
      const look = Math.min(cor.count, 4);
      for (let k = 0; k < look; k++) {
        const q = cor.polys[cor.offset + k]!;
        if (mesh.containsXZ(q, a.x, a.z)) {
          p = q;
          break;
        }
      }
      if (p < 0) {
        p = mesh.findNearestPoly(a.x, a.y, a.z, agentPoint, a.radius * 4 + 1);
        if (p >= 0) {
          a.x = agentPoint.x;
          a.z = agentPoint.z;
        }
      }
    }
    a.poly = p;
    if (p >= 0) a.y = mesh.polyHeight(p, a.x, a.z);
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
      if (mesh) steerAgent(i);
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
      if (mesh) clamp(i);
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
        a.y = 0;
        a.poly = -1;
        a.targetReached = false;
        hasTarget[i] = 0;
        if (tickets[i]! > 0 && queue) queue.cancel(tickets[i]!);
        tickets[i] = 0;
        a.corridor?.clear();
        if (mesh) clamp(i);
        return i;
      }
      return -1;
    },
    remove(index) {
      const a = agents[index];
      if (!a) return;
      a.active = false;
      if (tickets[index]! > 0 && queue) queue.cancel(tickets[index]!);
      tickets[index] = 0;
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
      a.poly = -1;
      if (mesh && a.active) clamp(index);
    },
    update,
    attach(m, o) {
      mesh = m;
      queue = o?.queue ?? null;
      arriveRadius = o?.arriveRadius ?? -1;
      slowRadius = o?.slowRadius ?? 1;
      const maxWaypoints = o?.maxWaypoints ?? 64;
      for (let i = 0; i < maxAgents; i++) {
        const a = agents[i]!;
        a.corridor = createCorridor(m, maxWaypoints);
        paths[i] = createNavPath3(maxWaypoints);
        tickets[i] = 0;
        hasTarget[i] = 0;
        a.poly = -1;
        if (a.active) clamp(i);
      }
    },
    setTarget(index, x, y, z) {
      const a = agents[index];
      if (!a || !mesh || !a.active) return;
      hasTarget[index] = 1;
      targetX[index] = x;
      targetY[index] = y;
      targetZ[index] = z;
      a.targetReached = false;
      plan(index);
    },
    obstacles(set) {
      obstacleSet = set;
    },
    get replans() {
      return replans;
    },
  };
}
