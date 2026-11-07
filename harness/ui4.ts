/**
 * UI 4 demo page (ws/ui-4): a lit ground with four blocks under the overlay, one mode per query.
 * Noun-free; the scene is what a game would write, the widgets are the engine's.
 *
 * - `?floats`: a floating number spawns over a block every 100 ms, and a click spawns a crit
 *   (`ui.floats(camera)`, ws/ui-6); `live`, `pooled`.
 * - `?ring`: a radial progress ring fills over 3 s and wraps (`ui.ring`); `value`.
 * - `?compass`: the camera orbits and a compass strip follows its heading with two markers
 *   (`ui.compass`); `heading`, `markers`.
 * - `?minimap`: a canvas minimap with four markers around a centre that circles the scene
 *   (`ui.minimap`, player-up, `worldRadius`, ws/ui-6); `onRim` (from `markerAt`), `rimDrawn`
 *   (the map's own count as drawn) and `mapMarkers`.
 * - `?modal`: a world cursor and `PadNav` on a fake pad; the page holds the d-pad down so the
 *   cursor latches, then opens a modal panel at t = 1 s; `padOwner`, `cursorLatched`,
 *   `padOwnerChanges`.
 *
 * `?still` (or `park(true)`) stops the clock (E-017).
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
import {
  button,
  createOverlay,
  type MinimapMarker,
  type MinimapMarkerPlace,
  type PadLike,
  PadNav,
  type PanelHandle,
} from '@thunderclap/engine/ui';
import type { HarnessUi4Api, HarnessUi4Mode, HarnessUi4State } from './ui4-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const MODES: HarnessUi4Mode[] = ['floats', 'ring', 'compass', 'minimap', 'modal'];
const mode = MODES.find((m) => query.has(m)) ?? 'floats';

const state: HarnessUi4State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  mode,
  parked: query.has('still'),
  t: 0,
  live: 0,
  pooled: 0,
  value: 0,
  heading: 0,
  markers: {},
  onRim: 0,
  onRimSeen: [],
  rimDrawn: 0,
  mapMarkers: 0,
  padOwner: 'game',
  cursorLatched: false,
  latchedBeforeModal: false,
  padOwnerChanges: 0,
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
const ORBIT = { pitch: 0.3, distance: 10 };
const ORBIT_RAD_PER_S = 0.5;
const BLOCKS: [number, number, number][] = [
  [3, 0.5, 0],
  [-3, 0.5, 0],
  [0, 0.5, 3],
  [0, 0.5, -3],
];
const RING_PERIOD_S = 3;
const FLOAT_EVERY_S = 0.1;
const MODAL_AT_S = 1;
const MAP_RADIUS = 6;

const eye = new Float32Array(3);
let yaw = 0;

function placeCamera(camera: Camera): void {
  const cp = Math.cos(ORBIT.pitch);
  eye[0] = TARGET[0] + ORBIT.distance * Math.sin(yaw) * cp;
  eye[1] = TARGET[1] + ORBIT.distance * Math.sin(ORBIT.pitch);
  eye[2] = TARGET[2] + ORBIT.distance * Math.cos(yaw) * cp;
  camera.lookAt(eye, TARGET);
}

/** The camera's heading: degrees clockwise from north (−z), looking from the eye to the target. */
function headingDeg(): number {
  const dx = TARGET[0] - eye[0];
  const dz = TARGET[2] - eye[2];
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine UI 4 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);

  const ui = createOverlay({ parent: root, caption: { reducedMotion: true } });
  surface.onResize(({ rect, backbuffer }) => {
    renderer.resize(backbuffer.width, backbuffer.height);
    ui.setFrame(rect);
  });

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  placeCamera(camera);
  ui.anchors(() => camera);

  // The fake pad `?modal` drives: the page presses it, never the browser.
  const pad: PadLike & { buttons: { pressed: boolean }[] } = {
    buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
    axes: [0, 0, 0, 0],
  };
  const pads = (): readonly (PadLike | null)[] => [pad];

  let panel: PanelHandle | null = null;
  const api: HarnessUi4Api = {
    state,
    park(on) {
      state.parked = on;
    },
    closeModal() {
      panel?.close();
    },
    press(i, down) {
      const b = pad.buttons[i];
      if (b) b.pressed = down;
    },
  };
  window.__harnessUi4 = api;

  // ---- the mode's widgets
  let perFrame: (dt: number) => void = () => {};
  if (mode === 'floats') {
    const floats = ui.floats(() => camera);
    const at = new Float32Array(3);
    let clock = 0;
    let n = 0;
    // A click (or tap) spawns a crit over the first block, on top of the steady stream.
    root.addEventListener('pointerdown', () => {
      const [x, y, z] = BLOCKS[0]!;
      at.set([x, y + 1, z]);
      floats.spawn('CRIT', at, { crit: true, color: 'var(--tc-color-warn)' });
    });
    // Damage, heal, a crit and plain text in turn, as the theme colours them.
    const COLORS = ['var(--tc-color-danger)', 'var(--tc-color-success)', 'var(--tc-color-warn)'];
    perFrame = (dt) => {
      clock += dt;
      while (clock >= FLOAT_EVERY_S) {
        clock -= FLOAT_EVERY_S;
        const [x, y, z] = BLOCKS[n % BLOCKS.length]!;
        const k = n % 4;
        at.set([x, y + 0.6, z]);
        floats.spawn(k === 1 ? `+${(n % 9) + 1}` : String(n % 97), at, {
          color: COLORS[k],
          crit: k === 2,
        });
        n++;
      }
      floats.update(dt);
      state.live = floats.live;
      state.pooled = floats.pooled;
    };
  } else if (mode === 'ring') {
    const ring = ui.ring({ radius: 48, thickness: 8, value: 0, label: 'Cast', region: 'bottom' });
    ring.el.id = 'ring';
    perFrame = () => {
      const v = (state.t % RING_PERIOD_S) / RING_PERIOD_S;
      ring.set(v);
      ring.setLabel(`${Math.round(v * 100)}%`);
      state.value = ring.value;
    };
  } else if (mode === 'compass') {
    const compass = ui.compass({
      width: 560,
      headingDeg: 0,
      markers: [
        { name: 'east', bearingDeg: 90, icon: 'E' },
        { name: 'north', bearingDeg: 0, icon: '^' },
      ],
      region: 'top',
    });
    compass.el.id = 'compass';
    perFrame = () => {
      compass.setHeading(headingDeg());
      state.heading = compass.heading;
      state.markers.east = compass.offsetOf('east');
      state.markers.north = compass.offsetOf('north');
    };
  } else if (mode === 'minimap') {
    const map = ui.minimap({
      size: 180,
      world: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 },
      worldRadius: 4,
      rotate: 'player',
      region: 'right',
    });
    map.el.id = 'minimap';
    const kinds = ['ally', 'enemy', 'objective', 'info'] as const;
    const markers: MinimapMarker[] = BLOCKS.map(([x, , z], i) => ({
      id: `block-${i}`,
      x,
      z,
      kind: kinds[i]!,
      icon: i === 2 ? '!' : undefined,
    }));
    const place: MinimapMarkerPlace = { x: 0, y: 0, outside: false };
    perFrame = () => {
      // The centre circles the scene; blocks further than the radius sit on the rim.
      const a = state.t * 0.6;
      const cx = Math.cos(a) * MAP_RADIUS * 0.5;
      const cz = Math.sin(a) * MAP_RADIUS * 0.5;
      map.setPlayer(cx, cz, (headingDeg() * Math.PI) / 180);
      map.setMarkers(markers);
      // Draw now, so the drawn rim count and `markerAt` read the same frame.
      map.flush();
      let onRim = 0;
      for (const m of markers) if (map.markerAt(m.id, place)?.outside) onRim++;
      state.onRim = onRim;
      if (!state.onRimSeen.includes(onRim)) state.onRimSeen.push(onRim);
      state.rimDrawn = map.rim;
      state.mapMarkers = map.markers;
    };
  } else {
    // ?modal: a grid cursor over the blocks and PadNav, both on the fake pad.
    let cell = 0;
    const cursor = ui.cursor({
      mode: 'grid',
      step: (dx) => {
        cell = (cell + dx + BLOCKS.length) % BLOCKS.length;
      },
      at: () => {
        const [x, y, z] = BLOCKS[cell]!;
        return [x, y + 0.6, z];
      },
      getGamepads: pads,
    });
    const nav = new PadNav(ui.stack, { getGamepads: pads });
    ui.stack.onPadOwnerChange(() => {
      state.padOwnerChanges++;
    });
    let opened = false;
    perFrame = () => {
      if (state.t < 0.3) {
        // Hold right so the cursor latches before the panel opens.
        pad.buttons[15]!.pressed = true;
      }
      if (!opened && state.t >= MODAL_AT_S) {
        opened = true;
        state.latchedBeforeModal = cursor.latched;
        panel = ui.stack.push({
          title: 'Paused',
          content: button('Resume', () => panel?.close()),
          onClose: () => {
            panel = null;
          },
        });
      }
      nav.update();
      cursor.update(performance.now());
      state.padOwner = ui.padOwner;
      state.cursorLatched = cursor.latched;
    };
  }

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });
  const groundT = new Transform({ scaleX: 20, scaleY: 1, scaleZ: 20 });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const blocks = BLOCKS.map(([x, y, z]) => new Transform({ x, y, z }));
  const tints: InstanceParams[] = [
    { tint: [0.3, 0.85, 0.35, 1] },
    { tint: [1.0, 0.1, 0.06, 1] },
    { tint: [0.95, 0.8, 0.2, 1] },
    { tint: [0.08, 0.28, 1.0, 1] },
  ];

  const lights = new Lights();
  lights.ambient.set([0.18, 0.18, 0.2]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];
  lights.fog.color = [0.6, 0.65, 0.75];
  lights.fog.density = 1;
  lights.fog.near = 8;
  lights.fog.far = 30;

  const loop = new GameLoop({
    update(dt) {
      if (state.parked) return;
      state.t += dt;
      if (mode === 'compass' || mode === 'minimap') {
        yaw += ORBIT_RAD_PER_S * dt;
        placeCamera(camera);
      }
      perFrame(dt);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      for (let i = 0; i < blocks.length; i++) frame.mesh(cube, lit, blocks[i]!, tints[i]!);
      renderer.endFrame();
      ui.updateAnchors();
      state.frames++;
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
