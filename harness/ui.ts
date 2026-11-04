/**
 * UI harness page (D-041 addendum 2): the engine's overlay with no WebGPU, so the specs in
 * e2e/ui.spec.ts can verify the UI platform layer on every matrix row. Noun-free.
 *
 * - A scaled overlay letterboxed into the viewport, with base widgets (a button, a caption, a
 *   field) and a stylesheet passed through `scaleFontSizes`: the text-scale and text-min tokens.
 * - `createDeviceMode` on the overlay root: `data-phone`, `data-touch`.
 * - `createRotateCard` with placeholder words.
 * - A non-modal menu driven by `menuNav` from a fake gamepad and the arrow keys.
 * - Two panel openers: one restores focus on close, one is marked `NO_RESTORE_FOCUS_ATTR`, so
 *   focus goes to the stack's home. Escape is a button key bound to `back`.
 */
import { Input } from '../src/input';
import { computeLetterbox, createDeviceMode } from '../src/platform';
import {
  applyTextScale,
  button,
  createOverlay,
  createRotateCard,
  h,
  menuNav,
  NO_RESTORE_FOCUS_ATTR,
  scaleFontSizes,
} from '../src/ui';
import type { HarnessUiApi, HarnessUiState } from './ui-state';

const DESIGN = { width: 1920, height: 1080 };
const root = document.getElementById('root') as HTMLElement;

const state: HarnessUiState = {
  ready: false,
  scale: 0,
  phone: false,
  touch: false,
  rotate: false,
  menu: [],
  clicks: [],
  backs: 0,
  ticks: 0,
};

// A focusable stand-in for a game canvas: where focus goes when a panel closes with nowhere better.
const home = h('div', { id: 'home', tabindex: '-1', 'aria-label': 'Home' });
root.append(home);
const ui = createOverlay({ parent: root, focusHome: () => home });
const device = createDeviceMode(ui.root);

// A game stylesheet: passes through scaleFontSizes like every game sheet does.
document.head.append(
  h(
    'style',
    null,
    scaleFontSizes(`
.probe-text { position: absolute; left: 40px; top: 40px; font-size: 20px; color: #fff; }
.probe-title { position: absolute; left: 40px; top: 100px; font-size: 40px; color: #fff; }
.probe-menu { position: absolute; left: 40px; top: 260px; display: flex; flex-direction: column; gap: 16px; pointer-events: auto; }
.probe-panels { position: absolute; right: 40px; top: 260px; display: flex; flex-direction: column; gap: 16px; pointer-events: auto; }
`),
  ),
);

const menu = h('nav', { class: 'probe-menu', 'aria-label': 'Menu' });
for (const label of ['First', 'Second', 'Third']) {
  menu.append(button(label, () => state.clicks.push(label)));
}
const openPanel = () => {
  ui.stack.push({
    title: 'Panel',
    content: h(
      'div',
      null,
      button('Inside', () => {}),
      button('Also inside', () => {}),
    ),
  });
};
const restoring = button('Open panel', openPanel);
restoring.id = 'open-panel';
const hudBar = h('div', { [NO_RESTORE_FOCUS_ATTR]: '' });
const homing = button('Open from HUD', openPanel);
homing.id = 'open-hud';
hudBar.append(homing);
ui.layers.hud.append(
  h('p', { class: 'probe-text', id: 'probe-text' }, 'Body text'),
  h('p', { class: 'probe-title', id: 'probe-title' }, 'Display text'),
  menu,
  h('div', { class: 'probe-panels' }, restoring, hudBar),
);
ui.caption.say('A caption line.', { speaker: 'Speaker' });

const rotate = createRotateCard({
  title: 'Rotate your device',
  lines: ['This page plays in landscape.'],
  note: { tag: 'NOTE', text: 'A note line.' },
  device,
});

// A fake standard-mapping gamepad the specs press through `pad()`.
const padButtons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
const pad = { connected: true, buttons: padButtons, axes: [0, 0, 0, 0] };
const input = new Input(
  {
    up: [{ key: 'ArrowUp' }, { padButton: 12 }],
    down: [{ key: 'ArrowDown' }, { padButton: 13 }],
    confirm: [{ key: 'Enter' }, { padButton: 0 }],
    back: [{ key: 'Escape' }, { padButton: 1 }],
  },
  {
    getGamepads: () => [pad],
    blocked: () => ui.stack.hasModal,
    buttonKeys: ['Escape', 'ArrowUp', 'ArrowDown'],
  },
);
input.attach({ pointerTarget: home, disableTouchScroll: false });

const layout = () => {
  const r = computeLetterbox(root.clientWidth, root.clientHeight, DESIGN.width, DESIGN.height);
  ui.setRect(r);
  device.setScale(ui.scale, r.x);
  state.scale = ui.scale;
};
window.addEventListener('resize', layout);
layout();

const tick = () => {
  input.update();
  state.ticks++;
  if (!ui.stack.hasModal) {
    const r = menuNav(input, menu);
    if (r) state.menu.push(r);
  }
  if (input.pressed('back')) state.backs++;
  state.phone = device.phone;
  state.touch = device.touch;
  state.rotate = rotate.visible;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const api: HarnessUiApi = {
  state,
  setTextScale(s) {
    applyTextScale(ui.root, s, (t) => ui.setTheme(t));
  },
  pad(i, pressed) {
    const b = padButtons[i];
    if (b) {
      b.pressed = pressed;
      b.value = pressed ? 1 : 0;
    }
  },
};
window.__harnessUi = api;
state.ready = true;
