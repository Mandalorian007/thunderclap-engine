/**
 * Look controls page (ws/look): a first-person walk over the mesh page's cube field, driven only
 * by `Look`'s `look` and `move`. Noun-free; the camera maths is what a game would write.
 *
 * - Desktop: click the canvas to take the pointer lock, then the mouse looks; WASD and the arrows
 *   move. Escape (the browser) gives the lock back.
 * - Touch: a finger on the left half is a move stick, a finger on the right half drags the view.
 * - Pad: left stick moves, right stick looks.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { Input, Look } from '@thunderclap/engine/input';
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
import type { HarnessLookApi, HarnessLookState } from './look-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessLookState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  yaw: 0,
  pitch: 0,
  position: [0, 1.6, 8],
  locked: false,
  stick: false,
  instances: 0,
  gpuErrors: 0,
};

const look = new Look({
  keys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
});

const api: HarnessLookApi = {
  state,
  request: () => look.request(),
  release: () => look.release(),
};
window.__harnessLook = api;

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
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const WALK_PER_S = 4;
const PITCH_LIMIT = 1.4;
const eye = new Float32Array(3);
const target = new Float32Array(3);

function placeCamera(camera: Camera): void {
  const cp = Math.cos(state.pitch);
  eye[0] = state.position[0];
  eye[1] = state.position[1];
  eye[2] = state.position[2];
  // Yaw 0 looks down -z; positive yaw turns right (towards +x).
  target[0] = eye[0] + Math.sin(state.yaw) * cp;
  target[1] = eye[1] + Math.sin(state.pitch);
  target[2] = eye[2] - Math.cos(state.yaw) * cp;
  camera.lookAt(eye, target);
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine look controls demo' });
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

  // The field: a flat ground slab and a 5×5 grid of blocks of varying height.
  const groundT = new Transform({ y: -0.5, scaleX: 40, scaleY: 1, scaleZ: 40 });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const blocks: { t: Transform; p: InstanceParams }[] = [];
  for (let gx = -2; gx <= 2; gx++) {
    for (let gz = -2; gz <= 2; gz++) {
      const h = 0.6 + ((gx * 7 + gz * 13 + 20) % 5) * 0.4;
      blocks.push({
        t: new Transform({ x: gx * 3, y: h / 2, z: gz * 3, scaleY: h }),
        p: { tint: [0.3 + 0.12 * (gx + 2), 0.35, 0.3 + 0.12 * (gz + 2), 1] },
      });
    }
  }

  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];

  // The two lines a first-person game adds: build a Look and link it.
  const input = new Input({}, { look });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  // Browsers grant the pointer lock only inside a gesture: ask on a mouse click.
  surface.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !look.locked) void look.request();
  });

  const loop = new GameLoop({
    update(dt) {
      input.update();
      state.yaw += look.look.dx;
      state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch + look.look.dy));
      const fx = Math.sin(state.yaw);
      const fz = -Math.cos(state.yaw);
      const step = WALK_PER_S * dt;
      state.position[0] += (fx * look.move.y + -fz * look.move.x) * step;
      state.position[2] += (fz * look.move.y + fx * look.move.x) * step;
      state.locked = look.locked;
      state.stick = look.stick.active;
      placeCamera(camera);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(cube, lit, groundT, groundP);
      for (const b of blocks) frame.mesh(cube, lit, b.t, b.p);
      renderer.endFrame();
      state.frames++;
      state.instances = renderer.stats.instances;
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
