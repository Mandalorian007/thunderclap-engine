/**
 * Widgets harness page (ws/ui-widgets, D-041 addendum 2): the second widget set on the overlay's
 * HUD layer over a dark 2D canvas, no WebGPU, so e2e/widgets.spec.ts can drive each widget with
 * real keys on every matrix row. Noun-free.
 *
 * - The overlay's frame (16:9) letterboxed into the viewport; the canvas fills the frame.
 * - A reticle centred on the frame; a column of every other widget once: a segmented bar, a
 *   segmented choice, a select, a key prompt, a stepper and a cooldown.
 * - The cooldown sweeps from the frame counter until the spec sets it.
 * - `window.__harnessWidgets` publishes the values and a `set` per widget.
 */
import { computeLetterbox } from '@thunderclap-engine/engine/platform';
import {
  bar,
  cooldown,
  createOverlay,
  h,
  keyPrompt,
  reticle,
  segmented,
  select,
  stepper,
  toFrameUnits,
} from '@thunderclap-engine/engine/ui';
import type { HarnessWidgetsApi, HarnessWidgetsState } from './widgets-state';

const DESIGN = { width: 1920, height: 1080 };
const root = document.getElementById('root') as HTMLElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
canvas.width = 192;
canvas.height = 108;
const g2 = canvas.getContext('2d');
if (g2) {
  g2.fillStyle = '#141a26';
  g2.fillRect(0, 0, canvas.width, canvas.height);
  g2.fillStyle = '#1c2436';
  for (let i = 0; i < 12; i++) g2.fillRect(i * 16 + (i % 2) * 8, 54 + (i % 3) * 12, 8, 8);
}

const state: HarnessWidgetsState = {
  ready: false,
  ticks: 0,
  scale: 0,
  bar: 60,
  segment: 'mid',
  stepper: 3,
  select: 'b',
  cooldownReady: false,
  reticleSpread: 0,
  changes: [],
};

const ui = createOverlay({ parent: root });

document.head.append(
  h(
    'style',
    null,
    toFrameUnits(`
.probe-col { position: absolute; left: 80px; top: 80px; display: flex; flex-direction: column; align-items: flex-start; gap: 24px; pointer-events: auto; }
.probe-row { display: flex; align-items: center; gap: 24px; }
`),
  ),
);

const ret = reticle({ size: 56, gap: 8 });
const health = bar('Bar', state.bar, { min: 0, max: 100, segments: 5, tone: 'danger' });
const seg = segmented(
  'Segment',
  [
    { value: 'low', label: 'Low' },
    { value: 'mid', label: 'Mid' },
    { value: 'high', label: 'High' },
  ],
  state.segment,
  (v) => {
    state.segment = v;
    state.changes.push(`segment:${v}`);
  },
);
const sel = select(
  'Select',
  [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ],
  state.select,
  (v) => {
    state.select = v;
    state.changes.push(`select:${v}`);
  },
);
const prompt = keyPrompt('Prompt', { key: 'E', pad: 'Ⓐ' });
const step = stepper(
  'Stepper',
  state.stepper,
  (v) => {
    state.stepper = v;
    state.changes.push(`stepper:${v}`);
  },
  { min: 0, max: 10, step: 1 },
);
const cd = cooldown({ size: 72 });

ui.layers.hud.append(
  ret.element,
  h(
    'div',
    { class: 'probe-col' },
    health.element,
    seg.element,
    sel.element,
    h('div', { class: 'probe-row' }, prompt.element, cd.element),
    step.element,
  ),
);

const layout = () => {
  const r = computeLetterbox(root.clientWidth, root.clientHeight, DESIGN.width, DESIGN.height);
  Object.assign(canvas.style, {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  ui.setFrame({ x: r.x, y: r.y, width: r.width, height: r.height });
  state.scale = ui.scale;
};
window.addEventListener('resize', layout);
layout();

/** The cooldown follows the frame counter until the spec sets it. */
let sweeping = true;
const tick = () => {
  state.ticks++;
  if (sweeping) cd.set((state.ticks % 240) / 200);
  state.cooldownReady = cd.ready;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const api: HarnessWidgetsApi = {
  state,
  set: {
    bar(v) {
      health.set(v);
      state.bar = v;
    },
    segment(v) {
      seg.set(v);
      state.segment = seg.value;
    },
    stepper(v) {
      step.set(v);
      state.stepper = step.value;
    },
    select(v) {
      sel.set(v);
      state.select = sel.select.value;
    },
    cooldown(f) {
      sweeping = false;
      cd.set(f);
      state.cooldownReady = cd.ready;
    },
    reticle(s) {
      ret.set(s);
      state.reticleSpread = s;
    },
    key(k, pad) {
      prompt.set(k, pad);
    },
  },
  hit() {
    ret.hit();
  },
};
window.__harnessWidgets = api;
state.ready = true;
