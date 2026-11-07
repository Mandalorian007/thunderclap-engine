/**
 * Nav-4 harness page: the ws/nav-4 additions to `@thunderclap/engine/nav` on a canvas-2D stage,
 * no WebGPU, so e2e/nav4.spec.ts can prove them on every matrix row. Noun-free: a floor, two
 * pillars, agents, a goal.
 *
 * A 20×20 floor with two 2×2 pillars (at x = ±4) is baked into a `NavMesh` on the page from box
 * triangles and drawn top-down (20 logical px per world unit, world x to the right, world z
 * down). The sim is a fixed 1/60 s step, one per animation frame; `advance(n)` runs n steps now,
 * so the spec measures sim time, not wall time. `?still` parks the loop.
 *
 * - `?crowd` (the default): 48 agents attached to the mesh walk from the south edge to targets
 *   on the north edge through corridors (`crowd.attach`, `setTarget`); `?carve` drops a disc
 *   obstacle between the pillars at 2 s, which invalidates every corridor through the gap and
 *   replans them around the pillars (`state.onMesh`, `reached`, `replans`, `carved`).
 * - `?queue`: a 64×64 grid with scattered walls takes 200 path requests a second through a
 *   `PathQueue` with a fixed pop budget per step (`pending`, `doneTotal`, `maxUpdateMs`).
 * - `?areas`: the floor between the pillars is baked as mud (area 1); the probe path from south
 *   to north is priced with mud at 3× (`lengthMud`, detouring around a pillar) and at 1×
 *   (`lengthPlain`, straight through).
 * - `?flow3`: a mesh flow field toward a goal on the north edge; 48 walkers read `direction3`
 *   each step and stop within half a unit of the goal (`arrived`).
 */
import {
  type AreaStamp,
  bakeNavMesh,
  createAreaCosts,
  createCrowd,
  createFlowField3,
  createNavGrid,
  createNavPath,
  createNavPath3,
  createObstacleSet,
  createPathQueue,
  type FlowField3,
  findMeshPath,
  type NavBakeOptions,
  type NavCell,
  type NavMesh,
  type NavPath,
  type NavPath3,
  type NavPoint3,
  OBSTACLE_AREA,
  pathDistance3,
} from '@thunderclap/engine/nav';
import { computeLetterbox } from '@thunderclap/engine/platform';
import type { HarnessNav4Api, HarnessNav4State, Nav4Mode } from './nav4-state';

const params = new URLSearchParams(location.search);
const MODE: Nav4Mode = params.has('queue')
  ? 'queue'
  : params.has('areas')
    ? 'areas'
    : params.has('flow3')
      ? 'flow3'
      : 'crowd';
const STILL = params.has('still');
const CARVE = params.has('carve');

const LOGICAL = { width: 800, height: 480 };
const STEP = 1 / 60;
const FLOOR = 20;
/** Logical px per world unit; the floor fills 400×400 px centred on the stage. */
const PX = 20;
const CX = LOGICAL.width / 2;
const CZ = LOGICAL.height / 2;
const AGENTS = 48;
const AGENT_RADIUS = 0.3;
const AGENT_SPEED = 2;
const PILLARS: number[][] = [
  [-4, 0, 2, 2],
  [4, 0, 2, 2],
];
const MUD_AREA = 1;
const MUD: AreaStamp = { shape: { minX: -3, minZ: -3, maxX: 3, maxZ: 3 }, area: MUD_AREA };
const CARVE_AT = 2;
const CARVE_DISC = { x: 0, z: 0, radius: 1.2 };
const GOAL: NavPoint3 = { x: 0, y: 0, z: 8 };
const PROBE_FROM: NavPoint3 = { x: 0, y: 0, z: -8 };
const ARRIVE = 0.5;

// `?queue`: a 64×64 grid of 6-px cells centred on the stage, 200 requests a second.
const Q_SIZE = 64;
const Q_CELL = 6;
const Q_ORIGIN_X = (LOGICAL.width - Q_SIZE * Q_CELL) / 2;
const Q_ORIGIN_Y = (LOGICAL.height - Q_SIZE * Q_CELL) / 2;
const Q_RATE = 200;
const Q_MAX = 512;
const Q_BUDGET = 12000;

