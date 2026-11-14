/**
 * UI spec harness page (ws/ui-spec): a small RPG HUD written as data and driven from models,
 * drawn by the DOM presenter in today's overlay layout. Noun-free engine; the words are the page's.
 * No WebGPU.
 *
 * - `vitals` (left region): health and mana bars (`meter`, tinted, with a value text) that drift
 *   on a timer until parked.
 * - `hotbar` (bottom region): six slots with key labels 1–6; a tap or a number key selects one.
 * - `quests` (right region): a list of quests; a done quest moves to the end and dims.
 * - `talk`: a dialog opened on the overlay's stack (`presentModal`); accepting adds a quest.
 *
 * Every frame applies the HUD; while parked nothing changes, so an idle frame writes nothing
 * (`state.writes` holds still), which e2e/ui-spec.spec.ts checks.
 */
import {
  b,
  createOverlay,
  hud,
  type PanelEvent,
  type PanelSpec,
  panel,
  presentHud,
  presentModal,
  type SpecModal,
  type SpecNode,
  theme,
} from '@thunderclap-engine/engine/ui';
import type { HarnessUiSpecApi, HarnessUiSpecState } from './ui-spec-state';

const root = document.getElementById('root') as HTMLElement;
const SLOTS = 6;
const ITEMS = ['Sword', 'Bow', 'Potion', '', 'Torch', 'Map'];
const COUNTS = [1, 1, 5, 0, 12, 1];

const look = theme({
  surface: 'rgba(8, 20, 30, 0.72)',
  surfaceAlt: 'rgba(18, 40, 56, 0.9)',
  surfaceOn: 'rgba(30, 90, 110, 0.95)',
  border: 'rgba(110, 210, 230, 0.4)',
  text: '#e4f4f8',
  textMuted: '#8fb3bd',
  accent: '#5fd3e6',
  accentText: '#06202a',
  focus: '#a8f0ff',
  radius: 4,
  shadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
});

const bar = (id: string, label: string): SpecNode => ({
  k: 'row',
  gap: 8,
  align: 'center',
  children: [
    { k: 'text', text: label, style: 'label', w: 56 },
    {
      k: 'meter',
      id,
      value: b(id),
      valueText: b(`${id}.text`),
      tint: b(`${id}.tint`),
      label,
      w: 180,
      h: 14,
    },
    { k: 'text', text: b(`${id}.text`), style: 'count', w: 64, textAlign: 'end' },
  ],
});

const VITALS: PanelSpec = {
  id: 'vitals',
  body: {
    k: 'col',
    gap: 6,
    pad: 10,
    cls: 'tcs-surface',
    children: [bar('hp', 'Health'), bar('mp', 'Mana')],
  },
};

const HOTBAR: PanelSpec = {
  id: 'hotbar',
  body: {
    k: 'row',
    gap: 6,
    pad: 8,
    cls: 'tcs-surface',
    role: 'toolbar',
    children: Array.from(
      { length: SLOTS },
      (_, i): SpecNode => ({
        k: 'slot',
        id: `hot.${i}`,
        item: b(`hot.${i}.item`),
        count: b(`hot.${i}.count`),
        state: b(`hot.${i}.state`),
        keyLabel: String(i + 1),
        size: 48,
      }),
    ),
  },
};

const QUESTS: PanelSpec = {
  id: 'quests',
  body: {
    k: 'col',
    gap: 6,
    pad: 10,
    w: 260,
    cls: 'tcs-surface',
    children: [
      { k: 'text', text: 'Quests', style: 'head' },
      { k: 'text', text: b('quests.empty'), style: 'note', show: b('quests.none') },
      {
        k: 'list',
        id: 'quests',
        rowH: 40,
        gap: 4,
        h: 150,
        tail: true,
        row: {
          k: 'col',
          state: b('row.state'),
          children: [
            { k: 'text', text: b('row.title'), style: 'body' },
            { k: 'text', text: b('row.step'), style: 'note' },
          ],
        },
      },
    ],
  },
};

const TALK: PanelSpec = {
  id: 'talk',
  body: {
    k: 'col',
    gap: 12,
    pad: 4,
    w: 420,
    children: [
      { k: 'text', text: b('who'), style: 'title' },
      { k: 'text', text: b('line'), style: 'body', wrap: true, marked: true },
      {
        k: 'row',
        gap: 8,
        align: 'end',
        children: [
          { k: 'button', id: 'decline', text: 'Not now', w: 120, h: 44 },
          { k: 'button', id: 'accept', text: 'I will', w: 120, h: 44 },
        ],
      },
    ],
  },
};

// The overlay in CSS px on every form, its layout's regions over the viewport.
const ui = createOverlay({
  parent: root,
  caption: { reducedMotion: true },
  layout: { forms: { desktop: { units: 'css' }, tablet: { units: 'css' } } },
});
ui.setFrame({ x: 0, y: 0, width: root.clientWidth, height: root.clientHeight });
window.addEventListener('resize', () => {
  ui.setFrame({ x: 0, y: 0, width: root.clientWidth, height: root.clientHeight });
});

