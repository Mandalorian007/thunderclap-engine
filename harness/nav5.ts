/**
 * Nav-5 harness page: mesh reachability (`reachable(mesh, …)`, `reachableOutline`) on a
 * canvas-2D stage, no WebGPU, so e2e/nav5.spec.ts can prove it on every matrix row. Noun-free:
 * a board, blocks, a strip of mud, a unit.
 *
 * `?range` (the default and only mode): a 24×16 tactics board, one unit tile per polygon, with
 * four blocks left out and a strip of mud tiles (area 1, priced at `MUD_COST`), is built into a
 * `NavMesh` on the page (the constructor builds the adjacency) and drawn top-down (24 logical px per world unit, world x to the right, world z down). Every
 * fixed step recomputes the unit's range with `reachable(mesh, unit, { budget, areaCost })`
 * into a reused `MeshReach`, traces it with `reachableOutline` into a reused outline, and times
 * both (`state.ms`). Polygons in range are filled, the outline loops are stroked. The unit
 * patrols four tiles, one every 90 steps, until `moveUnit` parks it; `setBudget` changes the
 * range. `advance(n)` runs n steps now; `?still` parks the loop.
 */
import {
  createAreaCosts,
  createMeshReach,
  createReachOutline,
  NavMesh,
  type NavPoint3,
  reachable,
  reachableOutline,
} from '@thunderclap-engine/engine/nav';
import { computeLetterbox } from '@thunderclap-engine/engine/platform';
import type { HarnessNav5Api, HarnessNav5State } from './nav5-state';

const params = new URLSearchParams(location.search);
const STILL = params.has('still');

const LOGICAL = { width: 800, height: 480 };
const FLOOR_W = 24;
const FLOOR_D = 16;
const PX = 24;
const CX = LOGICAL.width / 2;
const CZ = LOGICAL.height / 2;
const MUD_AREA = 1;
const MUD_COST = 3;
const BUDGET = 7;
/** Blocks as `x, z, w, d` in tiles. The one at (2, 0) sits inside the first tile's range. */
const BLOCKS: number[][] = [
  [2, 0, 2, 2],
  [-6, -4, 3, 2],
  [-5, 4, 2, 3],
  [8, 4, 2, 4],
];
/** The mud strip, world x -3..-1 (two tile columns) the full depth of the board. */
const MUD = { minX: -3, minZ: -8, maxX: -1, maxZ: 8 };
const PATROL: number[][] = [
  [0.5, 0.5],
  [6.5, -4.5],
  [-8.5, 0.5],
  [4.5, 5.5],
];
const PATROL_STEPS = 90;

const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

const state: HarnessNav5State = {
  ready: false,
  mode: 'range',
  ticks: 0,
  still: STILL,
  logical: { ...LOGICAL },
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 1 },
  polyCount: 0,
  budget: BUDGET,
  mudCost: MUD_COST,
  unit: { x: PATROL[0]![0]!, z: PATROL[0]![1]! },
  polys: 0,
  outlineLoops: 0,
  outlinePoints: 0,
  ms: 0,
  maxMs: 0,
  queries: 0,
};

// --- The board: one unit tile per polygon, blocks left out, mud tiles in area 1. ---

const inBlock = (x: number, z: number): boolean =>
  BLOCKS.some(([bx, bz, w, d]) => Math.abs(x - bx!) < w! / 2 && Math.abs(z - bz!) < d! / 2);
const inMud = (x: number, z: number): boolean =>
  x >= MUD.minX && x <= MUD.maxX && z >= MUD.minZ && z <= MUD.maxZ;

/** A tactics board as a `NavMesh`: a quad per open tile, adjacency built from shared edges. */
function buildBoard(): NavMesh {
  const vw = FLOOR_W + 1;
  const verts = new Float32Array(vw * (FLOOR_D + 1) * 3);
  for (let j = 0; j <= FLOOR_D; j++) {
    for (let i = 0; i <= FLOOR_W; i++) {
      const v = (j * vw + i) * 3;
      verts[v] = i - FLOOR_W / 2;
      verts[v + 2] = j - FLOOR_D / 2;
    }
  }
  const polys: number[] = [];
  const area: number[] = [];
  for (let j = 0; j < FLOOR_D; j++) {
    for (let i = 0; i < FLOOR_W; i++) {
      const x = i - FLOOR_W / 2 + 0.5;
      const z = j - FLOOR_D / 2 + 0.5;
      if (inBlock(x, z)) continue;
      const v = j * vw + i;
      polys.push(v, v + vw, v + vw + 1, v + 1);
      area.push(inMud(x, z) ? MUD_AREA : 0);
    }
  }
  const n = area.length;
  const m = new NavMesh(
    verts,
    vw * (FLOOR_D + 1),
    Int32Array.from(polys),
    n,
    4,
    1,
    0.2,
    undefined,
    Uint8Array.from(area),
  );
  state.polyCount = m.polyCount;
  return m;
}

