/**
 * UI-world page (ws/ui-world): one spec panel drawn twice, by the DOM presenter on the page and by
 * the world presenter on a quad in a small room, plus a HUD and a modal on the head-following
 * screen. Noun-free; the words are what a game would write.
 *
 * - `kit` (one `SpecPanel`, one model): the page's copy (left, `presentDom`) and the quad's
 *   (`presentWorld`, `fit: 'none'`, the page frames it) say the same events; the page's handler
 *   moves the model, so both show it.
 * - The head screen (`worldScreen`, lazy-following): `presentWorldHud` puts a meter at the top and
 *   a `Menu` button at the bottom; `Menu` opens `dialog` with `presentWorldModal` (Escape, a press
 *   outside it, `Resume` and `Close` close it).
 * - Mouse and touch rays through the camera press the quad and the screen; keys go to the screen
 *   while the modal is open, else to the quad (unless the page's copy has focus).
 * - `?stereo`: two eyes ±0.032 on the right axis, one per half of the canvas, both drawing the
 *   quad and the screen (the page's copy hides: a headset has no page).
 *
 * e2e/ui-world.spec.ts reads `window.__harnessUiWorld.state()`.
 */
import { createGame } from '@thunderclap-engine/engine';
import { box, flipWinding } from '@thunderclap-engine/engine/geom';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  Transform,
} from '@thunderclap-engine/engine/render';
import {
  b,
  createWorldPanel,
  hud,
  type PanelEvent,
  type PanelSpec,
  panel,
  presentDom,
  presentWorld,
  presentWorldHud,
  presentWorldModal,
  type WorldModal,
  type WorldPanel,
  type WorldPresenter,
  worldScreen,
} from '@thunderclap-engine/engine/ui';
import type { UiWorldPoint, UiWorldState } from './ui-world-state';

const root = document.getElementById('root') as HTMLElement;
const page = document.getElementById('page') as HTMLElement;
const stereo = new URLSearchParams(location.search).has('stereo');
const LOGICAL = { width: 1920, height: 1080 };
const EYE: UiWorldPoint = [0, 1.6, 2.2];
const TARGET: UiWorldPoint = [0, 1.45, 0];
const ROOM: UiWorldPoint = [10, 5, 10];
const IPD = 0.064;
const FOV = (60 * Math.PI) / 180;
/** The panel's width in units, on the page and on the quad. */
const PANEL_W = 360;

const KIT: PanelSpec = {
  id: 'kit',
  body: {
    k: 'col',
    gap: 8,
    pad: 12,
    children: [
      { k: 'text', text: b('title'), style: 'head' },
      {
        k: 'row',
        gap: 8,
        children: [
          { k: 'button', id: 'use', text: 'Use', w: 104, h: 40 },
          { k: 'button', id: 'mute', text: 'Mute', press: 'toggle', on: b('mute'), w: 104, h: 40 },
          { k: 'button', id: 'go', text: 'Hold', press: 'held', w: 104, h: 40 },
        ],
      },
      { k: 'range', id: 'vol', min: 0, max: 10, step: 1, value: b('vol'), w: 328, h: 28 },
      {
        k: 'row',
        gap: 8,
        children: [
          { k: 'field', id: 'say', kind: 'chat', value: b('say'), w: 228, h: 36 },
          { k: 'button', id: 'send', text: 'Send', submits: 'say', w: 92, h: 36 },
        ],
      },
      { k: 'tabs', id: 'tab', selected: b('tab'), optionW: 80, h: 34 },
      {
        k: 'list',
        id: 'log',
        rowH: 24,
        gap: 2,
        h: 100,
        row: { k: 'text', text: b('row.line'), style: 'body' },
      },
      { k: 'text', text: b('status'), style: 'label' },
    ],
  },
};

const BAR: PanelSpec = {
  id: 'bar',
  body: {
    k: 'row',
    gap: 10,
    pad: 10,
    align: 'center',
    children: [
      { k: 'text', text: 'Level', style: 'label' },
      { k: 'meter', id: 'level', value: b('level'), w: 180, h: 12 },
    ],
  },
};

const MENU: PanelSpec = {
  id: 'menu',
  body: { k: 'button', id: 'open', text: 'Menu', w: 140, h: 44 },
};

const DIALOG: PanelSpec = {
  id: 'dialog',
  body: {
    k: 'col',
    gap: 10,
    pad: 16,
    children: [
      { k: 'text', text: 'Paused', style: 'head' },
      { k: 'button', id: 'resume', text: 'Resume', w: 180, h: 44 },
      { k: 'button', id: 'close', text: 'Close', w: 180, h: 44 },
    ],
  },
};

