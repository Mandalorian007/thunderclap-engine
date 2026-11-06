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
 *
 * `?reach`: a 32×32 grid of 15-px cells with a stepped plateau (climbing costs, a one-way cliff
 * on its north edge, a wall), the cells `reachable` from a start within a budget painted, a
 * budget slider and a 4/8-neighbour toggle, and the hovered cell's path (from the reach's
 * parents) drawn. `?multi`: the 40×24 grid with three goal cells in one flow field
 * (`createFlowField(grid, { goals })`), every cell's arrow drawn; a toggled wall marks the
 * field stale and the next step updates it in place.
 */
import {
  type Cell,
  createFlowField,
  createNavGrid,
  createNavPath,
  createReach,
  type EdgeCost,
  findPath,
  type NavGrid,
  type NavPoint,
  pathDistance,
  type Reach,
  reachable,
  smoothPath,
  steer,
} from '@thunderclap/engine/nav';
import { computeLetterbox } from '@thunderclap/engine/platform';
import type { HarnessNavApi, HarnessNavState, NavAgentInfo, NavHarnessMode } from './nav-state';

const params = new URLSearchParams(location.search);
const MODE: NavHarnessMode = params.has('reach') ? 'reach' : params.has('multi') ? 'multi' : 'flow';

const LOGICAL = { width: 800, height: 480 };
const STEP = 1 / 60;
const AGENTS = MODE === 'flow' ? 32 : 0;
const SPEED = 120;
const SEPARATION = 14;
const WALL_COL = 20;
const GAP = [5, 6];
const PATH_START: Cell = { x: 3, y: 12 };
const MULTI_GOALS: Cell[] = [
  { x: 5, y: 4 },
  { x: 34, y: 6 },
  { x: 18, y: 20 },
];

// `?reach`: a 32×32 grid, 15 px a cell, centred on the stage; levels 0, 1 and 2.
const REACH_SIZE = 32;
const REACH_CELL = 15;
const REACH_ORIGIN_X = (LOGICAL.width - REACH_SIZE * REACH_CELL) / 2;
const REACH_START: Cell = { x: 4, y: 16 };
const REACH_BUDGET = 8;
/** Cost per level climbed; dropping is free. */
const CLIMB = 3;

const CELL = MODE === 'reach' ? REACH_CELL : 20;
const COLS = MODE === 'reach' ? REACH_SIZE : LOGICAL.width / CELL;
const ROWS = MODE === 'reach' ? REACH_SIZE : LOGICAL.height / CELL;
const ARRIVE = CELL * 3;

const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

/** `?reach`: the level of each cell: a ring at 1 around a block at 2, on a floor at 0. */
function levelAt(x: number, y: number): number {
  if (x >= 12 && x < 20 && y >= 12 && y < 20) return 2;
  if (x >= 8 && x < 24 && y >= 8 && y < 24) return 1;
  return 0;
}

/** `?reach`: a wall segment on the floor west of the plateau, with a gap. */
function reachWalkable(x: number, y: number): boolean {
  return !(x === 6 && y >= 10 && y < 22 && y !== 15);
}

/**
 * `?reach`: climbing a level costs `CLIMB` per level, dropping is free, and the north edge of
 * the plateau ring (row 7 to row 8) is a cliff: a drop down it, never a climb up it.
 */
const reachEdgeCost: EdgeCost = (from, to, grid) => {
  const fx = from % grid.width;
  const fy = (from - fx) / grid.width;
  const tx = to % grid.width;
  const ty = (to - tx) / grid.width;
  const d = levelAt(tx, ty) - levelAt(fx, fy);
  if (d <= 0) return 0;
  if (fy === 7 && ty === 8) return Infinity;
  return d * CLIMB;
};

function makeGrid(neighbours: 4 | 8): NavGrid {
  if (MODE === 'reach') {
    return createNavGrid({
      width: COLS,
      height: ROWS,
      cellSize: CELL,
      origin: { x: REACH_ORIGIN_X, z: 0 },
      neighbours,
      walkable: reachWalkable,
      edgeCost: reachEdgeCost,
    });
  }
  return createNavGrid({
    width: COLS,
    height: ROWS,
    cellSize: CELL,
    walkable: (x, y) => x !== WALL_COL || GAP.includes(y),
  });
}

// `?reach` keeps one grid per neighbourhood (the neighbourhood is fixed at creation) and one
// `Reach` per grid; the toggle switches between them, so a query never allocates.
const grid8 = makeGrid(8);
const grid4 = MODE === 'reach' ? makeGrid(4) : grid8;
let grid: NavGrid = grid8;
const reach8: Reach | null = MODE === 'reach' ? createReach(grid8) : null;
const reach4: Reach | null = MODE === 'reach' ? createReach(grid4) : null;
let reach: Reach | null = reach8;

