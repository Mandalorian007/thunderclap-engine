/**
 * Navmesh demo page: a level built from `@thunderclap/engine/geom` boxes and a ramp (a floor,
 * four pillars, a raised platform reached by the ramp), baked into a `NavMesh` on the page and
 * drawn with `createDebugDraw` over the lit level. Nothing here is engine code: a game would
 * write the same page.
 *
 * - The baked polygons are drawn as outlines; the path from the start marker to the goal is a
 *   thicker green polyline, with a sphere walking it through `followPath3`.
 * - An off-mesh "jump down" link joins the platform's front edge to the floor below it. Its cost
 *   starts high, so the path climbs the ramp; `setLinkCost(1)` makes the path take the link.
 * - A click sets the goal to the navmesh point under the pointer.
 * - `?crowd=N` adds N agents (`createCrowd`) in a ring on the floor converging on the pointer
 *   (or the origin), each drawn as a circle. The page counts overlapping pairs every step.
 * - `?still` parks the follower so pixel probes see a fixed frame.
 *
 * e2e/navmesh.spec.ts reads the bake, probes a pillar, checks the path climbs the ramp or takes
 * the link when it is cheaper, and watches the crowd overlaps stay at 0.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { createDebugDraw } from '@thunderclap/engine/fx';
import { box, extrude, type Geometry, transformGeometry } from '@thunderclap/engine/geom';
import {
  addOffMeshLink,
  bakeNavMesh,
  createCrowd,
  createNavPath3,
  findMeshPath,
  followPath3,
  getOffMeshLink,
  type NavMesh,
  type NavPoint3,
  pathDistance3,
  removeOffMeshLink,
} from '@thunderclap/engine/nav';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  type Mesh,
  Renderer,
  Transform,
} from '@thunderclap/engine/render';
import type { HarnessNavmeshApi, HarnessNavmeshState } from './navmesh-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const params = new URLSearchParams(location.search);
const still = params.has('still');
const crowdSize = Math.max(0, Math.min(256, Number(params.get('crowd') ?? 0) || 0));

const state: HarnessNavmeshState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  polyCount: 0,
  bakeMs: 0,
  pathFound: false,
  pathLength: 0,
  pathPoints: [],
  linkUsed: false,
  linkCost: 50,
  crowd: crowdSize,
  crowdSteps: 0,
  crowdOverlaps: 0,
  gpuErrors: 0,
};

// ------------------------------------------------------------------ the level

const FLOOR = 24;
const PILLARS: ReadonlyArray<readonly [number, number]> = [
  [2, 2],
  [5, -4],
  [-2, 6],
  [-8, 4],
];
/** The platform: top at y = 2, x -7..-1, z -8..-2. */
const PLATFORM = { x: -4, z: -5, size: 6, height: 2 } as const;
/** The ramp meets the platform's -x face and runs down to x = -11. */
const RAMP = { run: 4, depth: 3 } as const;
const LINK_FROM = { x: -4, y: 2, z: -2.3 };
const LINK_TO = { x: -4, y: 0, z: -0.7 };
const START = { x: 8, y: 0, z: 6 };
const GOAL = { x: -4, y: 2, z: -5 };

const CLEAR = [0.05, 0.07, 0.12] as const;
const EYE = [14, 16, 20] as const;
const TARGET = [-1, 0, 0] as const;
const AMBIENT = [0.2, 0.2, 0.22] as const;
const SUN_DIR = [-0.4, -1.0, -0.5] as const;
const SUN_COLOR = [0.9, 0.88, 0.82] as const;

const POLY_COLOR = 0x40c0ffa0;
const PATH_COLOR = 0x60ff80ff;
const LINK_COLOR = 0xffb020ff;
const CROWD_COLOR = 0xff60a0ff;
const FOLLOW_SPEED = 3;
const AGENT_RADIUS = 0.4;
const AGENT_SPEED = 2;
/** Y offset for lines drawn on a surface, so they sit above it in the depth test. */
const LIFT = 0.03;

function at(g: Geometry, x: number, y: number, z: number): Geometry {
  return transformGeometry(g, new Transform({ x, y, z }).world);
}

