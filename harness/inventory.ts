/**
 * Inventory harness page (ws/ui-inventory): two grids, a slot strip, item cards, a radial menu
 * and a context list on the overlay over a dark 2D canvas, no WebGPU, so e2e/inventory.spec.ts
 * can drive them with a real pointer, keys and pad actions on every matrix row. Noun-free: the
 * items are tiles with letters.
 *
 * - A 6×4 grid at the left and a 2×3 grid at the right, which takes only `accent` items.
 * - A 4-slot `ui.slots` strip in the bottom region as a drop target (`slotsTarget`).
 * - A card on focus and hover; a radial through `?radial` or a long press on the canvas; a
 *   context list on the secondary button.
 * - `window.__harnessInventory` publishes the state, `pad(action)` and the radial's controls.
 */
import { computeLetterbox } from '@thunderclap/engine/platform';
import {
  type CellItem,
  createOverlay,
  type Grid,
  type GridCell,
  h,
  type PadAction,
  slotsTarget,
  toFrameUnits,
} from '@thunderclap/engine/ui';
import type {
  HarnessGridName,
  HarnessInventoryApi,
  HarnessInventoryState,
} from './inventory-state';

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

const state: HarnessInventoryState = {
  ready: false,
  ticks: 0,
  scale: 0,
  items: { backpack: [], equipment: [] },
  dragging: null,
  cardVisible: false,
  cardPlacement: null,
  radialActive: false,
  radialHighlighted: -1,
  contextOpen: false,
  focused: null,
  moves: [],
  picks: [],
  slots: [null, null, null, null],
  activated: null,
};

const ui = createOverlay({ parent: root });

document.head.append(
  h(
    'style',
    null,
    toFrameUnits(`
.inv-stage { position: absolute; left: 160px; top: 200px; display: flex; gap: 0; pointer-events: none; }
.inv-right { position: absolute; left: 1640px; top: 200px; pointer-events: none; }
.inv-title { font: 600 28px var(--tc-font-display); color: #e8ecf4; margin-bottom: 12px; }
`),
  ),
);

const describe = (item: CellItem) => ({
  title: item.label ?? item.id,
  subtitle: item.tone ? `${item.tone} tile` : 'plain tile',
  tone: item.tone,
  rows: [
    { label: 'Weight', value: String(item.id.length), compare: 'same' as const },
    { label: 'Count', value: String(item.count ?? 1), tone: item.tone },
  ],
  footer: item.locked ? 'Locked' : 'Drag to move',
});

const card = ui.card({ title: '', rows: [] });

function makeGrid(name: HarnessGridName, cols: number, rows: number, label: string): Grid {
  const g = ui.grid({
    cols,
    rows,
    label,
    cellSize: 72,
    gap: 6,
    card,
    describe,
    canDrop: name === 'equipment' ? (_from, _to, item) => item.tone === 'accent' : undefined,
    onMove: (from, to, item) => {
      state.moves.push(`${name}:${item.id}:${from.col},${from.row}>${to.col},${to.row}`);
      sync();
    },
    onFocus: (cell: GridCell) => {
      state.focused = { grid: name, col: cell.col, row: cell.row };
    },
    onActivate: (_cell, item) => {
      state.activated = item.id;
    },
    onContext: (_cell, item, anchor) => {
      context = ui.contextList(
        [
          { id: 'use', label: 'Use', hint: 'E' },
          { id: 'split', label: 'Split', disabled: (item.count ?? 1) < 2 },
          { id: 'drop', label: 'Drop', danger: true },
        ],
        {
          at: anchor,
          onPick: (id) => {
            state.picks.push(`context:${id}`);
            context = null;
          },
          onCancel: () => {
            context = null;
          },
        },
      );
    },
  });
  return g;
}

let context: { readonly open: boolean } | null = null;

const backpack = makeGrid('backpack', 6, 4, 'Backpack');
const equipment = makeGrid('equipment', 2, 3, 'Equipment');
ui.layers.hud.append(
  h(
    'div',
    { class: 'inv-stage' },
    h('div', null, h('div', { class: 'inv-title' }, 'Backpack'), backpack.element),
  ),
  h(
    'div',
    { class: 'inv-right' },
    h('div', { class: 'inv-title' }, 'Equipment'),
    equipment.element,
  ),
);

backpack.set({ col: 0, row: 0 }, { id: 'alpha', icon: 'A', label: 'Alpha', tone: 'accent' });
backpack.set({ col: 1, row: 0 }, { id: 'beta', icon: 'B', label: 'Beta', count: 5 });
backpack.set(
  { col: 2, row: 0 },
  { id: 'gamma', icon: 'G', label: 'Gamma', tone: 'info', span: { w: 2, h: 1 } },
);
backpack.set({ col: 5, row: 0 }, { id: 'delta', icon: 'D', label: 'Delta', tone: 'accent' });
backpack.set(
  { col: 0, row: 2 },
  { id: 'lock', icon: 'L', label: 'Locked', locked: true, tone: 'warn' },
);
backpack.set({ col: 5, row: 3 }, { id: 'omega', icon: 'O', label: 'Omega', tone: 'danger' });
equipment.set({ col: 0, row: 0 }, { id: 'ring', icon: 'R', label: 'Ring', tone: 'accent' });

const strip = ui.slots({ count: 4, hints: ['1', '2', '3', '4'], label: 'Quick slots' });
ui.drag.register(
  slotsTarget(strip, (index, item) => {
    strip.setContent(index, item.icon as string);
    state.slots[index] = item.id;
  }),
);

const radial = ui.radial({
  // Sector 0 sits east and the rest follow clockwise, 60 degrees apart.
  items: ['one', 'two', 'three', 'four', 'five', 'six'].map((id, i) => ({
    id,
    icon: String(i + 1),
    label: id[0]!.toUpperCase() + id.slice(1),
  })),
  onPick: (id) => {
    state.picks.push(`radial:${id}`);
  },
});

// A long press on the canvas opens the radial at the press.
let press: ReturnType<typeof setTimeout> | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (press !== null) clearTimeout(press);
  press = setTimeout(() => {
    press = null;
    radial.open({ x: e.clientX, y: e.clientY });
  }, 400);
});
const endPress = () => {
  if (press !== null) clearTimeout(press);
  press = null;
};
canvas.addEventListener('pointerup', endPress);
canvas.addEventListener('pointercancel', endPress);
if (new URLSearchParams(location.search).has('radial')) radial.open();

function sync(): void {
  state.items.backpack = backpack.items.map((e) => `${e.item.id}@${e.col},${e.row}`);
  state.items.equipment = equipment.items.map((e) => `${e.item.id}@${e.col},${e.row}`);
}
sync();

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

const tick = () => {
  state.ticks++;
  state.dragging = ui.drag.dragging?.item.id ?? null;
  state.cardVisible = card.visible;
  state.cardPlacement = card.placement;
  state.radialActive = radial.visible;
  state.radialHighlighted = radial.highlighted;
  state.contextOpen = context?.open ?? false;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const grids: Record<HarnessGridName, Grid> = { backpack, equipment };
const api: HarnessInventoryApi = {
  state,
  pad(action: PadAction) {
    const g = state.focused ? grids[state.focused.grid] : backpack;
    return g.act(action);
  },
  radial: {
    open: () => radial.open(),
    close: () => radial.close(),
    aim: (x, y) => radial.aim(x, y),
    pick: () => radial.pick(),
  },
  focus(grid, col, row) {
    grids[grid].focus({ col, row });
  },
};
window.__harnessInventory = api;
state.ready = true;