const state: UiWorldState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  stereo,
  events: [],
  model: { mute: false, vol: 3, say: '', tab: 'one', uses: 0, log: 0 },
  viewProjections: [],
  screens: [],
  quad: {},
  screen: {},
  paints: 0,
  uploads: 0,
  modalOpen: false,
  quadFocus: '',
  gpuErrors: 0,
};

const kit = panel(KIT);
let lines: string[] = [];
let uses = 0;

function seed(): void {
  uses = 0;
  lines = [];
  kit.model.setAll({
    title: 'One panel, two surfaces',
    mute: false,
    vol: 3,
    say: '',
    tab: 'one',
    status: 'Nothing yet',
  });
  kit.model.setList('tab', ['one', 'two', 'three']);
  for (const [k, l] of [
    ['one', 'One'],
    ['two', 'Two'],
    ['three', 'Three'],
  ] as const)
    kit.model.row('tab', k).set('label', l);
  kit.model.setList('log', []);
}
seed();

const say = (e: PanelEvent) => `${e.id}:${e.row ?? ''}:${e.type}:${e.value}`;
kit.onEvent = (e) => {
  state.events.push(say(e));
  if (e.id === 'use' && e.type === 'tap') {
    uses++;
    kit.model.set('status', `Used ${uses}×`);
  } else if (e.id === 'mute' && e.type === 'toggle') kit.model.set('mute', e.value as boolean);
  else if (e.id === 'tab' && e.type === 'pick') kit.model.set('tab', e.value as string);
  else if (e.id === 'go') kit.model.set('status', e.type === 'down' ? 'Holding' : 'Let go');
  else if (e.id === 'say' && e.type === 'enter' && e.value) {
    const key = `l${lines.length}`;
    lines.push(key);
    kit.model.setList('log', lines);
    kit.model.row('log', key).set('line', String(e.value));
    kit.model.set('say', '');
  }
};

// The page's copy.
kit.frame(PANEL_W, 0);
const dom = presentDom(kit, page);
if (stereo) page.style.display = 'none';

let read: () => UiWorldState = () => state;
window.__harnessUiWorld = {
  state: () => read(),
  reset() {
    (document.activeElement as HTMLElement | null)?.blur?.();
    seed();
    state.events.length = 0;
  },
};

const WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let light = 0.55 + 0.3 * max(n.y, 0.0) + 0.15 * abs(n.x);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * light, 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** Panel px → world point through the panel's transform. */
function worldAt(p: WorldPanel, px: number, py: number): UiWorldPoint {
  const lx = px / p.resolution - p.width / 2;
  const ly = p.height / 2 - py / p.resolution;
  const m = p.transform.world;
  return [
    m[0]! * lx + m[1]! * ly + m[3]!,
    m[4]! * lx + m[5]! * ly + m[7]!,
    m[8]! * lx + m[9]! * ly + m[11]!,
  ];
}

function centres(
  out: Record<string, UiWorldPoint>,
  p: WorldPanel,
  v: WorldPresenter,
  words: readonly (readonly [string, string | null])[],
): void {
  for (const [id, row] of words) {
    const r = v.rectOf(id, row);
    const k = row === null ? id : `${id}:${row}`;
    if (r) out[k] = worldAt(p, r.x + r.w / 2, r.y + r.h / 2);
    else delete out[k];
  }
}