const field = createFlowField(grid8);
const raw = createNavPath(128);
const path = createNavPath(128);
const hoverPath = createNavPath(128);

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
  mode: MODE,
  ticks: 0,
  simTime: 0,
  logical: LOGICAL,
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 0 },
  grid: { width: COLS, height: ROWS, cellSize: CELL },
  walls: 0,
  gridVersion: 0,
  goal: MODE === 'reach' ? { x: 28, y: 4 } : { x: 36, y: 12 },
  agents,
  arrived: 0,
  pathStart: { ...PATH_START },
  pathFound: false,
  pathLength: 0,
  rawPathLength: 0,
  pathDistance: 0,
  buildMs: 0,
  builds: 0,
  neighbours: 8,
  budget: REACH_BUDGET,
  reachCount: 0,
  reachStart: { ...REACH_START },
  hover: { x: -1, y: -1 },
  hoverPathLength: 0,
  queryMs: 0,
  goals: [],
  fieldStale: false,
};

const goalWorld: NavPoint = { x: 0, z: 0 };
const goals: Cell[] = [{ x: 0, y: 0 }];
const multiGoals: number[] = [];

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
  if (MODE === 'multi') {
    multiGoals.length = 0;
    for (const c of MULTI_GOALS) multiGoals.push(grid.index(c.x, c.y));
    field.setGoals(multiGoals);
    state.goals = multiGoals.slice();
    state.queryMs = performance.now() - t0;
  } else {
    field.build(goals);
  }
  state.buildMs = performance.now() - t0;
  state.builds++;
  state.fieldStale = field.stale;
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

/** `?reach`: a new reachability query from the start on the current grid, then the hover path. */
function requery(): void {
  if (!reach) return;
  const t0 = performance.now();
  reach = reachable(grid, grid.index(REACH_START.x, REACH_START.y), state.budget, reach);
  state.queryMs = performance.now() - t0;
  state.reachCount = reach.count;
  state.walls = countWalls();
  state.gridVersion = grid.version;
  rehover();
}

function rehover(): void {
  const h = state.hover;
  if (reach && grid.inBounds(h.x, h.y) && reach.pathTo(grid.index(h.x, h.y), hoverPath)) {
    state.hoverPathLength = hoverPath.length;
  } else {
    hoverPath.length = 0;
    state.hoverPathLength = 0;
  }
}

const dir: NavPoint = { x: 0, z: 0 };
const sep: NavPoint = { x: 0, z: 0 };
const vel: NavPoint = { x: 0, z: 0 };
const cell: Cell = { x: 0, y: 0 };