const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

const state: HarnessNav4State = {
  ready: false,
  mode: MODE,
  ticks: 0,
  simTime: 0,
  still: STILL,
  logical: { ...LOGICAL },
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 1 },
  polyCount: 0,
  bakeMs: 0,
  meshVersion: 0,
  agents: 0,
  onMesh: 0,
  reached: 0,
  replans: 0,
  carved: false,
  requested: 0,
  dropped: 0,
  pending: 0,
  doneTotal: 0,
  failedTotal: 0,
  lastUpdateMs: 0,
  maxUpdateMs: 0,
  lengthMud: 0,
  lengthPlain: 0,
  mudPolys: 0,
  arrived: 0,
  fieldReached: 0,
};

// --- The level: a floor and two pillars as box triangles, baked on the page. ---

/** Appends an axis-aligned box (12 triangles) centred at `cx, cy, cz`. */
function box(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  pos: number[],
  idx: number[],
): void {
  const b = pos.length / 3;
  const c = [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1];
  for (let i = 0; i < 8; i++)
    pos.push(
      cx + c[i * 3]! * sx * 0.5,
      cy + c[i * 3 + 1]! * sy * 0.5,
      cz + c[i * 3 + 2]! * sz * 0.5,
    );
  const f = [
    4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7,
    4, 3, 4, 0,
  ];
  for (const i of f) idx.push(b + i);
}

const BAKE: NavBakeOptions = {
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 2,
  agentRadius: 0.5,
  agentMaxClimb: 0.4,
  agentMaxSlope: 45,
};

function bakeLevel(areas: AreaStamp[]): NavMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  box(0, -0.5, 0, FLOOR, 1, FLOOR, pos, idx);
  for (const [x, z, w, d] of PILLARS) box(x!, 1.5, z!, w!, 3, d!, pos, idx);
  const t0 = performance.now();
  const m = bakeNavMesh({ positions: pos, indices: idx }, { ...BAKE, areas });
  state.bakeMs = performance.now() - t0;
  state.polyCount = m.polyCount;
  return m;
}

const mesh: NavMesh | null = MODE === 'queue' ? null : bakeLevel(MODE === 'areas' ? [MUD] : []);

/** 48 starters in 4 rows of 12 along the south edge, 1.36 apart across and 1 apart down. */
const startX = (i: number): number => -7.5 + (i % 12) * (15 / 11);
const startRow = (i: number): number => Math.floor(i / 12);

// --- `?crowd` ---

const crowd = createCrowd({ maxAgents: AGENTS, neighborDist: 3 });
const obstacles = mesh ? createObstacleSet(mesh, { maxObstacles: 4 }) : null;
if (MODE === 'crowd' && mesh && obstacles) {
  crowd.attach(mesh, { arriveRadius: ARRIVE, slowRadius: 1 });
  crowd.obstacles(obstacles);
  for (let i = 0; i < AGENTS; i++) {
    const x = startX(i);
    const z = -8.5 + startRow(i);
    const a = crowd.add({ x, z, radius: AGENT_RADIUS, maxSpeed: AGENT_SPEED });
    // The target: the same lane on the north edge, rows mirrored so nobody walks through a
    // parked agent (every row's target lies south of the rows that arrive before it).
    const tz = 8.5 - startRow(i);
    crowd.setTarget(a, x, mesh.height(x, tz), tz);
  }
  state.agents = AGENTS;
  state.replans = crowd.replans;
}

function stepCrowd(): void {
  if (!mesh || !obstacles) return;
  if (CARVE && !state.carved && state.simTime >= CARVE_AT) {
    obstacles.add({ x: CARVE_DISC.x, z: CARVE_DISC.z, radius: CARVE_DISC.radius });
    obstacles.apply();
    state.carved = true;
  }
  crowd.update(STEP);
  let onMesh = 0;
  let reached = 0;
  for (let i = 0; i < AGENTS; i++) {
    const a = crowd.agents[i]!;
    if (!a.active) continue;
    if (a.poly >= 0) onMesh++;
    if (a.targetReached) reached++;
  }
  state.onMesh = onMesh;
  state.reached = reached;
  state.replans = crowd.replans;
}

