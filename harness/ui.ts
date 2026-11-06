/**
 * UI harness page (D-041 addendum 2): the engine's overlay with no WebGPU, so the specs in
 * e2e/ui.spec.ts can verify the UI platform layer on every matrix row. Noun-free.
 *
 * - The overlay with its frame letterboxed into the viewport, base widgets (a button, a caption,
 *   a field) on the frame's HUD layer and a design-px stylesheet passed through `scaleFontSizes`
 *   and `toFrameUnits`: the text-scale and text-min tokens, in frame or CSS units per form.
 * - `createDeviceMode` on the overlay root: `data-phone`, `data-touch`.
 * - `createRotateCard` with placeholder words.
 * - A non-modal menu driven by `menuNav` from a fake gamepad and the arrow keys.
 * - Two panel openers: one restores focus on close, one is marked `NO_RESTORE_FOCUS_ATTR`, so
 *   focus goes to the stack's home. Escape is a button key bound to `back`.
 *
 * Query modes (ws/ui-3; the plain page is the `ui` golden and stays as it is):
 * - `?tooltip`: three buttons with tooltips (top, bottom and an edge flip) and a world point.
 * - `?cursor` (`&mode=grid|targets`): an 8×8 grid of targets under a world cursor.
 * - `?loading` (`&stall` holds the bar at 0.4): a loading screen driven by a timer.
 * - `?notify`: a notification with an action.
 */
import { Input } from '@thunderclap/engine/input';
import { computeLetterbox, createDeviceMode } from '@thunderclap/engine/platform';
import { Camera } from '@thunderclap/engine/render';
import {
  applyTextScale,
  button,
  createOverlay,
  createRotateCard,
  h,
  type LoadingScreen,
  menuNav,
  NO_RESTORE_FOCUS_ATTR,
  scaleFontSizes,
  toFrameUnits,
  type WorldCursor,
  type WorldTarget,
} from '@thunderclap/engine/ui';
import type { HarnessUiApi, HarnessUiState } from './ui-state';

const DESIGN = { width: 1920, height: 1080 };
const root = document.getElementById('root') as HTMLElement;

const state: HarnessUiState = {
  ready: false,
  scale: 0,
  units: 'frame',
  phone: false,
  touch: false,
  rotate: false,
  menu: [],
  clicks: [],
  backs: 0,
  ticks: 0,
  tooltipVisible: false,
  tooltipPlacement: null,
  cursorCell: [0, 0],
  cursorTarget: null,
  loadingProgress: -1,
  notifications: 0,
  notifyActions: [],
};
const query = new URLSearchParams(location.search);

// A focusable stand-in for a game canvas: where focus goes when a panel closes with nowhere better.
const home = h('div', { id: 'home', tabindex: '-1', 'aria-label': 'Home' });
root.append(home);
const ui = createOverlay({ parent: root, focusHome: () => home });
const device = createDeviceMode(ui.root);