function buildLevel(): Geometry[] {
  const parts: Geometry[] = [];
  parts.push(at(box({ size: [FLOOR, 1, FLOOR], color: [0.42, 0.46, 0.4, 1] }), 0, -0.5, 0));
  for (const [x, z] of PILLARS) {
    parts.push(at(box({ size: [1, 3, 1], color: [0.6, 0.5, 0.42, 1] }), x, 1.5, z));
  }
  parts.push(
    at(
      box({
        size: [PLATFORM.size, PLATFORM.height, PLATFORM.size],
        color: [0.5, 0.55, 0.62, 1],
      }),
      PLATFORM.x,
      PLATFORM.height / 2,
      PLATFORM.z,
    ),
  );
  // A right triangle in XY rising from x = 0 to x = run, extruded along z, with its high end
  // on the platform's -x face.
  const ramp = extrude([0, 0, RAMP.run, 0, RAMP.run, PLATFORM.height], {
    depth: RAMP.depth,
    color: [0.55, 0.5, 0.6, 1],
  });
  parts.push(at(ramp, PLATFORM.x - PLATFORM.size / 2 - RAMP.run, 0, PLATFORM.z));
  return parts;
}

// ------------------------------------------------------------------ the material

/** Vertex colour × the engine lighting block plus a faint sky term from above. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.1 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ picking

const rayNear: CameraPoint = { x: 0, y: 0, z: 0 };
const rayFar: CameraPoint = { x: 0, y: 0, z: 0 };
const tri = { a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, c: { x: 0, y: 0, z: 0 } };

/** Möller–Trumbore: the ray parameter of the hit on triangle abc, or Infinity. */
function rayTriangle(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  a: NavPoint3,
  b: NavPoint3,
  c: NavPoint3,
): number {
  const e1x = b.x - a.x;
  const e1y = b.y - a.y;
  const e1z = b.z - a.z;
  const e2x = c.x - a.x;
  const e2y = c.y - a.y;
  const e2z = c.z - a.z;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return Number.POSITIVE_INFINITY;
  const inv = 1 / det;
  const tx = ox - a.x;
  const ty = oy - a.y;
  const tz = oz - a.z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Number.POSITIVE_INFINITY;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return Number.POSITIVE_INFINITY;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : Number.POSITIVE_INFINITY;
}

/** The nearest navmesh point under a screen position (logical px), or false. */
function pickMesh(camera: Camera, mesh: NavMesh, sx: number, sy: number, out: NavPoint3): boolean {
  camera.screenToWorld(sx, sy, 0, rayNear);
  camera.screenToWorld(sx, sy, 1, rayFar);
  const dx = rayFar.x - rayNear.x;
  const dy = rayFar.y - rayNear.y;
  const dz = rayFar.z - rayNear.z;
  let best = Number.POSITIVE_INFINITY;
  for (let p = 0; p < mesh.polyCount; p++) {
    const n = mesh.polyVertexCount(p);
    mesh.polyVertex(p, 0, tri.a);
    for (let k = 1; k + 1 < n; k++) {
      mesh.polyVertex(p, k, tri.b);
      mesh.polyVertex(p, k + 1, tri.c);
      const t = rayTriangle(rayNear.x, rayNear.y, rayNear.z, dx, dy, dz, tri.a, tri.b, tri.c);
      if (t < best) best = t;
    }
  }
  if (!Number.isFinite(best)) return false;
  out.x = rayNear.x + dx * best;
  out.y = rayNear.y + dy * best;
  out.z = rayNear.z + dz * best;
  return true;
}