// --- `?queue` ---

let seed = 12345;
/** A small deterministic generator so every row sees the same requests. */
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

const grid = createNavGrid({ width: Q_SIZE, height: Q_SIZE, cellSize: 1 });
const queue =
  MODE === 'queue'
    ? createPathQueue(grid, { maxQueries: Q_MAX, iterationsPerUpdate: Q_BUDGET })
    : null;
const outs: NavPath[] = [];
const lastDone = createNavPath(Q_SIZE * 2);
let requestDebt = 0;
if (MODE === 'queue' && queue) {
  // Scattered 3×1 wall blocks over about a tenth of the grid, the borders kept clear.
  for (let i = 0; i < 140; i++) {
    const x = 2 + Math.floor(rand() * (Q_SIZE - 6));
    const y = 2 + Math.floor(rand() * (Q_SIZE - 4));
    const vertical = rand() < 0.5;
    for (let k = 0; k < 3; k++) {
      const cx = vertical ? x : x + k;
      const cy = vertical ? y + k : y;
      grid.setWalkable(grid.index(cx, cy), false);
    }
  }
  for (let i = 0; i < Q_MAX; i++) outs.push(createNavPath(Q_SIZE * 2));
  queue.onDone = (_ticket, ok, out) => {
    if (!ok) state.failedTotal++;
    else if (out.length > 0) {
      const p = out as NavPath;
      lastDone.points.set(p.points.subarray(0, p.length * 2));
      lastDone.length = p.length;
    }
  };
}

const from: NavCell = { x: 0, y: 0 };
const to: NavCell = { x: 0, y: 0 };
function randomWalkable(cell: NavCell): void {
  do {
    cell.x = Math.floor(rand() * Q_SIZE);
    cell.y = Math.floor(rand() * Q_SIZE);
  } while (!grid.isWalkable(cell.x, cell.y));
}

function stepQueue(): void {
  if (!queue) return;
  requestDebt += Q_RATE * STEP;
  while (requestDebt >= 1) {
    requestDebt -= 1;
    randomWalkable(from);
    randomWalkable(to);
    const out = outs[state.requested % Q_MAX]!;
    const ticket = queue.request(from, to, out, { smooth: true });
    state.requested++;
    if (ticket < 0) state.dropped++;
  }
  const t0 = performance.now();
  queue.update();
  const ms = performance.now() - t0;
  state.lastUpdateMs = ms;
  if (ms > state.maxUpdateMs) state.maxUpdateMs = ms;
  state.pending = queue.pending;
  state.doneTotal = queue.finished;
}

// --- `?areas` ---

const mudPath = createNavPath3(64);
const plainPath = createNavPath3(64);
if (MODE === 'areas' && mesh) {
  const costs = createAreaCosts();
  costs[MUD_AREA] = 3;
  let mud = 0;
  for (let p = 0; p < mesh.polyCount; p++) if (mesh.area[p] === MUD_AREA) mud++;
  state.mudPolys = mud;
  PROBE_FROM.y = mesh.height(PROBE_FROM.x, PROBE_FROM.z);
  GOAL.y = mesh.height(GOAL.x, GOAL.z);
  if (findMeshPath(mesh, PROBE_FROM, GOAL, mudPath, { areaCost: costs }))
    state.lengthMud = pathDistance3(mudPath);
  if (findMeshPath(mesh, PROBE_FROM, GOAL, plainPath)) state.lengthPlain = pathDistance3(plainPath);
}

// --- `?flow3` ---