// The HUD: three panels, each applied once a frame by the page (no scheduler of their own).
const h = hud(
  {
    items: [
      { spec: VITALS, place: { default: 'left' } },
      { spec: HOTBAR, place: { default: 'bottom' } },
      { spec: QUESTS, place: { default: 'right' } },
    ],
  },
  { schedule: null },
);
const talk = panel(TALK, { schedule: null });

const state: HarnessUiSpecState = {
  ready: false,
  frames: 0,
  health: 0.8,
  mana: 0.5,
  selected: 0,
  quests: 0,
  done: 0,
  dialog: false,
  writes: 0,
  applies: 0,
  last: '',
  parked: false,
};

const vitals = h.get('vitals').model;
const hot = h.get('hotbar').model;
const quests = h.get('quests').model;
const questKeys: string[] = [];
const doneKeys: string[] = [];
let seq = 0;

function setBar(id: 'hp' | 'mp', v: number): void {
  vitals.set(id, v);
  vitals.set(`${id}.text`, `${Math.round(v * 100)} / 100`);
  vitals.set(`${id}.tint`, id === 'mp' ? '#5f8de6' : v < 0.3 ? '#e8766a' : '#7fd38a');
}

function select(i: number): void {
  if (i < 0 || i >= SLOTS) return;
  hot.set(`hot.${state.selected}.state`, '');
  state.selected = i;
  hot.set(`hot.${i}.state`, 'on');
}

function listQuests(): void {
  quests.setList('quests', [...questKeys, ...doneKeys]);
  state.quests = questKeys.length + doneKeys.length;
  state.done = doneKeys.length;
  quests.set('quests.none', state.quests === 0);
}

function addQuest(title: string): string {
  const key = `q${seq++}`;
  questKeys.push(key);
  const r = quests.row('quests', key);
  r.set('title', title);
  r.set('step', 'Started');
  r.set('state', '');
  listQuests();
  return key;
}

function finish(key: string): void {
  const i = questKeys.indexOf(key);
  if (i === -1) return;
  questKeys.splice(i, 1);
  doneKeys.push(key);
  const r = quests.row('quests', key);
  r.set('step', 'Done');
  r.set('state', 'done');
  listQuests();
}

let modal: SpecModal | null = null;

function openDialog(): void {
  if (modal) return;
  talk.model.set('who', 'The ferryman');
  talk.model.set(
    'line',
    'The river is high, and my {w}lantern{/} went over the side. Bring me a light and I will take you across.',
  );
  modal = presentModal(ui, talk, {
    title: 'Talk',
    theme: look,
    initialFocus: '[data-tc-id="talk/accept"]',
    onClose: () => {
      modal = null;
      state.dialog = false;
    },
  });
  state.dialog = true;
}

function closeDialog(): void {
  modal?.handle.close();
}

function onEvent(e: PanelEvent): void {
  state.last = `${e.panel}/${e.id}:${e.type}`;
  if (e.panel === 'hotbar' && e.type === 'tap') select(Number(e.id.slice(4)));
  else if (e.panel === 'talk') {
    if (e.id === 'accept') addQuest('Find a lantern');
    closeDialog();
  }
}
h.onEvent = onEvent;
talk.onEvent = onEvent;

// The first state, then the HUD on the page.
setBar('hp', state.health);
setBar('mp', state.mana);
for (let i = 0; i < SLOTS; i++) {
  hot.set(`hot.${i}.item`, ITEMS[i]!);
  hot.set(`hot.${i}.count`, COUNTS[i]!);
  hot.set(`hot.${i}.state`, '');
}
select(0);
quests.set('quests.empty', 'Nothing to do yet.');
addQuest('Cross the river');
addQuest('Mend the fence');
const view = presentHud(h, ui, { theme: look });

window.addEventListener('keydown', (e) => {
  if (state.dialog || e.target instanceof HTMLInputElement) return;
  const n = Number(e.key);
  if (n >= 1 && n <= SLOTS) select(n - 1);
  else if (e.key === 't') openDialog();
});

let t0 = performance.now();
function frame(now: number): void {
  if (!state.parked) {
    const t = (now - t0) / 1000;
    state.health = 0.55 + 0.4 * Math.sin(t * 0.7);
    state.mana = 0.5 + 0.45 * Math.sin(t * 1.3 + 1);
    setBar('hp', state.health);
    setBar('mp', state.mana);
  }
  h.apply();
  talk.apply();
  let writes = 0;
  for (const d of view.presenters) writes += d.writes;
  state.writes = writes;
  state.applies = h.panels.reduce((n, p) => n + p.applies, 0) + talk.applies;
  state.frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
state.ready = true;

const api: HarnessUiSpecApi = {
  state,
  park(on) {
    state.parked = on;
    if (!on) t0 = performance.now();
  },
  select,
  addQuest,
  finish,
  openDialog,
  closeDialog,
};
window.__harnessUiSpec = api;