/** Where the pick ray meets the floor plane y = 0, or false when it looks away. */
function pickFloor(camera: Camera, sx: number, sy: number, out: NavPoint3): boolean {
  camera.screenToWorld(sx, sy, 0, rayNear);
  camera.screenToWorld(sx, sy, 1, rayFar);
  const dy = rayFar.y - rayNear.y;
  if (Math.abs(dy) < 1e-9) return false;
  const t = -rayNear.y / dy;
  if (t < 0) return false;
  out.x = rayNear.x + (rayFar.x - rayNear.x) * t;
  out.y = 0;
  out.z = rayNear.z + (rayFar.z - rayNear.z) * t;
  return true;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine navmesh demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt(EYE, TARGET);
  renderer.camera = camera;

  // The level: geometry for the renderer and, as it is, the bake input.
  const level = buildLevel();
  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const meshes: Mesh[] = level.map((g) => renderer.createMesh(g));
  const identity = new Transform();
  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.direction = SUN_DIR;
  lights.sun.color = SUN_COLOR;

  const t0 = performance.now();
  const navmesh = bakeNavMesh(
    level.map((g) => ({ positions: g.vertices, indices: g.indices, stride: 12 })),
    {
      cellSize: 0.25,
      cellHeight: 0.2,
      agentHeight: 2,
      agentRadius: AGENT_RADIUS,
      agentMaxClimb: 0.4,
      agentMaxSlope: 45,
    },
  );
  state.bakeMs = performance.now() - t0;
  state.polyCount = navmesh.polyCount;

  let linkId = addOffMeshLink(navmesh, {
    from: LINK_FROM,
    to: LINK_TO,
    radius: 1,
    bidirectional: true,
    cost: state.linkCost,
  });

  const start: NavPoint3 = { ...START };
  const goal: NavPoint3 = { ...GOAL };
  const path = createNavPath3();
  const follower: NavPoint3 = { ...START };
  const followVel: NavPoint3 = { x: 0, y: 0, z: 0 };

  function replan(): void {
    state.pathFound = findMeshPath(navmesh, start, goal, path);
    state.pathLength = pathDistance3(path);
    state.pathPoints = Array.from(path.points.subarray(0, path.length * 3));
    state.linkUsed = path.linkCount > 0;
    follower.x = start.x;
    follower.y = start.y;
    follower.z = start.z;
    path.cursor = 0;
  }

  // The crowd: agents in a ring on the floor, all wanting the target.
  const crowd = createCrowd({ maxAgents: Math.max(1, crowdSize) });
  const crowdTarget = { x: 0, z: 0 };
  for (let i = 0; i < crowdSize; i++) {
    const ang = (i / crowdSize) * Math.PI * 2;
    crowd.add({
      x: 6 + Math.cos(ang) * 4.5,
      z: 4 + Math.sin(ang) * 4.5,
      radius: AGENT_RADIUS,
      maxSpeed: AGENT_SPEED,
    });
  }
  /** Agents slow inside this radius of the target, scaled by how many must fit around it. */
  const arrive = AGENT_RADIUS * 2 * Math.sqrt(Math.max(1, crowdSize));

  function stepCrowd(dt: number): void {
    const agents = crowd.agents;
    for (let i = 0; i < crowdSize; i++) {
      const a = agents[i]!;
      const dx = crowdTarget.x - a.x;
      const dz = crowdTarget.z - a.z;
      const d = Math.hypot(dx, dz);
      const speed = d < 1e-6 ? 0 : Math.min(AGENT_SPEED, (AGENT_SPEED * d) / arrive);
      crowd.setPrefVelocity(i, d < 1e-6 ? 0 : (dx / d) * speed, d < 1e-6 ? 0 : (dz / d) * speed);
    }
    crowd.update(dt);
    for (let i = 0; i < crowdSize; i++) {
      const a = agents[i]!;
      for (let j = i + 1; j < crowdSize; j++) {
        const b = agents[j]!;
        if (Math.hypot(a.x - b.x, a.z - b.z) < a.radius + b.radius - 0.01) state.crowdOverlaps++;
      }
    }
    state.crowdSteps++;
  }

  const api: HarnessNavmeshApi = {
    state,
    setGoal(x, y, z) {
      goal.x = x;
      goal.y = y;
      goal.z = z;
      replan();
    },
    setStart(x, y, z) {
      start.x = x;
      start.y = y;
      start.z = z;
      replan();
    },
    setLinkCost(cost) {
      state.linkCost = cost;
      removeOffMeshLink(navmesh, linkId);
      linkId = addOffMeshLink(navmesh, {
        from: LINK_FROM,
        to: LINK_TO,
        radius: 1,
        bidirectional: true,
        cost,
      });
      replan();
    },
    probeNearest(x, y, z, radius) {
      return navmesh.findNearestPoly(x, y, z, probeOut, radius);
    },
    probeHeight(x, z) {
      return navmesh.height(x, z);
    },
    setCrowdTarget(x, z) {
      crowdTarget.x = x;
      crowdTarget.z = z;
    },
  };
  const probeOut: NavPoint3 = { x: 0, y: 0, z: 0 };
  window.__harnessNavmesh = api;

  const picked: NavPoint3 = { x: 0, y: 0, z: 0 };
  const logical = { x: 0, y: 0 };
  surface.canvas.addEventListener('pointerdown', (e) => {
    surface.clientToLogical(e.clientX, e.clientY, logical);
    if (pickMesh(camera, navmesh, logical.x, logical.y, picked)) {
      api.setGoal(picked.x, picked.y, picked.z);
    }
  });
  surface.canvas.addEventListener('pointermove', (e) => {
    if (crowdSize === 0) return;
    surface.clientToLogical(e.clientX, e.clientY, logical);
    if (pickFloor(camera, logical.x, logical.y, picked)) api.setCrowdTarget(picked.x, picked.z);
  });

  replan();

  const debug = createDebugDraw(renderer, { label: 'harness-navmesh', capacity: 1 << 15 });
  const v0: NavPoint3 = { x: 0, y: 0, z: 0 };
  const v1: NavPoint3 = { x: 0, y: 0, z: 0 };
  const la = [0, 0, 0];
  const lb = [0, 0, 0];
  let lifted = new Float32Array(path.points.length);
  const up = [0, 1, 0] as const;
  const circleAt = [0, LIFT, 0];

  function drawMesh(): void {
    for (let p = 0; p < navmesh.polyCount; p++) {
      const n = navmesh.polyVertexCount(p);
      for (let k = 0; k < n; k++) {
        navmesh.polyVertex(p, k, v0);
        navmesh.polyVertex(p, (k + 1) % n, v1);
        la[0] = v0.x;
        la[1] = v0.y + LIFT;
        la[2] = v0.z;
        lb[0] = v1.x;
        lb[1] = v1.y + LIFT;
        lb[2] = v1.z;
        debug.line(la, lb, POLY_COLOR);
      }
    }
    const link = getOffMeshLink(navmesh, linkId);
    if (link) {
      la[0] = link.from.x;
      la[1] = link.from.y + LIFT;
      la[2] = link.from.z;
      lb[0] = link.to.x;
      lb[1] = link.to.y + LIFT;
      lb[2] = link.to.z;
      debug.arrow(la, lb, LINK_COLOR, 0.3);
      circleAt[0] = link.to.x;
      circleAt[2] = link.to.z;
      debug.circle(circleAt, up, link.radius, LINK_COLOR);
    }
  }

  function drawPath(): void {
    const n = path.length;
    if (lifted.length < n * 3) lifted = new Float32Array(path.points.length);
    for (let i = 0; i < n; i++) {
      lifted[i * 3] = path.points[i * 3]!;
      lifted[i * 3 + 1] = path.points[i * 3 + 1]! + LIFT * 2;
      lifted[i * 3 + 2] = path.points[i * 3 + 2]!;
    }
    debug.path(lifted, PATH_COLOR, 3, 0, n);
    debug.wireSphere([start.x, start.y + 0.3, start.z], 0.3, PATH_COLOR, 8);
    debug.wireSphere([goal.x, goal.y + 0.3, goal.z], 0.3, 0xffffffff, 8);
    debug.wireSphere([follower.x, follower.y + 0.35, follower.z], 0.35, 0xffff40ff, 8);
  }

  function drawCrowd(): void {
    const agents = crowd.agents;
    for (let i = 0; i < crowdSize; i++) {
      const a = agents[i]!;
      circleAt[0] = a.x;
      circleAt[2] = a.z;
      debug.circle(circleAt, up, a.radius, CROWD_COLOR, 16);
    }
  }

  const loop = new GameLoop({
    update(dt) {
      if (crowdSize > 0) stepCrowd(dt);
      if (still) return;
      if (followPath3(path, follower, FOLLOW_SPEED, 0.2, followVel) === 'moving') {
        follower.x += followVel.x * dt;
        follower.y += followVel.y * dt;
        follower.z += followVel.z * dt;
      } else if (path.length > 0) {
        // Walk it again.
        follower.x = start.x;
        follower.y = start.y;
        follower.z = start.z;
        path.cursor = 0;
      }
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      for (const m of meshes) frame.mesh(m, lit, identity);
      drawMesh();
      drawPath();
      drawCrowd();
      frame.drawable(debug);
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