let field: FlowField3 | null = null;
const walkers = new Float64Array(AGENTS * 3);
const walkerDone = new Uint8Array(AGENTS);
const dir: NavPoint3 = { x: 0, y: 0, z: 0 };
const snap: NavPoint3 = { x: 0, y: 0, z: 0 };
if (MODE === 'flow3' && mesh) {
  GOAL.y = mesh.height(GOAL.x, GOAL.z);
  field = createFlowField3(mesh, [GOAL]);
  state.fieldReached = field.reached;
  for (let i = 0; i < AGENTS; i++) {
    const x = startX(i);
    const z = -8.5 + startRow(i);
    walkers[i * 3] = x;
    walkers[i * 3 + 1] = mesh.height(x, z);
    walkers[i * 3 + 2] = z;
  }
}

function stepFlow3(): void {
  if (!mesh || !field) return;
  if (field.update()) state.fieldReached = field.reached;
  let arrived = 0;
  for (let i = 0; i < AGENTS; i++) {
    if (walkerDone[i] === 1) {
      arrived++;
      continue;
    }
    const x = walkers[i * 3]!;
    const y = walkers[i * 3 + 1]!;
    const z = walkers[i * 3 + 2]!;
    const dx = GOAL.x - x;
    const dz = GOAL.z - z;
    if (dx * dx + dz * dz <= ARRIVE * ARRIVE) {
      walkerDone[i] = 1;
      arrived++;
      continue;
    }
    let p = field.direction3(x, y, z, dir);
    if (p < 0) {
      // Off the mesh (a portal corner): snap back on and read again.
      p = mesh.findNearestPoly(x, y, z, snap, 2);
      if (p >= 0) {
        walkers[i * 3] = snap.x;
        walkers[i * 3 + 1] = snap.y;
        walkers[i * 3 + 2] = snap.z;
        field.direction3(snap.x, snap.y, snap.z, dir);
      }
    }
    const step = Math.min(AGENT_SPEED * STEP, Math.sqrt(dx * dx + dz * dz));
    const nx = walkers[i * 3]! + dir.x * step;
    const nz = walkers[i * 3 + 2]! + dir.z * step;
    walkers[i * 3] = nx;
    walkers[i * 3 + 2] = nz;
    walkers[i * 3 + 1] = mesh.height(nx, nz, p);
  }
  state.arrived = arrived;
}

// --- The loop ---

function step(): void {
  state.ticks++;
  state.simTime = state.ticks * STEP;
  if (MODE === 'crowd') stepCrowd();
  else if (MODE === 'queue') stepQueue();
  else if (MODE === 'flow3') stepFlow3();
  if (mesh) state.meshVersion = mesh.version;
}

const sx = (x: number) => CX + x * PX;
const sz = (z: number) => CZ + z * PX;
const vert: NavPoint3 = { x: 0, y: 0, z: 0 };

function drawMesh(): void {
  if (!g2 || !mesh) return;
  for (let p = 0; p < mesh.polyCount; p++) {
    const n = mesh.polyVertexCount(p);
    g2.beginPath();
    for (let k = 0; k < n; k++) {
      mesh.polyVertex(p, k, vert);
      if (k === 0) g2.moveTo(sx(vert.x), sz(vert.z));
      else g2.lineTo(sx(vert.x), sz(vert.z));
    }
    g2.closePath();
    const area = mesh.area[p]!;
    g2.fillStyle = area === OBSTACLE_AREA ? '#5a2a2a' : area === MUD_AREA ? '#4a4228' : '#2a3a4a';
    g2.fill();
    g2.strokeStyle = '#6a7a8a';
    g2.lineWidth = 1;
    g2.stroke();
  }
  g2.fillStyle = '#8a7a6a';
  for (const [x, z, w, d] of PILLARS)
    g2.fillRect(sx(x! - w! / 2), sz(z! - d! / 2), w! * PX, d! * PX);
}

function drawPath3(path: NavPath3, colour: string): void {
  if (!g2 || path.length < 2) return;
  g2.strokeStyle = colour;
  g2.lineWidth = 2;
  g2.beginPath();
  for (let i = 0; i < path.length; i++) {
    const x = sx(path.points[i * 3]!);
    const y = sz(path.points[i * 3 + 2]!);
    if (i === 0) g2.moveTo(x, y);
    else g2.lineTo(x, y);
  }
  g2.stroke();
}

