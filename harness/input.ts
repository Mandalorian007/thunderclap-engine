/**
 * Input page (ws/input-3): a lit cube under an `Input` wired with every ws/input-3 feature, so
 * e2e/input.spec.ts can drive them with real keys, mouse and touches on every matrix row.
 * Noun-free.
 *
 * - `?orbit`: `Look` in orbit mode; a mouse or pen drag on the canvas turns the cube, a touch
 *   drag anywhere does too (the touch look zone, no move stick). Without it the look is locked
 *   mode, and the page never asks for the pointer lock, so a mouse drag is a gesture instead.
 * - A panel over the canvas: *Rebind jump* listens for the next key (Escape cancels) and lists
 *   the live bindings and their conflicts (`fire` is on F, so rebinding `jump` to F is one); a hold bar for `charge` (hold C), a counter for the
 *   `combo` chord (Shift+K, which also rumbles), and the glyph `jump` would show for the device
 *   last used.
 * - Gestures run in `pan: 'prefer'` mode; the last pan or long press that reached an action is
 *   reported. The gesture clock can be pinned (`setClock`) like the gestures page.
 */
import { GameLoop } from '@thunderclap/engine/core';
import {
  type Binding,
  findConflicts,
  Gestures,
  glyphForBinding,
  Input,
  Look,
  type LookMode,
  serializeBindings,
} from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import type { HarnessInputApi, HarnessInputState } from './input-state';

const root = document.getElementById('root') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const mode: LookMode = query.has('orbit') ? 'orbit' : 'locked';

const ACTIONS = ['jump', 'fire', 'charge', 'combo', 'pan', 'long'] as const;
type Action = (typeof ACTIONS)[number];
const DEFAULTS: Record<Action, Binding[]> = {
  jump: [{ key: 'Space' }, { padButton: 0 }, { gesture: 'tap' }],
  fire: [{ key: 'KeyF' }, { padButton: 2 }],
  charge: [{ key: 'KeyC', trigger: 'hold', holdMs: 400 }],
  combo: [{ chord: [{ key: 'ShiftLeft' }, { key: 'KeyK' }] }],
  pan: [{ gesture: 'pan' }],
  long: [{ gesture: 'longPress' }],
};

const state: HarnessInputState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  ticks: 0,
  mode,
  yaw: 0,
  pitch: 0,
  locked: false,
  bindings: '',
  conflicts: [],
  listening: null,
  holdProgress: 0,
  holdFired: 0,
  holdFiredAfterMs: -1,
  chordFired: 0,
  lastDevice: 'keyboard',
  glyph: '',
  rumbles: 0,
  panOrLong: null,
  gpuErrors: 0,
};

/** The gesture clock: `performance.now()` until the spec pins it with `setClock`. */
let clockMs: number | null = null;
const gestures = new Gestures({ now: () => clockMs ?? performance.now(), pan: 'prefer' });
// Every touch drags the view in orbit mode: no move stick.
const look = new Look({ mode, sensitivity: 0.005, touch: { moveZone: 'none' } });
const input = new Input<Action>(
  { ...DEFAULTS },
  { look, gestures, getGamepads: () => navigator.getGamepads?.() ?? [] },
);
input.on('rumble', () => {
  state.rumbles++;
});

/** `performance.now()` when C last went down, for `holdFiredAfterMs`. */
let chargeDownAt = -1;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC' && !e.repeat) chargeDownAt = performance.now();
});

function refreshBindings(): void {
  state.bindings = serializeBindings(input.bindings());
  state.conflicts = findConflicts(input.bindings()).map(
    (c) => `${glyphForBinding(c.binding).label}: ${c.actions.join(', ')}`,
  );
}
refreshBindings();

const api: HarnessInputApi = {
  state,
  async listen(action) {
    const b = await input.listen(action as Action);
    if (b) input.rebind(action as Action, [b]);
    refreshBindings();
    return b;
  },
  rebind(action, bindings) {
    input.rebind(action as Action, bindings);
    refreshBindings();
  },
  setMode(m) {
    look.setMode(m);
    state.mode = m;
  },
  setClock(ms) {
    clockMs = ms;
  },
  rumble: () => input.rumble(),
};
window.__harnessInput = api;