// A game stylesheet in design px: text follows the text scale, every px is a frame px.
document.head.append(
  h(
    'style',
    null,
    toFrameUnits(
      scaleFontSizes(`
.probe-text { position: absolute; left: 40px; top: 40px; font-size: 20px; color: #fff; }
.probe-title { position: absolute; left: 40px; top: 100px; font-size: 40px; color: #fff; }
.probe-menu { position: absolute; left: 40px; top: 260px; display: flex; flex-direction: column; gap: 16px; pointer-events: auto; }
.probe-panels { position: absolute; right: 40px; top: 260px; display: flex; flex-direction: column; gap: 16px; pointer-events: auto; }
.probe-tips { position: absolute; inset: 0; pointer-events: none; }
.probe-tips .tc-button { position: absolute; pointer-events: auto; }
.probe-cells { position: absolute; left: 560px; top: 140px; display: grid; grid-template-columns: repeat(8, 100px); grid-auto-rows: 100px; pointer-events: none; }
.probe-cell { box-sizing: border-box; border: 1px solid #555; }
`),
    ),
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
  ui.setFrame(r);
  device.setScale(ui.scale, r.x);
  state.scale = ui.scale;
  state.units = ui.units;
};
window.addEventListener('resize', layout);
layout();

// Anchors through a 2D camera over the design frame: 1 world unit = 1 design px.
const camera = Camera.ortho2d(DESIGN.width, DESIGN.height);
if (query.has('tooltip') || query.has('cursor')) ui.anchors(() => camera);

let cursor: WorldCursor | null = null;
let loading: LoadingScreen | null = null;

if (query.has('tooltip')) {
  const tips = h('div', { class: 'probe-tips' });
  const at = (id: string, label: string, left: number, top: number) => {
    const b = button(label, () => {});
    b.id = id;
    // Design px on the hud layer: times --tc-dpx.
    b.style.left = `calc(${left} * var(--tc-dpx))`;
    b.style.top = `calc(${top} * var(--tc-dpx))`;
    tips.append(b);
    return b;
  };
  const top = at('tip-top', 'Top', 900, 500);
  const bottom = at('tip-bottom', 'Bottom', 900, 620);
  const edge = at('tip-edge', 'Edge', 900, 20);
  ui.layers.hud.append(tips);
  ui.tooltip(top, 'Above the button', { placement: 'top', delay: 300 });
  ui.tooltip(bottom, 'Below the button', { placement: 'bottom', delay: 300 });
  // Asked for the top, but there is no room: it flips below.
  ui.tooltip(edge, 'Flipped below the edge', { placement: 'top', delay: 300 });
  // A world point at the frame's centre-left, shown at once.
  ui.tooltip([400, 540, 0], 'A world point', { placement: 'right' });
}

if (query.has('cursor')) {
  const mode = query.get('mode') === 'targets' ? 'targets' : 'grid';
  const cells = h('div', { class: 'probe-cells', 'aria-hidden': 'true' });
  const targets: WorldTarget[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      cells.append(h('div', { class: 'probe-cell' }));
      targets.push({
        id: `${col},${row}`,
        x: col,
        y: row,
        world: [610 + col * 100, 190 + row * 100, 0],
      });
    }
  }
  ui.layers.hud.append(cells);
  const cell = state.cursorCell;
  cursor = ui.cursor({
    mode,
    getGamepads: () => [pad],
    // A long repeat: the specs hold a press for a few ticks and expect exactly one step.
    repeat: { delay: 2000, interval: 2000 },
    step: (dx, dy) => {
      cell[0] = Math.max(0, Math.min(7, cell[0] + dx));
      cell[1] = Math.max(0, Math.min(7, cell[1] + dy));
    },
    at: () => [610 + cell[0] * 100, 190 + cell[1] * 100, 0],
    targets: () => targets,
    onMove: (t) => {
      state.cursorTarget = t ? String(t.id) : null;
    },
  });
  if (mode === 'targets') cursor.setTarget(targets[0] ?? null);
}

if (query.has('loading')) {
  loading = ui.loading({ title: 'Loading', tip: ['Tip one', 'Tip two'], tipInterval: 500 });
  state.loadingProgress = 0;
  const stall = query.has('stall');
  const timer = setInterval(() => {
    const next = Math.min(1, state.loadingProgress + 0.1);
    if (stall && next >= 0.4) {
      state.loadingProgress = 0.4;
      loading?.set(0.4);
      clearInterval(timer);
      return;
    }
    state.loadingProgress = next;
    loading?.set(next, `${Math.round(next * 100)}%`);
    if (next >= 1) {
      clearInterval(timer);
      void loading?.done().then(() => {
        state.loadingProgress = -1;
      });
    }
  }, 100);
}

if (query.has('notify')) {
  ui.notify({
    title: 'A notification',
    body: 'With one action.',
    icon: '!',
    tone: 'info',
    timeout: 0,
    actions: [{ label: 'Act', onClick: () => state.notifyActions.push('Act') }],
  });
  ui.notifications.focus();
}

const tick = () => {
  input.update();
  state.ticks++;
  if (!ui.stack.hasModal) {
    const r = menuNav(input, menu);
    if (r) state.menu.push(r);
  }
  if (input.pressed('back')) state.backs++;
  cursor?.update();
  ui.updateAnchors();
  state.phone = device.phone;
  state.touch = device.touch;
  state.rotate = rotate.visible;
  // The getters build their DOM on first use: only read them in the modes that made them.
  if (query.has('tooltip')) {
    const tip = ui.tooltips.active;
    state.tooltipVisible = tip?.visible ?? false;
    state.tooltipPlacement = tip?.placement ?? null;
  }
  if (query.has('notify')) state.notifications = ui.notifications.count;
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
  async finishLoading() {
    await loading?.done();
    state.loadingProgress = -1;
  },
};
window.__harnessUi = api;
state.ready = true;