function draw(): void {
  if (!g2) return;
  g2.fillStyle = '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  if (MODE === 'queue') {
    for (let y = 0; y < Q_SIZE; y++) {
      for (let x = 0; x < Q_SIZE; x++) {
        g2.fillStyle = grid.isWalkable(x, y) ? '#2a3a4a' : '#8a7a6a';
        g2.fillRect(Q_ORIGIN_X + x * Q_CELL, Q_ORIGIN_Y + y * Q_CELL, Q_CELL - 1, Q_CELL - 1);
      }
    }
    if (lastDone.length > 1) {
      g2.strokeStyle = '#f0c040';
      g2.lineWidth = 2;
      g2.beginPath();
      for (let i = 0; i < lastDone.length; i++) {
        const x = Q_ORIGIN_X + (lastDone.points[i * 2]! + 0.5) * Q_CELL;
        const y = Q_ORIGIN_Y + (lastDone.points[i * 2 + 1]! + 0.5) * Q_CELL;
        if (i === 0) g2.moveTo(x, y);
        else g2.lineTo(x, y);
      }
      g2.stroke();
    }
    g2.fillStyle = '#dde';
    g2.font = '12px system-ui, sans-serif';
    g2.fillText(
      `pending ${state.pending} done ${state.doneTotal} max ${state.maxUpdateMs.toFixed(2)} ms`,
      8,
      16,
    );
    return;
  }
  drawMesh();
  if (MODE === 'crowd') {
    if (state.carved) {
      g2.fillStyle = 'rgba(220, 80, 80, 0.5)';
      g2.beginPath();
      g2.arc(sx(CARVE_DISC.x), sz(CARVE_DISC.z), CARVE_DISC.radius * PX, 0, Math.PI * 2);
      g2.fill();
    }
    for (let i = 0; i < AGENTS; i++) {
      const a = crowd.agents[i]!;
      if (!a.active) continue;
      g2.fillStyle = a.targetReached ? '#60d080' : a.poly >= 0 ? '#f0c040' : '#f05050';
      g2.beginPath();
      g2.arc(sx(a.x), sz(a.z), a.radius * PX, 0, Math.PI * 2);
      g2.fill();
    }
  } else if (MODE === 'areas') {
    drawPath3(plainPath, '#60a0f0');
    drawPath3(mudPath, '#f0c040');
  } else if (MODE === 'flow3') {
    g2.fillStyle = '#60d080';
    g2.beginPath();
    g2.arc(sx(GOAL.x), sz(GOAL.z), ARRIVE * PX, 0, Math.PI * 2);
    g2.fill();
    for (let i = 0; i < AGENTS; i++) {
      g2.fillStyle = walkerDone[i] === 1 ? '#60d080' : '#f0c040';
      g2.beginPath();
      g2.arc(sx(walkers[i * 3]!), sz(walkers[i * 3 + 2]!), AGENT_RADIUS * PX, 0, Math.PI * 2);
      g2.fill();
    }
  }
  g2.fillStyle = '#dde';
  g2.font = '12px system-ui, sans-serif';
  g2.fillText(
    `${MODE} polys ${state.polyCount} v${state.meshVersion} t ${state.simTime.toFixed(1)}`,
    8,
    16,
  );
}

const layout = () => {
  const r = computeLetterbox(root.clientWidth, root.clientHeight, LOGICAL.width, LOGICAL.height);
  state.rect = { ...r };
  Object.assign(stage.style, {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
};
window.addEventListener('resize', layout);
layout();

const api: HarnessNav4Api = {
  state,
  advance(steps) {
    for (let i = 0; i < steps; i++) step();
    draw();
  },
};

if (mesh) state.meshVersion = mesh.version;
state.ready = true;
const tick = () => {
  if (!STILL) step();
  draw();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
window.__harnessNav4 = api;
