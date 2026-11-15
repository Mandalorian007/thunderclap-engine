/**
 * UI fit page (ws/ui-fit): the hooks a game's panels lean on, on one spec panel drawn by the DOM
 * presenter on the page and by the world presenter on a world surface made on a bare device (no
 * Renderer: painted and uploaded, drawn by nobody). Noun-free; the words are what a game would
 * write.
 *
 * - a stack aimed (`data-aim`), an icon's ring (a bound fill), a held slot (down and up), the
 *   game's class name on the slot;
 * - a search field that takes type-ahead (a letter typed with nothing focused, `/` to focus) and
 *   closes the panel on its close key (KeyE) while empty;
 * - a long list, windowed (only rows near its view are bound), that slides when a row moves and
 *   that both presenters reveal a row in;
 * - the body slides in and out (`slide: 'right'`), and gives way while a sheet is open on a small
 *   screen.
 *
 * e2e/ui-fit.spec.ts reads `window.__harnessUiFit.state`.
 */
import {
  b,
  createWorldPanel,
  type PanelEvent,
  type PanelSpec,
  panel,
  presentDom,
  presentWorld,
} from '@thunderclap-engine/engine/ui';
import type { UiFitApi, UiFitBox, UiFitState } from './ui-fit-state';

const host = document.getElementById('page') as HTMLElement;
const W = 320;
const ROWS = 400;
const KEYS = Array.from({ length: ROWS }, (_, i) => `r${i}`);

const FIT: PanelSpec = {
  id: 'fit',
  slide: 'right',
  fade: 160,
  giveWay: 'small',
  body: {
    k: 'col',
    gap: 8,
    pad: 12,
    show: b('open'),
    children: [
      {
        k: 'row',
        id: 'head',
        aim: b('aim'),
        gap: 8,
        align: 'center',
        children: [
          { k: 'icon', id: 'cool', glyph: 'M4 4 L20 4 L20 20 L4 20 Z', ring: b('cool'), size: 28 },
          { k: 'text', text: 'Things', style: 'head' },
          { k: 'slot', id: 'grab', item: b('grab'), press: 'held', size: 44 },
        ],
      },
      {
        k: 'field',
        id: 'find',
        kind: 'search',
        value: b('find'),
        typeAhead: true,
        closeKey: 'KeyE',
        w: 296,
        h: 32,
      },
      {
        k: 'list',
        id: 'things',
        rowH: 24,
        gap: 0,
        h: 192,
        window: 48,
        row: { k: 'text', id: 'name', text: b('row.name'), style: 'body' },
      },
    ],
  },
};

const state: UiFitState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  events: [],
  domRows: [],
  worldRows: [],
  uploads: 0,
  given: false,
};

const p = panel(FIT, { schedule: null });
p.onEvent = (e: PanelEvent) => {
  state.events.push(`${e.id}:${e.type}:${e.value}`);
  if (e.id === 'find' && e.type === 'close') p.model.set('open', false);
};
p.model.setAll({ open: true, aim: 'down', cool: 0.25, find: '', grab: 'stone' });
p.model.setList('things', KEYS);
for (let i = 0; i < ROWS; i++) p.model.row('things', KEYS[i]!).set('name', `thing ${i}`);
p.frame(W, 0);

const dom = presentDom(p, host, { classes: { 'tcs-slot': 'fit-slot' } });

const LOG: PanelSpec = {
  id: 'log',
  body: {
    k: 'col',
    children: [
      {
        k: 'list',
        id: 'lines',
        rowH: 20,
        h: 100,
        tail: true,
        row: { k: 'text', id: 'line', text: b('row.line'), style: 'body' },
      },
    ],
  },
};

const nextFrame = (): Promise<void> => new Promise((f) => requestAnimationFrame(() => f()));

