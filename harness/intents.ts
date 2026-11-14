/**
 * Intents harness page (ws/intents-quality): `createIntents` over an `Input`, no WebGPU, so
 * e2e/intents-quality.spec.ts drives it with real mouse, key and touch events on every matrix row.
 * Noun-free.
 *
 * - An 800×600 stage letterboxed into the viewport; client points go through its transform.
 * - A camera whose ray through a screen point starts at that point (x, y, 0) and runs along +z, so
 *   an aim's origin is its screen point.
 * - Intents: `use` (a tap: KeyE, the left button, a still finger), `act` (a hold: KeyF, a
 *   still finger held), `gather` (a stick-side hold: a thumb held still in the stick's top half),
 *   `jump` (a press: Space), `slot` (select: Digit1..3), `cycle` (KeyQ / KeyR and the wheel) and
 *   `look` (the view's aim). The left half of the stage is the move stick's zone.
 * - The intents' clock can be pinned (`setClock`) so the spec decides how long a press lasts.
 */
import {
  createIntents,
  Input,
  type IntentAim,
  type RayCamera,
  stickSideHold,
} from '@thunderclap-engine/engine/input';
import { computeLetterbox } from '@thunderclap-engine/engine/platform';
import type { HarnessIntentsApi, HarnessIntentsState, IntentLogEntry } from './intents-state';

const LOGICAL = { width: 800, height: 600 };
const root = document.getElementById('root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const dot = document.getElementById('dot') as HTMLElement;
const out = document.getElementById('out') as HTMLElement;

const state: HarnessIntentsState = {
  ready: false,
  ticks: 0,
  logical: LOGICAL,
  log: [],
  holding: null,
  aim: null,
};
let rect = { x: 0, y: 0, width: 0, height: 0, scale: 0 };
let clockMs: number | null = null;
let centred = false;
const now = () => clockMs ?? performance.now();

const input = new Input(
  {
    use: [{ key: 'KeyE' }, { mouse: 0 }],
    act: [{ key: 'KeyF' }],
    jump: [{ key: 'Space' }],
    s1: [{ key: 'Digit1' }],
    s2: [{ key: 'Digit2' }],
    s3: [{ key: 'Digit3' }],
    next: [{ key: 'KeyR' }],
    prev: [{ key: 'KeyQ' }],
  },
  { getGamepads: () => [] },
);
const toGame = (cx: number, cy: number) => {
  if (rect.scale <= 0) return null;
  const x = (cx - rect.x) / rect.scale;
  const y = (cy - rect.y) / rect.scale;
  return x >= 0 && y >= 0 && x <= LOGICAL.width && y <= LOGICAL.height ? { x, y } : null;
};
input.setPointerTransform(toGame);
input.attach({ pointerTarget: root });

/** The ray through (sx, sy) starts at (sx, sy, 0) and runs along +z. */
const camera = {
  screen: { width: LOGICAL.width, height: LOGICAL.height },
  screenToWorld(sx: number, sy: number, depth: number, o: { x: number; y: number; z: number }) {
    o.x = sx;
    o.y = sy;
    o.z = depth;
    return o;
  },
} as unknown as RayCamera;

const push = (intent: string, aim: IntentAim, extra: Partial<IntentLogEntry> = {}) => {
  const e: IntentLogEntry = { intent, tick: state.ticks, ...extra };
  if (aim === null) e.centre = true;
  else {
    e.x = Math.round(aim.origin[0]);
    e.y = Math.round(aim.origin[1]);
  }
  state.log.push(e);
};
const hold = (name: string) => ({
  start: (aim: IntentAim, at: number) => push(name, aim, { phase: 'start', at }),
  aim: (aim: IntentAim) => push(name, aim, { phase: 'aim' }),
  end: () => state.log.push({ intent: name, phase: 'end', tick: state.ticks }),
});

const intents = createIntents(
  {
    use: { kind: 'tap', actions: ['use'] },
    act: { kind: 'hold', actions: ['act'] },
    gather: {
      kind: 'hold',
      touch: false,
      // The thumb may hold where it landed in the stick's top half.
      stickSide: stickSideHold<IntentAim>({ when: (aim) => aim !== null && aim.origin[1] < 300 }),
    },
    jump: { kind: 'press', actions: ['jump'] },
    slot: { kind: 'select', actions: ['s1', 's2', 's3'] },
    cycle: { kind: 'cycle', next: ['next'], prev: ['prev'], wheel: true },
    look: { kind: 'aim' },
  },
  {
    use: (aim) => push('use', aim),
    act: hold('act'),
    gather: hold('gather'),
    jump: (aim) => push('jump', aim),
    slot: (n) => state.log.push({ intent: 'slot', n, tick: state.ticks }),
    cycle: (n) => state.log.push({ intent: 'cycle', n, tick: state.ticks }),
    look: () => {},
  },
  {
    input,
    camera,
    now,
    centred: () => centred,
    stickZone: 'left',
    toScreen: toGame,
  },
);

const layout = () => {
  const r = computeLetterbox(root.clientWidth, root.clientHeight, LOGICAL.width, LOGICAL.height);
  rect = { ...r };
  Object.assign(stage.style, {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
};
window.addEventListener('resize', layout);
layout();

const tick = () => {
  input.update();
  intents.update();
  state.ticks++;
  state.holding = intents.holding;
  const a = intents.aim;
  state.aim = a ? [Math.round(a.origin[0]), Math.round(a.origin[1])] : null;
  if (a) {
    dot.style.display = 'block';
    dot.style.left = `${(a.origin[0] / LOGICAL.width) * 100}%`;
    dot.style.top = `${(a.origin[1] / LOGICAL.height) * 100}%`;
  } else dot.style.display = 'none';
  out.textContent = state.log
    .slice(-12)
    .map(
      (e) =>
        `${e.intent}${e.phase ? `.${e.phase}` : ''} ${e.centre ? 'centre' : e.x !== undefined ? `${e.x},${e.y}` : (e.n ?? '')}`,
    )
    .join('\n');
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const api: HarnessIntentsApi = {
  state,
  setClock(ms) {
    clockMs = ms;
  },
  setCentred(on) {
    centred = on;
  },
  clear() {
    state.log = [];
  },
};
window.__harnessIntents = api;
state.ready = true;