function step(): void {
  if (MODE === 'multi' && field.stale) {
    const t0 = performance.now();
    field.update();
    state.queryMs = performance.now() - t0;
    state.buildMs = state.queryMs;
    state.builds++;
    state.fieldStale = field.stale;
  }
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

const LEVEL_FILL = ['#1d2330', '#2a3650', '#3a4c70'];

function strokePath(p: { points: Float32Array; length: number }, colour: string): void {
  if (!g2 || p.length < 2) return;
  g2.strokeStyle = colour;
  g2.lineWidth = 2;
  g2.beginPath();
  g2.moveTo(p.points[0]!, p.points[1]!);
  for (let i = 1; i < p.length; i++) g2.lineTo(p.points[i * 2]!, p.points[i * 2 + 1]!);
  g2.stroke();
}

function draw(): void {
  if (!g2) return;
  g2.fillStyle = MODE === 'reach' ? '#141821' : '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  const ox = grid.origin.x;
  if (MODE === 'reach') {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        g2.fillStyle = LEVEL_FILL[levelAt(x, y)]!;
        g2.fillRect(ox + x * CELL, y * CELL, CELL - 1, CELL - 1);
      }
    }
    // The cliff edge.
    g2.fillStyle = '#c05050';
    g2.fillRect(ox + 8 * CELL, 8 * CELL - 1, 16 * CELL, 2);
  }
  g2.fillStyle = '#4a556e';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!grid.isWalkable(x, y)) g2.fillRect(ox + x * CELL, y * CELL, CELL, CELL);
    }
  }
  if (MODE === 'reach' && reach) {
    const r = reach;
    const w = grid.width;
    g2.fillStyle = 'rgba(120, 200, 140, 0.45)';
    for (let i = 0; i < r.count; i++) {
      const idx = r.cells[i]!;
      const x = idx % w;
      const y = (idx - x) / w;
      g2.fillRect(ox + x * CELL + 2, y * CELL + 2, CELL - 5, CELL - 5);
    }
    g2.fillStyle = '#f0c060';
    g2.fillRect(ox + REACH_START.x * CELL + 3, REACH_START.y * CELL + 3, CELL - 7, CELL - 7);
    if (grid.inBounds(state.hover.x, state.hover.y)) {
      g2.strokeStyle = '#ffffff';
      g2.lineWidth = 1;
      g2.strokeRect(
        ox + state.hover.x * CELL + 0.5,
        state.hover.y * CELL + 0.5,
        CELL - 2,
        CELL - 2,
      );
    }
    strokePath(hoverPath, '#ffffff');
    return;
  }
  if (MODE === 'multi') {
    g2.strokeStyle = '#8fa0c8';
    g2.lineWidth = 1;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        field.direction(x, y, dir);
        if (dir.x === 0 && dir.z === 0) continue;
        const cx = (x + 0.5) * CELL;
        const cz = (y + 0.5) * CELL;
        g2.beginPath();
        g2.moveTo(cx - dir.x * 6, cz - dir.z * 6);
        g2.lineTo(cx + dir.x * 6, cz + dir.z * 6);
        g2.stroke();
        g2.fillStyle = '#8fa0c8';
        g2.fillRect(cx + dir.x * 6 - 1.5, cz + dir.z * 6 - 1.5, 3, 3);
      }
    }
    g2.fillStyle = '#f0c060';
    for (const c of MULTI_GOALS) g2.fillRect(c.x * CELL + 4, c.y * CELL + 4, CELL - 8, CELL - 8);
    return;
  }
  strokePath(path, '#6a88c0');
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
    const walkable = !grid.isWalkable(cx, cy);
    grid8.setWalkable(cx, cy, walkable);
    if (grid4 !== grid8) grid4.setWalkable(cx, cy, walkable);
    if (MODE === 'reach') {
      requery();
    } else if (MODE === 'multi') {
      // Left stale on purpose: the next step updates the field in place.
      state.fieldStale = field.stale;
      state.walls = countWalls();
      state.gridVersion = grid.version;
    } else {
      replan();
    }
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
  setBudget(budget) {
    state.budget = Math.max(0, budget);
    if (slider) slider.value = String(state.budget);
    requery();
  },
  setNeighbours(n) {
    if (MODE !== 'reach' || (n !== 4 && n !== 8)) return;
    state.neighbours = n;
    grid = n === 4 ? grid4 : grid8;
    reach = n === 4 ? reach4 : reach8;
    if (toggle) toggle.textContent = `${n} neighbours`;
    requery();
  },
  hover(cx, cy) {
    state.hover = { x: cx, y: cy };
    rehover();
  },
  fieldAt(cx, cy) {
    field.direction(cx, cy, dir);
    return { x: dir.x, z: dir.z, distance: field.distance(cx, cy) };
  },
};

function pointerCell(e: PointerEvent): boolean {
  const r = state.rect;
  if (r.scale <= 0) return false;
  const x = (e.clientX - r.x) / r.scale;
  const z = (e.clientY - r.y) / r.scale;
  if (x < 0 || z < 0 || x >= LOGICAL.width || z >= LOGICAL.height) return false;
  if (MODE === 'reach' && (x < grid.origin.x || x >= grid.origin.x + COLS * CELL)) return false;
  grid.toCell(x, z, cell);
  return true;
}

stage.addEventListener('pointerdown', (e) => {
  if (!pointerCell(e)) return;
  if (MODE === 'reach') api.hover(cell.x, cell.y);
  else if (MODE === 'multi') api.toggleWall(cell.x, cell.y);
  else api.setGoal(cell.x, cell.y);
});
if (MODE === 'reach') {
  stage.addEventListener('pointermove', (e) => {
    if (pointerCell(e)) api.hover(cell.x, cell.y);
  });
}

// `?reach` controls: a budget slider and the neighbourhood toggle, over the stage's left margin.
let slider: HTMLInputElement | null = null;
let toggle: HTMLButtonElement | null = null;
if (MODE === 'reach') {
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'absolute',
    left: '8px',
    top: '8px',
    width: '140px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    color: '#dde',
    font: '12px system-ui, sans-serif',
  });
  const label = document.createElement('label');
  label.textContent = `budget ${REACH_BUDGET}`;
  slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '40';
  slider.step = '1';
  slider.value = String(REACH_BUDGET);
  slider.addEventListener('input', () => {
    api.setBudget(Number(slider?.value ?? REACH_BUDGET));
    label.textContent = `budget ${state.budget}`;
  });
  toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = '8 neighbours';
  toggle.addEventListener('click', () => api.setNeighbours(state.neighbours === 8 ? 4 : 8));
  panel.append(label, slider, toggle);
  stage.append(panel);
}

if (MODE === 'reach') requery();
else replan();
const tick = () => {
  step();
  draw();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
window.__harnessNav = api;
state.ready = true;