/** See `UiFitApi.resizeLoop`. */
async function resizeLoop(): Promise<string[]> {
  const seen: string[] = [];
  const onError = (e: ErrorEvent): void => {
    if (/ResizeObserver/.test(e.message)) seen.push(e.message);
  };
  window.addEventListener('error', onError);
  // The log's host, shallow; the page's own observed box, deeper (a panel's sizer).
  const logHost = document.createElement('div');
  logHost.style.cssText = 'width:200px;height:120px';
  const outer = document.createElement('div');
  const sizer = document.createElement('div');
  sizer.style.cssText = 'width:10px;height:4px';
  outer.appendChild(document.createElement('div')).appendChild(sizer);
  document.body.append(logHost, outer);
  const log = panel(LOG, { schedule: null });
  const keys = Array.from({ length: 12 }, (_, i) => `l${i}`);
  log.model.setList('lines', keys);
  for (const k of keys) log.model.row('lines', k).set('line', k);
  log.frame(200, 0);
  const shown = presentDom(log, logHost);
  log.apply();
  // The page moves the log aside when its panel's size changes, inside its observer's callback.
  let n = 0;
  const page = new ResizeObserver(() => {
    logHost.style.height = `${120 + (++n % 2) * 40}px`;
  });
  page.observe(sizer);
  for (let i = 0; i < 6; i++) {
    sizer.style.width = `${12 + i}px`;
    await nextFrame();
    await nextFrame();
  }
  page.disconnect();
  shown.dispose();
  logHost.remove();
  outer.remove();
  window.removeEventListener('error', onError);
  return seen;
}

/** A box (px, from `from`) in units. */
function rel(r: DOMRect, from: DOMRect): UiFitBox {
  return { x: r.left - from.left, y: r.top - from.top, w: r.width, h: r.height };
}

async function boot(): Promise<void> {
  const gpu = navigator.gpu;
  const adapter = gpu ? await gpu.requestAdapter() : null;
  if (!adapter) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const device = await adapter.requestDevice();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 480;
  const surface = createWorldPanel(
    { device },
    { width: W / 100, height: 4.8, resolution: 100, canvas, background: 'transparent' },
  );
  const world = presentWorld(p, surface, { fit: 'none', scale: 1 });

  const api: UiFitApi = {
    state,
    open: (on) => p.model.set('open', on),
    resizeLoop,
    giveWay: (sheet, small) => p.giveWay(sheet, small),
    toTop: (key) =>
      p.model.setList('things', [key, ...p.model.lists[0]!.keys.filter((k) => k !== key)], 'slide'),
    reveal: (key) => {
      const a = dom.reveal('things', key);
      const w = world.reveal('things', key);
      return a && w;
    },
    worldKey: (key, code) => world.key({ key, code }),
    worldPress: async (id, after) => {
      const r = world.rectOf(id)!;
      world.pointerDown(r.x + r.w / 2, r.y + r.h / 2);
      await new Promise((f) => setTimeout(f, after));
      world.pointerUp(r.x + r.w / 2, r.y + r.h / 2, true);
    },
    boxes: (id) => {
      const el = dom.el(id);
      const body = host.querySelector('.tcs-body');
      const r = world.rectOf(id);
      return {
        dom: el && body ? rel(el.getBoundingClientRect(), body.getBoundingClientRect()) : null,
        world: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null,
      };
    },
  };
  window.__harnessUiFit = api;

  const frame = (): void => {
    p.apply();
    const enc = device.createCommandEncoder();
    surface.prepare(enc);
    device.queue.submit([enc.finish()]);
    state.frames++;
    state.domRows = dom.rows('things');
    state.worldRows = world.rows('things');
    state.uploads = surface.stats.uploads;
    state.given = p.given;
    requestAnimationFrame(frame);
  };
  state.gpu = 'ok';
  state.ready = true;
  requestAnimationFrame(frame);
}

boot().catch((e: unknown) => {
  state.gpu = e instanceof Error ? e.message : String(e);
  state.ready = true;
});
