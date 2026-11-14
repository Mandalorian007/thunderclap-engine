/**
 * Quality harness page (ws/intents-quality): `detectTier` on this device and a `createGovernor`
 * stepping two knobs (dynamic resolution, then a toggle) under a synthetic GPU load, with no
 * WebGPU. Each animation frame feeds the governor one synthetic second of 60 Hz frames on its own
 * clock, so the trace is the same on a loaded machine: a frame whose GPU cost (load × scale²)
 * passes 16.7 ms misses a vsync. Noun-free.
 */

import {
  createGovernor,
  detectTier,
  dynamicResolutionKnob,
  readDevice,
  toggleKnob,
} from '@thunderclap-engine/engine/quality';
import { DynamicResolution } from '@thunderclap-engine/engine/render';
import type { HarnessQualityApi, HarnessQualityState } from './quality-state';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const choice = detectTier(readDevice());
const dr = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
let glowShed = false;
const governor = createGovernor({
  rungs: [
    dynamicResolutionKnob(dr, { cost: 1 }),
    toggleKnob('glow', (shed) => (glowShed = shed), 2),
  ],
});

const state: HarnessQualityState = {
  ready: false,
  seconds: 0,
  tier: choice.tier,
  reason: choice.reason,
  shed: 0,
  line: governor.line,
  scale: dr.scale,
  glowShed,
  changes: [],
};
$('tier').textContent = choice.tier;
$('reason').textContent = choice.reason;

let load = 8;
const FRAME = 1000 / 60;
let t = 0;
let i = 0;

const second = () => {
  for (let k = 0; k < 60; k++) {
    const gpu = load * dr.scale * dr.scale * (glowShed ? 0.9 : 1);
    const interval = gpu > FRAME ? 2 * FRAME : FRAME;
    t += interval;
    const c = governor.frame(t, interval, 2, i++ % 8 === 0 ? gpu : null);
    if (c) state.changes.push({ at: Math.round(c.at), knob: c.knob, dir: c.dir, shed: c.shed });
  }
  state.seconds++;
  state.shed = governor.shed;
  state.line = governor.line;
  state.scale = Math.round(dr.scale * 100) / 100;
  state.glowShed = glowShed;
};

const draw = () => {
  $('sec').textContent = `${state.seconds} s`;
  $('scale').textContent = state.scale.toFixed(2);
  $('fill').style.width = `${state.scale * 100}%`;
  $('line').textContent = state.line;
  const ladder = $('ladder');
  ladder.replaceChildren(
    ...governor.knobs.map((k) => {
      const el = document.createElement('span');
      el.className = 'rung';
      const n = governor.stack.filter((s) => s === k).length;
      el.textContent = n > 1 ? `${k.name} ×${n}` : k.name;
      if (n > 0) el.dataset.shed = '';
      return el;
    }),
  );
};

const frame = () => {
  second();
  draw();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

$('light').addEventListener('click', () => api.setLoad(8));
$('heavy').addEventListener('click', () => api.setLoad(30));

const api: HarnessQualityApi = {
  state,
  setLoad(ms) {
    load = ms;
  },
};
window.__harnessQuality = api;
state.ready = true;
