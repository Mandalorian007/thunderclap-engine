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
 */
import { Gestures, Input } from '../src/input';
import { computeLetterbox } from '../src/platform';
import type { GestureLogEntry, HarnessGesturesApi, HarnessGesturesState } from './gestures-state';

const LOGICAL = { width: 800, height: 600 };
const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;

const ACTIONS = ['select', 'zoom', 'info', 'scroll', 'grab', 'scale'] as const;
const state: HarnessGesturesState = {
  ready: false,
  ticks: 0,
  logical: LOGICAL,
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 0 },
  log: [],
  pressed: {},
  released: {},
};

let blocked = false;
const gestures = new Gestures();
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
  },
};
window.__harnessGestures = api;
state.ready = true;
