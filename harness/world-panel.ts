/**
 * World-panel page (ws/ui-world-panel): UI painted onto quads in the world, through `createGame`.
 * Noun-free; the room, the panels and the widgets are what a game would write.
 *
 * - A small `geom` room (a box turned inside out). Panel `a` hangs on the back wall, panel `b` on
 *   the left wall, turned to face +x; `hud` is head-locked 2 units in front of the camera, bottom
 *   right, drawn without a depth test. Each holds every widget.
 * - Every panel is a router target (`worldPanelTarget`), so the mouse and touch rays through the
 *   camera press the same buttons; `?pad` adds a `PadCursor` over a fake gamepad the spec sets.
 *   `panel.poll(ctx.pointers.pointers)` each frame turns the routed pointers into hover, press
 *   and release; `hud.update(camera)` keeps the head-locked panel in front of the eye.
 * - Keys go to panel `a` (`Tab`, `Enter`, arrows), so a keyboard drives it without a ray.
 *
 * e2e/world-panel.spec.ts reads `window.__harnessWorldPanel.state()`.
 */
import { createGame } from '@thunderclap/engine';
import { box, flipWinding } from '@thunderclap/engine/geom';
import { type GamepadLike, PadCursor } from '@thunderclap/engine/input';
import { gpuDiagnostics, type InstanceParams, Transform } from '@thunderclap/engine/render';
import {
  createWorldPanel,
  type WorldPanel,
  type WorldWidget,
  worldButton,
  worldLabel,
  worldList,
  worldPanelTarget,
  worldProgress,
  worldSlider,
  worldToggle,
} from '@thunderclap/engine/ui';
import type {
  HarnessWorldPanelApi,
  HarnessWorldPanelState,
  WorldPanelBox,
  WorldPoint,
} from './world-panel-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const EYE: WorldPoint = [1.5, 2, 2];
const TARGET: WorldPoint = [-2.5, 2.1, -6];
const ROOM: WorldPoint = [12, 6, 12];
const RESOLUTION = 128;
const HUD_DISTANCE = 2;
const withPad = new URLSearchParams(location.search).has('pad');

const state: HarnessWorldPanelState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  canvas: { x: 0, y: 0, width: 0, height: 0 },
  viewProjection: [],
  screen: { x: 0, y: 0, width: 0, height: 0 },
  pressed: {},
  toggle: false,
  slider: 50,
  listSelected: -1,
  uploads: 0,
  repaints: 0,
  hover: null,
  headLockedDistance: 0,
  widgets: {},
  sliderTrack: { from: [0, 0, 0], to: [0, 0, 0] },
  gpuErrors: 0,
};

let read: () => HarnessWorldPanelState = () => state;
let aim: HarnessWorldPanelApi['aim'] = () => {
  throw new Error('not booted');
};
let pad: GamepadLike = { axes: [0, 0], buttons: [] };
const cursor = new PadCursor({ getGamepads: () => [pad] });
window.__harnessWorldPanel = {
  state: () => read(),
  aim: (e, t) => aim(e, t),
  setPad(axes, pressed) {
    pad = {
      axes,
      buttons: Array.from({ length: 4 }, (_, i) => ({
        pressed: pressed.includes(i),
        value: pressed.includes(i) ? 1 : 0,
      })),
    };
  },
  cursorTo: (x, y) => cursor.moveTo(x, y),
};

const WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let light = 0.5 + 0.3 * max(n.y, 0.0) + 0.2 * abs(n.x);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * light, 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

