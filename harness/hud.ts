/**
 * HUD demo page (ws/ui-hud): the mesh page's lit scene under the overlay's HUD widgets.
 * Noun-free; the scene is what a game would write, the widgets are the engine's.
 *
 * - `ui.reticle` (a cross) at the centre of the frame, hidden while a modal panel is open.
 * - Two `ui.meter`s in the bottom-left: one full, one draining on a timer and refilling at 0.
 * - A 6-slot `ui.slots` strip in the bottom region, cycling its selection every half second.
 * - A `ui.heading` strip in the top region driven by the orbiting camera's yaw.
 *
 * `park(true)` stops the orbit, the drain and the cycling (E-017), so a spec can read a steady
 * value; `openModal()` pushes a modal panel through `ui.stack`.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import { button, createOverlay, type PanelHandle } from '@thunderclap/engine/ui';
import type { HarnessHudApi, HarnessHudState } from './hud-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessHudState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  meterValue: 100,
  selected: 0,
  yaw: 0,
  headingOffset: 0,
  reticleVisible: true,
  modal: false,
  parked: false,
};

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
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

/** A unit quad in the XZ plane (y = 0) facing +y, white. */
function groundGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  let lit = albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky);
  o.color = vec4f(engine_fog(lit, in.worldPos), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the scene

const TARGET = [0, 0.9, 0] as const;
const ORBIT = { pitch: 0.25, distance: 9 };
const ORBIT_RAD_PER_S = 0.35;
const DRAIN_PER_S = 12;
const METER_MAX = 100;
const SLOT_COUNT = 6;
const SLOT_PERIOD_S = 0.5;

const eye = new Float32Array(3);
let yaw = 0;

function placeCamera(camera: Camera): void {
  const cp = Math.cos(ORBIT.pitch);
  eye[0] = TARGET[0] + ORBIT.distance * Math.sin(yaw) * cp;
  eye[1] = TARGET[1] + ORBIT.distance * Math.sin(ORBIT.pitch);
  eye[2] = TARGET[2] + ORBIT.distance * Math.cos(yaw) * cp;
  camera.lookAt(eye, TARGET);
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine HUD demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);

  // The overlay over the canvas's parent; its frame follows the letterbox.
  const ui = createOverlay({ parent: root, caption: { reducedMotion: true } });
  surface.onResize(({ rect, backbuffer }) => {
    renderer.resize(backbuffer.width, backbuffer.height);
    ui.setFrame(rect);
  });

  const reticle = ui.reticle({ style: 'cross', size: 28, gap: 8 });
  const steady = ui.meter({ label: 'Steady', max: METER_MAX, region: 'left', order: 1 });
  steady.el.id = 'meter-steady';
  const draining = ui.meter({
    label: 'Draining',
    max: METER_MAX,
    region: 'left',
    order: 2,
    tone: 'warn',
    format: (v, max) => `${Math.round(v)} / ${max}`,
  });
  draining.el.id = 'meter-draining';
  const slots = ui.slots({
    count: SLOT_COUNT,
    hints: ['1', '2', '3', '4', '5', '6'],
    region: 'bottom',
  });
  slots.el.id = 'slots';
  for (let i = 0; i < SLOT_COUNT; i++) slots.setContent(i, String.fromCharCode(65 + i));
  const heading = ui.heading({ region: 'top' });
  heading.el.id = 'heading';

  let panel: PanelHandle | null = null;
  const api: HarnessHudApi = {
    state,
    openModal() {
      if (panel) return;
      panel = ui.stack.push({
        title: 'Paused',
        content: button('Resume', () => panel?.close()),
        onClose: () => {
          panel = null;
        },
      });
    },
    closeModal() {
      panel?.close();
    },
    park(on) {
      state.parked = on;
    },
    pulse() {
      reticle.pulse();
      return reticle.el.classList.contains('tc-reticle-pulse');
    },
  };
  window.__harnessHud = api;

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  placeCamera(camera);

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });
  const groundT = new Transform({ scaleX: 16, scaleY: 1, scaleZ: 16 });
  const near = new Transform({ x: 0, y: 0.5, z: 1.5 });
  const far = new Transform({ x: 0, y: 1.5, z: -0.5, scaleX: 2, scaleY: 3, scaleZ: 1 });
  const left = new Transform({ x: -3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const right = new Transform({ x: 3.2, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const nearP: InstanceParams = { tint: [1.0, 0.1, 0.06, 1] };
  const farP: InstanceParams = { tint: [0.08, 0.28, 1.0, 1] };
  const leftP: InstanceParams = { tint: [0.3, 0.85, 0.35, 1] };
  const rightP: InstanceParams = { tint: [0.95, 0.8, 0.2, 1] };

  const lights = new Lights();
  lights.ambient.set([0.18, 0.18, 0.2]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];
  lights.sun.shadow = { extent: 20, size: 2048 };
  lights.fog.color = [0.6, 0.65, 0.75];
  lights.fog.density = 1;
  lights.fog.near = 6;
  lights.fog.far = 24;

  let meterValue = METER_MAX;
  let slotClock = 0;
  let selected = 0;
  let spin = 0;

  const loop = new GameLoop({
    update(dt) {
      if (state.parked) return;
      yaw += ORBIT_RAD_PER_S * dt;
      spin += dt;
      meterValue -= DRAIN_PER_S * dt;
      if (meterValue <= 0) meterValue = METER_MAX;
      slotClock += dt;
      if (slotClock >= SLOT_PERIOD_S) {
        slotClock -= SLOT_PERIOD_S;
        selected = (selected + 1) % SLOT_COUNT;
      }
      placeCamera(camera);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      left.setAxisAngle(0, 1, 0, spin * 0.6);
      right.setAxisAngle(1, 1, 0, spin * 0.4);
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, near, nearP);
      frame.mesh(cube, lit, far, farP);
      frame.mesh(cube, lit, left, leftP);
      frame.mesh(cube, lit, right, rightP);
      renderer.endFrame();

      // The HUD follows the scene after the frame is recorded.
      draining.set(meterValue);
      slots.select(selected);
      heading.setYaw(yaw);
      state.frames++;
      state.meterValue = draining.value;
      state.selected = slots.selected;
      state.yaw = yaw;
      state.headingOffset = heading.offset;
      state.modal = ui.stack.hasModal;
      state.reticleVisible = reticle.visible && !reticle.el.hasAttribute('data-modal');
      if (gpuDiagnostics.errorCount > 0 && state.gpu === 'ok') state.gpu = 'error: gpu errors';
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