async function main(): Promise<void> {
  const ctx = await createGame({
    root,
    title: 'Engine ui-world demo',
    design: LOGICAL,
    input: { bindings: { select: [{ pointer: 'select' }] } },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const { renderer, camera } = ctx;
  camera.setPerspective(FOV, LOGICAL.width / LOGICAL.height, 0.05, 100);
  camera.lookAt(EYE, TARGET);
  camera.depthTest = true;
  camera.depthWrite = true;

  const material = renderer.createMaterial({ label: 'room', blend: 'opaque', wgsl: WGSL });
  const room = renderer.createMesh({
    ...flipWinding(box({ size: ROOM, color: [0.5, 0.53, 0.58, 1] })),
    label: 'room',
  });
  const roomT = new Transform({ y: ROOM[1] / 2 });
  const roomP: InstanceParams = { tint: [1, 1, 1, 1] };

  // The quad: the same panel, framed by the page (`fit: 'none'`), 480 px per 360 units.
  const quad = createWorldPanel(renderer, {
    width: 1.2,
    height: 1.35,
    resolution: 400,
    label: 'quad',
  });
  quad.transform.setPosition(0.35, 1.4, 0);
  const world = presentWorld(kit, quad, { fit: 'none', scale: quad.pxWidth / PANEL_W });

  // The head screen: a HUD and, on Menu, a modal.
  const screen = worldScreen(renderer, { width: 1.4, height: 0.8, resolution: 500 });
  const h = hud(
    {
      items: [
        { spec: BAR, place: { default: 'top' } },
        { spec: MENU, place: { default: 'bottom' } },
      ],
    },
    {},
  );
  h.get('bar').model.set('level', 0.62);
  const dialog = panel(DIALOG);
  let modal: WorldModal | null = null;
  h.onEvent = (e) => {
    state.events.push(`${e.panel}/${say(e)}`);
    if (e.id === 'open' && e.type === 'tap' && !modal?.open) {
      modal = presentWorldModal(screen, dialog, {
        onClose: (why) => state.events.push(`dialog/closed:${why}`),
      });
    }
  };
  dialog.onEvent = (e) => {
    state.events.push(`dialog/${say(e)}`);
    if (e.type === 'tap' && (e.id === 'resume' || e.id === 'close')) modal?.close();
  };
  const hudView = presentWorldHud(h, screen);

  for (const p of [quad, screen]) p.attach(ctx.input);
  const pageFocused = () => page.contains(document.activeElement);
  window.addEventListener('keydown', (e) => {
    if (pageFocused()) return;
    const target = modal?.open ? screen : quad;
    if (target.key(e)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (pageFocused()) return;
    (modal?.open ? modal.presenter : world).keyUp(e);
  });

  // `?stereo`: two eyes, one per half; the page camera draws nothing (layers 0) but still aims
  // the rays and moves the head screen.
  const eyes = [0, 1].map((i) => {
    const c = Camera.perspective(FOV, LOGICAL.width / 2 / LOGICAL.height, 0.05, 100);
    c.screen.x = i * 0.5;
    c.screen.y = 0;
    c.screen.width = 0.5;
    c.screen.height = 1;
    c.viewIndex = i;
    c.depthTest = true;
    c.depthWrite = true;
    return c;
  });
  if (stereo) camera.layers = 0;
  const placeEyes = () => {
    const v = camera.view;
    // The camera's right axis is the view matrix's first row.
    const rx = v[0]!;
    const ry = v[4]!;
    const rz = v[8]!;
    for (let i = 0; i < 2; i++) {
      const s = (i === 0 ? -1 : 1) * (IPD / 2);
      eyes[i]!.lookAt(
        [EYE[0] + rx * s, EYE[1] + ry * s, EYE[2] + rz * s],
        [TARGET[0] + rx * s, TARGET[1] + ry * s, TARGET[2] + rz * s],
      );
    }
  };

  ctx.stack.push({
    render(frame) {
      frame.clear(0.05, 0.07, 0.12);
      frame.mesh(room, material, roomT, roomP);
      frame.drawable(quad.drawable, 10);
      frame.drawable(screen.drawable, 20);
      if (stereo) {
        placeEyes();
        for (const e of eyes) renderer.render(frame, e);
      }
    },
  });
  ctx.hooks.afterRender = () => {
    state.frames++;
  };

  const KIT_WORDS = [
    ['use', null],
    ['mute', null],
    ['go', null],
    ['vol', null],
    ['say', null],
    ['send', null],
    ['tab', 'one'],
    ['tab', 'two'],
    ['tab', 'three'],
  ] as const;
  read = () => {
    state.model = {
      mute: kit.model.get('mute') === true,
      vol: Number(kit.model.get('vol')),
      say: String(kit.model.get('say') ?? ''),
      tab: String(kit.model.get('tab') ?? ''),
      uses,
      log: lines.length,
    };
    const cams = stereo ? eyes : [camera];
    state.viewProjections = cams.map((c) => Array.from(c.viewProjection));
    state.screens = cams.map((c) => ({ ...c.screen }));
    centres(state.quad, quad, world, KIT_WORDS);
    state.screen = {};
    centres(state.screen, screen, hudView.presenters[0]!, [['level', null]]);
    centres(state.screen, screen, hudView.presenters[1]!, [['open', null]]);
    if (modal?.open)
      centres(state.screen, screen, modal.presenter, [
        ['resume', null],
        ['close', null],
      ]);
    state.modalOpen = modal?.open === true;
    state.paints = world.paints;
    state.uploads = quad.stats.uploads + screen.stats.uploads;
    const f = world.focusId;
    state.quadFocus = f.row === null ? f.id : `${f.id}:${f.row}`;
    state.gpuErrors = gpuDiagnostics.errorCount;
    void dom;
    return state;
  };
  ctx.loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
