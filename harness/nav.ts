/**
 * Nav harness page: `@thunderclap/engine/nav` on a canvas-2D stage, no WebGPU, so
 * e2e/nav.spec.ts can prove the grid, A*, string pulling, the flow field and steering on every
 * matrix row. Noun-free: cells, walls, agents, a goal.
 *
 * - A 40×24 grid of 20-px cells on an 800×480 logical stage (world x = stage x, world z =
 *   stage y), with a wall down column 20 whose two-cell gap (rows 5-6) sits off the probe row.
 * - A click or tap sets the goal cell. 32 agents flow to it through one flow field, each adding
 *   separation from its neighbours; within three cells of the goal an agent has arrived.
 * - A probe path (A* then `smoothPath`) runs from a fixed start cell to the goal and is drawn.
 * - The sim is a fixed 1/60 s step, one per animation frame; `advance(n)` runs n steps now, so
 *   the spec measures sim time, not wall time.
 */
import {
  type Cell,
  createFlowField,
  createNavGrid,
  createNavPath,
  findPath,
  type NavPoint,
  pathDistance,
  smoothPath,
  steer,
} from '@thunderclap/engine/nav';
import { computeLetterbox } from '@thunderclap/engine/platform';
import type { HarnessNavApi, HarnessNavState, NavAgentInfo } from './nav-state';

const LOGICAL = { width: 800, height: 480 };
const CELL = 20;
const COLS = LOGICAL.width / CELL;
const ROWS = LOGICAL.height / CELL;
const STEP = 1 / 60;
const AGENTS = 32;
const SPEED = 120;
const SEPARATION = 14;
const ARRIVE = CELL * 3;
const WALL_COL = 20;
const GAP = [5, 6];
const PATH_START: Cell = { x: 3, y: 12 };

const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

const grid = createNavGrid({
  width: COLS,
  height: ROWS,
  cellSize: CELL,
  walkable: (x, y) => x !== WALL_COL || GAP.includes(y),
});
const field = createFlowField(grid);
const raw = createNavPath(128);
const path = createNavPath(128);

interface Agent extends NavAgentInfo {
  startX: number;
  startZ: number;
}
const agents: Agent[] = [];
for (let i = 0; i < AGENTS; i++) {
  const cx = 2 + (i % 4);
  const cy = 4 + Math.floor(i / 4) * 2;
  const x = (cx + 0.5) * CELL;
  const z = (cy + 0.5) * CELL;
  agents.push({ x, z, arrived: false, startX: x, startZ: z });
}

const state: HarnessNavState = {
  ready: false,
  ticks: 0,
  simTime: 0,
  logical: LOGICAL,
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 0 },
  grid: { width: COLS, height: ROWS, cellSize: CELL },
  walls: 0,
  gridVersion: 0,
  goal: { x: 36, y: 12 },
  agents,
  arrived: 0,
  pathStart: { ...PATH_START },
  pathFound: false,
  pathLength: 0,
  rawPathLength: 0,
  pathDistance: 0,
  buildMs: 0,
  builds: 0,
};

const goalWorld: NavPoint = { x: 0, z: 0 };
const goals: Cell[] = [{ x: 0, y: 0 }];

function countWalls(): number {
  let n = 0;
  for (let i = 0; i < grid.size; i++) if (grid.costs[i] === 0) n++;
  return n;
}

/** Rebuilds the flow field and the probe path for the current goal and walls. */
function replan(): void {
  goals[0]!.x = state.goal.x;
  goals[0]!.y = state.goal.y;
  grid.toWorld(state.goal.x, state.goal.y, goalWorld);
  const t0 = performance.now();
  field.build(goals);
  state.buildMs = performance.now() - t0;
  state.builds++;
  state.pathFound = findPath(grid, PATH_START, state.goal, raw);
  state.rawPathLength = raw.length;
  path.points.set(raw.points.subarray(0, raw.length * 2));
  path.length = raw.length;
  path.cursor = 0;
  path.version = raw.version;
  smoothPath(grid, path);
  state.pathLength = path.length;
  state.pathDistance = pathDistance(path);
  state.walls = countWalls();
  state.gridVersion = grid.version;
}