function toBox(r: DOMRect): WorldPanelBox {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Panel px → world point through the panel's transform. */
function worldAt(panel: WorldPanel, px: number, py: number): WorldPoint {
  const lx = px / panel.resolution - panel.width / 2;
  const ly = panel.height / 2 - py / panel.resolution;
  const m = panel.transform.world;
  return [
    m[0]! * lx + m[1]! * ly + m[3]!,
    m[4]! * lx + m[5]! * ly + m[7]!,
    m[8]! * lx + m[9]! * ly + m[11]!,
  ];
}

const ids = new Map<WorldWidget, string>();
const positions: { id: string; panel: WorldPanel; widget: WorldWidget }[] = [];

function named<W extends WorldWidget>(panel: WorldPanel, id: string, widget: W): W {
  panel.add(widget);
  ids.set(widget, id);
  positions.push({ id, panel, widget });
  return widget;
}

const press = (id: string) => () => {
  state.pressed[id] = (state.pressed[id] ?? 0) + 1;
};

/** Every widget on `panel`, named `${prefix}-<kind>`; `a` also drives the shared state. */
function fill(panel: WorldPanel, prefix: string, title: string): void {
  named(panel, `${prefix}-label`, worldLabel({ text: title, size: 'l' }));
  named(
    panel,
    `${prefix}-button`,
    worldButton({ text: 'Press', onPress: press(`${prefix}-button`) }),
  );
  named(
    panel,
    `${prefix}-button2`,
    worldButton({ text: 'Press too', onPress: press(`${prefix}-button2`) }),
  );
  const progress = worldProgress({ value: 0.5, tone: 'accent' });
  named(
    panel,
    `${prefix}-toggle`,
    worldToggle({
      text: 'Sound',
      value: false,
      onChange: (v) => {
        if (prefix === 'a') state.toggle = v;
        progress.set({ tone: v ? 'success' : 'accent' });
      },
    }),
  );
  named(
    panel,
    `${prefix}-slider`,
    worldSlider({
      min: 0,
      max: 100,
      value: 50,
      step: 1,
      onChange: (v) => {
        if (prefix === 'a') state.slider = v;
        progress.set({ value: v / 100 });
      },
    }),
  );
  named(panel, `${prefix}-progress`, progress);
  named(
    panel,
    `${prefix}-list`,
    worldList({
      items: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'],
      visibleRows: 3,
      onSelect: (i) => {
        if (prefix === 'a') state.listSelected = i;
      },
    }),
  );
}

async function main(): Promise<void> {
  const ctx = await createGame({
    root,
    title: 'Engine world-panel demo',
    design: LOGICAL,
    input: { bindings: { select: [{ pointer: 'select' }] } },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const { renderer, camera, surface, pointers } = ctx;
  camera.setPerspective((60 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  camera.lookAt(EYE, TARGET);
  camera.depthTest = true;
  camera.depthWrite = true;
  aim = (eye, target) => {
    camera.lookAt(eye, target);
  };

  const material = renderer.createMaterial({ label: 'room', blend: 'opaque', wgsl: WGSL });
  const roomGeometry = flipWinding(box({ size: ROOM, color: [0.55, 0.58, 0.64, 1] }));
  const room = renderer.createMesh({ ...roomGeometry, label: 'room' });
  const roomT = new Transform({ y: ROOM[1] / 2 });
  const roomP: InstanceParams = { tint: [1, 1, 1, 1] };
  const plinth = renderer.createMesh({ ...box({ size: [1, 1, 1] }), label: 'plinth' });
  const plinthT = new Transform({ x: -2, y: 0.4, z: -3, scaleX: 1.2, scaleY: 0.8, scaleZ: 1.2 });
  const plinthP: InstanceParams = { tint: [0.8, 0.5, 0.3, 1] };

  const a = createWorldPanel(renderer, {
    width: 2.4,
    height: 2.2,
    resolution: RESOLUTION,
    label: 'a',
  });
  a.transform.setPosition(-2, 2.4, -ROOM[2] / 2 + 0.01);
  const b = createWorldPanel(renderer, { width: 2, height: 2, resolution: RESOLUTION, label: 'b' });
  b.transform.setPosition(-ROOM[0] / 2 + 0.01, 2.4, -2.6);
  b.transform.setAxisAngle(0, 1, 0, Math.PI / 2);
  const hud = createWorldPanel(renderer, {
    width: 0.9,
    height: 0.8,
    resolution: RESOLUTION,
    label: 'hud',
    headLocked: { distance: HUD_DISTANCE, offset: [1.35, -0.6] },
  });
  const panels = [a, b, hud];
  fill(a, 'a', 'Back wall');
  fill(b, 'b', 'Left wall');
  fill(hud, 'hud', 'Head-locked');
  for (const p of panels) pointers.addTester(worldPanelTarget(p));
  if (withPad) pointers.addSource(cursor);
  window.addEventListener('keydown', (e) => {
    if (a.key(e)) e.preventDefault();
  });

  ctx.stack.push({
    render(frame) {
      frame.clear(0.05, 0.07, 0.12);
      frame.mesh(room, material, roomT, roomP);
      frame.mesh(plinth, material, plinthT, plinthP);
      for (const p of panels) frame.drawable(p.drawable, 10);
    },
  });
  ctx.hooks.beforeRender = () => {
    hud.update(camera);
    for (const p of panels) p.poll(pointers.pointers);
  };
  ctx.hooks.afterRender = () => {
    state.frames++;
  };

  const slider = positions.find((p) => p.id === 'a-slider')!;
  read = () => {
    state.canvas = toBox(surface.canvas.getBoundingClientRect());
    state.viewProjection = Array.from(camera.viewProjection);
    const s = camera.screen;
    state.screen = { x: s.x, y: s.y, width: s.width, height: s.height };
    state.uploads = 0;
    state.repaints = 0;
    state.hover = null;
    for (const p of panels) {
      state.uploads += p.stats.uploads;
      state.repaints += p.stats.repaints;
      if (p.hovered) state.hover = ids.get(p.hovered) ?? null;
    }
    const eye = camera.position;
    const v = camera.view;
    const hp = hud.transform.position;
    // Along the view axis (the camera's -z): the panel's offset is across it.
    state.headLockedDistance = -(
      (hp.x - eye[0]!) * v[2]! +
      (hp.y - eye[1]!) * v[6]! +
      (hp.z - eye[2]!) * v[10]!
    );
    for (const { id, panel, widget } of positions) {
      const r = widget.layoutRect;
      state.widgets[id] = worldAt(panel, r.x + r.w / 2, r.y + r.h / 2);
    }
    const r = slider.widget.layoutRect;
    const inset = slider.panel.theme.space3;
    state.sliderTrack = {
      from: worldAt(slider.panel, r.x + inset, r.y + r.h / 2),
      to: worldAt(slider.panel, r.x + r.w - inset, r.y + r.h / 2),
    };
    state.gpuErrors = gpuDiagnostics.errorCount;
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
