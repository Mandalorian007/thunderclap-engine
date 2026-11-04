/**
 * Gestures harness page (D-041 addendum 2): `Gestures` linked to an `Input`, with no WebGPU, so
 * e2e/gestures.spec.ts can drive it with real mouse and touch events on every matrix row.
 * Noun-free.
 *
 * - A 4:3 stage (800×600 logical) letterboxed into the viewport, so every landscape row has
 *   side bars: a point in a bar is outside the game rect (the transform returns `null`).
 * - The pointer target is the whole page; positions go through the stage's transform.
 * - Each gesture is bound to one action (`{ gesture }` bindings), and each tick's reports and
 *   action edges are logged.
 * - `magnify` is on over a grid of small cells drawn on a canvas in the stage (GRID, game
 *   space): cell (3, 2) is refused, so aiming at it snaps to a neighbour. Each tick's aim is
 *   logged, and whether the loupe element is shown.
 */
import { Gestures, Input, snapToGrid } from '../src/input';
import { computeLetterbox } from '../src/platform';
import type { GestureLogEntry, HarnessGesturesApi, HarnessGesturesState } from './gestures-state';

const LOGICAL = { width: 800, height: 600 };
const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;

/** The magnify grid (game space): 8 × 6 cells of 50, from (200, 150). Cell (3, 2) is refused. */
const GRID = { left: 200, top: 150, pitch: 50, cols: 8, rows: 6 };
const REFUSED = { x: 3, y: 2 };
const canvas = document.createElement('canvas');
canvas.width = LOGICAL.width;
canvas.height = LOGICAL.height;
Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
stage.append(canvas);
const g2 = canvas.getContext('2d');
if (g2) {
  for (let j = 0; j < GRID.rows; j++) {
    for (let i = 0; i < GRID.cols; i++) {
      const refused = i === REFUSED.x && j === REFUSED.y;
      g2.fillStyle = refused ? '#3a2020' : (i + j) % 2 ? '#2e3a52' : '#3b4a68';
      g2.fillRect(GRID.left + i * GRID.pitch + 2, GRID.top + j * GRID.pitch + 2, 46, 46);
    }
  }
}

const ACTIONS = ['select', 'zoom', 'info', 'scroll', 'grab', 'scale'] as const;
const state: HarnessGesturesState = {
  ready: false,
  ticks: 0,
  logical: LOGICAL,
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 0 },
  log: [],
  pressed: {},
  released: {},
  grid: { ...GRID, refused: REFUSED },
  aims: [],
  loupeShown: 0,
};

let blocked = false;
const gestures = new Gestures({
  magnify: {
    pitch: () => GRID.pitch * state.rect.scale,
    source: canvas,
    snap: (x, y) => {
      const c = snapToGrid(GRID, x, y, (i, j) => i !== REFUSED.x || j !== REFUSED.y);
      if (!c) return null;
      const p = GRID.pitch;
      return { x: GRID.left + (c.x + 0.5) * p, y: GRID.top + (c.y + 0.5) * p, r: p / 2, data: c };
    },
    over: (x, y) =>
      x >= GRID.left &&
      y >= GRID.top &&
      x <= GRID.left + GRID.cols * GRID.pitch &&
      y <= GRID.top + GRID.rows * GRID.pitch,
    toClient: (x, y) => ({
      x: state.rect.x + x * state.rect.scale,
      y: state.rect.y + y * state.rect.scale,
    }),
  },
});
const input = new Input(
  {
    select: [{ gesture: 'tap' }],
    zoom: [{ gesture: 'doubleTap' }],
    info: [{ gesture: 'longPress' }],
    scroll: [{ gesture: 'pan' }],
    grab: [{ gesture: 'drag' }],
    scale: [{ gesture: 'pinch' }],
  },
  { getGamepads: () => [], blocked: () => blocked, gestures },
);
input.setPointerTransform((cx, cy) => {
  const r = state.rect;
  if (r.scale <= 0) return null;
  const x = (cx - r.x) / r.scale;
  const y = (cy - r.y) / r.scale;
  return x >= 0 && y >= 0 && x <= LOGICAL.width && y <= LOGICAL.height ? { x, y } : null;
});
input.attach({ pointerTarget: root });

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

const log = (e: Omit<GestureLogEntry, 'tick'>) => {
  state.log.push({ ...e, tick: state.ticks });
};

const tick = () => {
  input.update();
  state.ticks++;
  for (const kind of ['tap', 'doubleTap', 'longPress'] as const) {
    const g = gestures[kind];
    if (g) log({ kind, ...g });
  }
  for (const kind of ['pan', 'drag'] as const) {
    const g = gestures[kind];
    if (g && !(g.phase === 'move' && g.dx === 0 && g.dy === 0)) log({ kind, ...g });
  }
  const aim = gestures.aim;
  if (aim) {
    const cell = (aim.target?.data as { x: number; y: number } | undefined) ?? null;
    state.aims.push({
      tick: state.ticks,
      x: aim.x,
      y: aim.y,
      lifted: aim.lifted,
      ended: aim.ended,
      loupe: aim.loupe,
      cell,
    });
  }
  if (gestures.loupeElement?.dataset.on !== undefined) state.loupeShown++;
  const p = gestures.pinch;
  if (p && !(p.phase === 'move' && p.delta === 1)) log({ kind: 'pinch', ...p });
  for (const a of ACTIONS) {
    if (input.pressed(a)) state.pressed[a] = (state.pressed[a] ?? 0) + 1;
    if (input.released(a)) state.released[a] = (state.released[a] ?? 0) + 1;
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const api: HarnessGesturesApi = {
  state,
  setBlocked(b) {
    blocked = b;
  },
  clear() {
    state.log = [];
    state.pressed = {};
    state.released = {};
    state.aims = [];
    state.loupeShown = 0;
  },
};
window.__harnessGestures = api;
state.ready = true;