// The panel: a rebind button and a few read-outs, refreshed only when their text changes.
const rebindButton = document.createElement('button');
rebindButton.type = 'button';
rebindButton.textContent = 'Rebind jump';
rebindButton.addEventListener('click', () => {
  rebindButton.blur();
  void api.listen('jump');
});
const lines = {
  bindings: document.createElement('div'),
  conflicts: document.createElement('div'),
  hold: document.createElement('div'),
  chord: document.createElement('div'),
  glyph: document.createElement('div'),
  gesture: document.createElement('div'),
};
const holdBar = document.createElement('div');
holdBar.className = 'bar';
const holdFill = document.createElement('div');
holdBar.append(holdFill);
panel.append(
  rebindButton,
  lines.bindings,
  lines.conflicts,
  lines.hold,
  holdBar,
  lines.chord,
  lines.glyph,
  lines.gesture,
);
const shown: Record<keyof typeof lines, string> = {
  bindings: '',
  conflicts: '',
  hold: '',
  chord: '',
  glyph: '',
  gesture: '',
};
function show(key: keyof typeof lines, text: string): void {
  if (shown[key] === text) return;
  shown[key] = text;
  lines[key].textContent = text;
}
let shownFill = -1;
function refreshPanel(): void {
  show(
    'bindings',
    state.listening
      ? `press a key for ${state.listening} (Escape cancels)`
      : `jump: ${input
          .bindings()
          .jump.map((b) => glyphForBinding(b).label)
          .join(' / ')}`,
  );
  show(
    'conflicts',
    state.conflicts.length ? `conflicts: ${state.conflicts.join('; ')}` : 'no conflicts',
  );
  show('hold', `hold C: fired ${state.holdFired}`);
  const fill = Math.round(state.holdProgress * 100);
  if (fill !== shownFill) {
    shownFill = fill;
    holdFill.style.width = `${fill}%`;
  }
  show('chord', `Shift+K: fired ${state.chordFired}, rumbles ${state.rumbles}`);
  show('glyph', `${state.lastDevice}: jump is "${state.glyph}"`);
  show('gesture', `gesture: ${state.panOrLong ?? '-'}`);
}

/** A unit cube centred on the origin, 24 vertices (12 floats each), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const [n, r, u] of faces) {
    const base = v / 12;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (n[k]! + sx * r[k]! + sy * u[k]!) * 0.5;
      vertices[v + 3] = n[0]!;
      vertices[v + 4] = n[1]!;
      vertices[v + 5] = n[2]!;
      vertices[v + 6] = (sx + 1) / 2;
      vertices[v + 7] = (1 - sy) / 2;
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += 12;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
    i += 6;
  }
  return { vertices, indices };
}

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const PITCH_LIMIT = 1.4;
const DISTANCE = 4;
const eye = new Float32Array(3);
const target = new Float32Array(3);

/** The eye orbits the cube at `DISTANCE`: yaw turns it around +y, pitch lifts it. */
function placeCamera(camera: Camera): void {
  const cp = Math.cos(state.pitch);
  eye[0] = Math.sin(state.yaw) * cp * DISTANCE;
  eye[1] = Math.sin(state.pitch) * DISTANCE;
  eye[2] = Math.cos(state.yaw) * cp * DISTANCE;
  camera.lookAt(eye, target);
}

function tick(): void {
  input.update();
  state.ticks++;
  state.yaw += look.look.dx;
  state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch + look.look.dy));
  state.locked = look.locked;
  state.listening = input.listeningFor();
  const charge = input.state('charge');
  state.holdProgress = charge.holdProgress;
  if (charge.pressed) {
    state.holdFired++;
    state.holdFiredAfterMs = chargeDownAt < 0 ? -1 : performance.now() - chargeDownAt;
  }
  if (input.pressed('combo')) {
    state.chordFired++;
    input.rumble({ strong: 0.6, weak: 0.3, ms: 120 });
  }
  if (input.pressed('pan')) state.panOrLong = 'pan';
  if (input.pressed('long')) state.panOrLong = 'longPress';
  state.lastDevice = input.lastDevice;
  state.glyph = input.glyphFor('jump')?.label ?? '';
  refreshPanel();
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine input demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((60 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  placeCamera(camera);

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const cubeT = new Transform({ scaleX: 1.6, scaleY: 1.6, scaleZ: 1.6 });
  const cubeP = { tint: [0.85, 0.55, 0.25, 1] as [number, number, number, number] };

  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];

  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  const loop = new GameLoop({
    update() {
      tick();
      placeCamera(camera);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(cube, lit, cubeT, cubeP);
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
