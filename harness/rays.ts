/**
 * Rays harness page: the pointer router (`createPointerRouter`) linked to an `Input`, with no
 * WebGPU, so e2e/rays.spec.ts can aim at things with real mouse and touch events, and with the pad
 * cursor, on every matrix row. Noun-free.
 *
 * - A 4:3 stage (800×600 logical) letterboxed into the viewport; the pointer transform maps
 *   client px to logical px, which is the camera's `screen`.
 * - `?mode=ortho` (default): `Camera.ortho2d(800, 600)` over four flat quads (`aabbTester`) and
 *   the plane z = 0 (`planeTester`) under them.
 * - `?mode=persp`: a perspective camera over four boxes, one behind another.
 * - Hovered boxes are lit (`hit`/`hitEnd`), `select` toggles a box. `select` is one action bound
 *   to `{ pointer: 'select' }` and Enter, so mouse, touch, the pad cursor and a key all select.
 * - The pad is a fake gamepad the spec sets (`setPad`); its left stick moves the pad cursor.
 */
import {
  aabbTester,
  createPointerRouter,
  type GamepadLike,
  Input,
  PadCursor,
  planeTester,
  type RayBox,
} from '@thunderclap/engine/input';
import { computeLetterbox } from '@thunderclap/engine/platform';
import { Camera } from '@thunderclap/engine/render';
import type { HarnessRaysApi, HarnessRaysState } from './rays-state';

const LOGICAL = { width: 800, height: 600 };
const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const mode = new URLSearchParams(location.search).get('mode') === 'persp' ? 'persp' : 'ortho';

const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
stage.append(canvas);
const g2 = canvas.getContext('2d');

type V3 = [number, number, number];
const box = (id: string, min: V3, max: V3): RayBox<string> => ({ min, max, target: id });

let camera: Camera;
let boxes: RayBox<string>[];
if (mode === 'ortho') {
  camera = Camera.ortho2d(LOGICAL.width, LOGICAL.height);
  boxes = [
    box('a', [100, 100, 0], [250, 250, 0]),
    box('b', [450, 100, 0], [700, 250, 0]),
    box('c', [100, 350, 0], [250, 500, 0]),
    box('d', [450, 350, 0], [700, 500, 0]),
  ];
} else {
  camera = Camera.perspective(Math.PI / 4, LOGICAL.width / LOGICAL.height, 0.1, 100);
  camera.lookAt([0, 3, 12], [0, 0, 0]);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  boxes = [
    box('a', [-4.5, -1, -1], [-2.5, 1, 1]),
    box('b', [-1, -1, -1], [1, 1, 1]),
    box('c', [2.5, -1, -1], [4.5, 1, 1]),
    // Behind b, bigger: only its edges show around b.
    box('d', [-2, -2, -8], [2, 2, -6]),
  ];
}

const state: HarnessRaysState = {
  ready: false,
  ticks: 0,
  mode,
  logical: LOGICAL,
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 0 },
  boxes: [],
  hovered: [],
  selected: [],
  log: [],
  cursor: null,
  selectPresses: 0,
};

let blocked = false;
let pad: GamepadLike = { axes: [0, 0], buttons: [] };
const cursor = new PadCursor({ getGamepads: () => [pad] });
const router = createPointerRouter<string | null>({
  camera,
  testers: mode === 'ortho' ? [aabbTester(boxes), planeTester(0, null)] : [aabbTester(boxes)],
  sources: [cursor],
});
const input = new Input(
  { select: [{ pointer: 'select' }, { key: 'Enter' }] },
  { getGamepads: () => [], blocked: () => blocked, pointers: router },
);
input.setPointerTransform((cx, cy) => {
  const r = state.rect;
  if (r.scale <= 0) return null;
  const x = (cx - r.x) / r.scale;
  const y = (cy - r.y) / r.scale;
  return x >= 0 && y >= 0 && x <= LOGICAL.width && y <= LOGICAL.height ? { x, y } : null;
});
input.attach({ pointerTarget: root });