const mesh = buildBoard();
const areaCost = createAreaCosts();
areaCost[MUD_AREA] = MUD_COST;
const reach = createMeshReach(mesh);
const outline = createReachOutline(256);
const at: NavPoint3 = { x: 0, y: 0, z: 0 };
let parked = false;

function step(): void {
  state.ticks++;
  if (!parked) {
    const tile = PATROL[Math.floor(state.ticks / PATROL_STEPS) % PATROL.length]!;
    state.unit.x = tile[0]!;
    state.unit.z = tile[1]!;
  }
  at.x = state.unit.x;
  at.z = state.unit.z;
  at.y = mesh.height(at.x, at.z);
  const t0 = performance.now();
  reachable(mesh, at, { budget: state.budget, areaCost }, reach);
  reachableOutline(reach, outline);
  state.ms = performance.now() - t0;
  state.maxMs = Math.max(state.maxMs, state.ms);
  state.queries++;
  state.polys = reach.count;
  state.outlineLoops = outline.loopCount;
  state.outlinePoints = outline.pointCount;
}

// --- Drawing ---

const sx = (x: number) => CX + x * PX;
const sz = (z: number) => CZ + z * PX;
const vert: NavPoint3 = { x: 0, y: 0, z: 0 };

function draw(): void {
  if (!g2) return;
  g2.fillStyle = '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  for (let p = 0; p < mesh.polyCount; p++) {
    const n = mesh.polyVertexCount(p);
    g2.beginPath();
    for (let k = 0; k < n; k++) {
      mesh.polyVertex(p, k, vert);
      if (k === 0) g2.moveTo(sx(vert.x), sz(vert.z));
      else g2.lineTo(sx(vert.x), sz(vert.z));
    }
    g2.closePath();
    const mud = mesh.area[p] === MUD_AREA;
    g2.fillStyle = reach.has(p) ? (mud ? '#4a6a5a' : '#2f5a80') : mud ? '#4a4228' : '#2a3a4a';
    g2.fill();
    g2.strokeStyle = '#3a4a5a';
    g2.lineWidth = 1;
    g2.stroke();
  }
  g2.fillStyle = '#8a7a6a';
  for (const [x, z, w, d] of BLOCKS)
    g2.fillRect(sx(x! - w! / 2), sz(z! - d! / 2), w! * PX, d! * PX);
  g2.strokeStyle = '#f0c040';
  g2.lineWidth = 2;
  for (let l = 0; l < outline.loopCount; l++) {
    const a = outline.loopStart[l]!;
    const b = outline.loopStart[l + 1]!;
    g2.beginPath();
    for (let i = a; i < b; i++) {
      const x = sx(outline.points[i * 3]!);
      const y = sz(outline.points[i * 3 + 2]!);
      if (i === a) g2.moveTo(x, y);
      else g2.lineTo(x, y);
    }
    g2.closePath();
    g2.stroke();
  }
  g2.fillStyle = '#60d080';
  g2.beginPath();
  g2.arc(sx(state.unit.x), sz(state.unit.z), 0.35 * PX, 0, Math.PI * 2);
  g2.fill();
  g2.fillStyle = '#dde';
  g2.font = '12px system-ui, sans-serif';
  g2.fillText(
    `range ${state.budget} polys ${state.polys}/${state.polyCount} loops ${state.outlineLoops} ${state.ms.toFixed(2)} ms`,
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

const api: HarnessNav5Api = {
  state,
  advance(steps) {
    for (let i = 0; i < steps; i++) step();
    draw();
  },
  setBudget(budget) {
    state.budget = budget;
  },
  moveUnit(x, z) {
    parked = true;
    state.unit.x = x;
    state.unit.z = z;
  },
};

step();
state.ready = true;
const tick = () => {
  if (!STILL) step();
  draw();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
window.__harnessNav5 = api;