const dir: NavPoint = { x: 0, z: 0 };
const sep: NavPoint = { x: 0, z: 0 };
const vel: NavPoint = { x: 0, z: 0 };
const cell: Cell = { x: 0, y: 0 };

function step(): void {
  let arrived = 0;
  for (const a of agents) {
    const dx = goalWorld.x - a.x;
    const dz = goalWorld.z - a.z;
    if (!a.arrived && dx * dx + dz * dz <= ARRIVE * ARRIVE) a.arrived = true;
    if (a.arrived) {
      arrived++;
      vel.x = 0;
      vel.z = 0;
    } else {
      field.directionAt(a.x, a.z, dir);
      if (dir.x === 0 && dir.z === 0) {
        // In the goal cell or sealed off: head straight for the goal centre.
        steer.arrive(a, goalWorld, SPEED, CELL, vel);
      } else {
        vel.x = dir.x * SPEED;
        vel.z = dir.z * SPEED;
      }
    }
    steer.separate(a, agents, SEPARATION, sep);
    const k = a.arrived ? SPEED * 0.5 : SPEED;
    vel.x += sep.x * k;
    vel.z += sep.z * k;
    const nx = a.x + vel.x * STEP;
    const nz = a.z + vel.z * STEP;
    // Stay on walkable cells: slide along a wall rather than enter it.
    if (walkableAt(nx, nz)) {
      a.x = nx;
      a.z = nz;
    } else if (walkableAt(nx, a.z)) {
      a.x = nx;
    } else if (walkableAt(a.x, nz)) {
      a.z = nz;
    }
  }
  state.arrived = arrived;
  state.ticks++;
  state.simTime = state.ticks * STEP;
}

function walkableAt(x: number, z: number): boolean {
  if (x < 0 || z < 0 || x >= LOGICAL.width || z >= LOGICAL.height) return false;
  grid.toCell(x, z, cell);
  return grid.isWalkable(cell.x, cell.y);
}

function draw(): void {
  if (!g2) return;
  g2.fillStyle = '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  g2.fillStyle = '#4a556e';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!grid.isWalkable(x, y)) g2.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
  if (path.length > 1) {
    g2.strokeStyle = '#6a88c0';
    g2.lineWidth = 2;
    g2.beginPath();
    g2.moveTo(path.points[0]!, path.points[1]!);
    for (let i = 1; i < path.length; i++) g2.lineTo(path.points[i * 2]!, path.points[i * 2 + 1]!);
    g2.stroke();
  }
  g2.fillStyle = '#f0c060';
  g2.fillRect(state.goal.x * CELL + 4, state.goal.y * CELL + 4, CELL - 8, CELL - 8);
  for (const a of agents) {
    g2.fillStyle = a.arrived ? '#8fd18f' : '#e8e8f0';
    g2.beginPath();
    g2.arc(a.x, a.z, 5, 0, Math.PI * 2);
    g2.fill();
  }
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

const api: HarnessNavApi = {
  state,
  setGoal(cx, cy) {
    if (!grid.inBounds(cx, cy)) return;
    state.goal = { x: cx, y: cy };
    for (const a of agents) a.arrived = false;
    replan();
  },
  toggleWall(cx, cy) {
    grid.setWalkable(cx, cy, !grid.isWalkable(cx, cy));
    replan();
  },
  advance(steps) {
    for (let i = 0; i < steps; i++) step();
  },
  reset() {
    for (const a of agents) {
      a.x = a.startX;
      a.z = a.startZ;
      a.arrived = false;
    }
    state.arrived = 0;
  },
};

stage.addEventListener('pointerdown', (e) => {
  const r = state.rect;
  if (r.scale <= 0) return;
  const x = (e.clientX - r.x) / r.scale;
  const z = (e.clientY - r.y) / r.scale;
  if (x < 0 || z < 0 || x >= LOGICAL.width || z >= LOGICAL.height) return;
  grid.toCell(x, z, cell);
  api.setGoal(cell.x, cell.y);
});

replan();
const tick = () => {
  step();
  draw();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
window.__harnessNav = api;
state.ready = true;