/** Pointers per hovered box (two touches can be on one box). */
const hoverCount = new Map<string, number>();
const log = (kind: HarnessRaysState['log'][number]['kind']) => {
  router.on(kind, (e) => {
    state.log.push({
      kind,
      tick: state.ticks,
      device: e.pointer.device,
      target: e.hit?.target ?? null,
    });
  });
};
log('hit');
log('hitEnd');
log('select');
log('secondary');
router.on('hit', (e) => {
  const id = e.hit?.target;
  if (id) hoverCount.set(id, (hoverCount.get(id) ?? 0) + 1);
});
router.on('hitEnd', (e) => {
  const id = e.hit?.target;
  if (!id) return;
  const n = (hoverCount.get(id) ?? 1) - 1;
  if (n > 0) hoverCount.set(id, n);
  else hoverCount.delete(id);
});
router.on('select', (e) => {
  const id = e.hit?.target;
  if (!id) return;
  const i = state.selected.indexOf(id);
  if (i >= 0) state.selected.splice(i, 1);
  else state.selected.push(id);
});

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

// Box centres on screen: the centre of the face nearest the camera (+z).
const p = { x: 0, y: 0, z: 0 };
state.boxes = boxes.map((b) => {
  camera.worldToScreen((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2], p);
  return { id: b.target, x: p.x, y: p.y };
});

/** The 6 faces of a box as corner index lists (corner bit 0 = x max, 1 = y max, 2 = z max). */
const FACES = [
  [0, 2, 6, 4],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 1, 3, 2],
  [4, 5, 7, 6],
];

function draw(): void {
  if (!g2) return;
  g2.fillStyle = '#1d2330';
  g2.fillRect(0, 0, LOGICAL.width, LOGICAL.height);
  const faces: { d: number; pts: { x: number; y: number }[]; fill: string }[] = [];
  for (const b of boxes) {
    const id = b.target;
    const lit = hoverCount.has(id);
    const on = state.selected.includes(id);
    const fill = on ? (lit ? '#f0c060' : '#c08a30') : lit ? '#6a88c0' : '#3b4a68';
    const corners = Array.from({ length: 8 }, (_, i) => {
      const q = { x: 0, y: 0, z: 0 };
      camera.worldToScreen(
        i & 1 ? b.max[0] : b.min[0],
        i & 2 ? b.max[1] : b.min[1],
        i & 4 ? b.max[2] : b.min[2],
        q,
      );
      return q;
    });
    for (const f of FACES) {
      const pts = f.map((i) => corners[i]!);
      faces.push({ d: pts.reduce((s, q) => s + q.z, 0) / 4, pts, fill });
    }
  }
  // Painter's order: far faces first.
  faces.sort((a, b) => b.d - a.d);
  for (const f of faces) {
    g2.beginPath();
    for (const [i, q] of f.pts.entries()) {
      if (i) g2.lineTo(q.x, q.y);
      else g2.moveTo(q.x, q.y);
    }
    g2.closePath();
    g2.fillStyle = f.fill;
    g2.fill();
    g2.strokeStyle = '#0d1018';
    g2.stroke();
  }
  if (state.cursor) {
    g2.strokeStyle = '#ffffff';
    g2.beginPath();
    g2.arc(state.cursor.x, state.cursor.y, 8, 0, Math.PI * 2);
    g2.stroke();
  }
}

const tick = () => {
  input.update();
  state.ticks++;
  if (input.pressed('select')) state.selectPresses++;
  state.hovered = [...hoverCount.keys()].sort();
  state.cursor = cursor.active ? { x: cursor.x, y: cursor.y } : null;
  draw();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const api: HarnessRaysApi = {
  state,
  setBlocked(b) {
    blocked = b;
  },
  setPad(axes, pressed) {
    pad = {
      axes,
      buttons: Array.from({ length: 4 }, (_, i) => ({
        pressed: pressed.includes(i),
        value: pressed.includes(i) ? 1 : 0,
      })),
    };
  },
  cursorTo(x, y) {
    cursor.moveTo(x, y);
  },
  clear() {
    state.log = [];
    state.selected = [];
    state.selectPresses = 0;
  },
};
window.__harnessRays = api;
state.ready = true;
