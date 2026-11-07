/**
 * XR harness page (ws/xr). Boots through `createGame` with the `xr` option, draws a lit scene
 * (ground, a turning block, a marker in front of the head) and offers "Enter VR".
 *
 * - e2e/xr.spec.ts, on the whole matrix: the page boots, the scene renders on the page and
 *   `ctx.xr.supported()` is false (headless Chromium has no WebXR device), so the button stays
 *   disabled and the ordinary single-camera path is what the spec sees.
 * - On a headset browser (or a desktop Chrome with an XR runtime) the button enters an
 *   immersive session: the same scene renders once per eye into the session's layer, and the
 *   controllers are `ctx.pointers` rays; leaving restores the page.
 */
import { createGame, type EngineCtx } from '@thunderclap-engine/engine';
import {
  Camera,
  type Frame,
  type InstanceParams,
  Lights,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessXrState } from './xr-state';

const root = document.getElementById('root') as HTMLElement;
const button = document.getElementById('enter-vr') as HTMLButtonElement;

const state: HarnessXrState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  supported: null,
  active: false,
  enters: 0,
  exits: 0,
  lastError: null,
};

window.__harnessXr = {
  state: () => state,
  enter: () => Promise.reject(new Error('not booted')),
  exit: () => Promise.resolve(),
};

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** A unit cube centred on the origin in `VERTEX_LAYOUT_3D` (12 floats: p, n, uv, rgba), white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  // Each face: normal, then the tangent pair that spans it (right, up).
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

async function main(): Promise<void> {
  const ctx = await createGame<'select', null>({
    root,
    title: 'Engine harness: XR',
    input: { bindings: { select: [{ mouse: 0 }, { xr: 'trigger' }] } },
    xr: {
      referenceSpace: 'local-floor',
      onEnter: () => {
        state.enters++;
        button.textContent = 'Exit VR';
      },
      onExit: () => {
        state.exits++;
        button.textContent = 'Enter VR';
      },
    },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  state.gpu = 'ok';
  wire(ctx);
  state.supported = await ctx.xr.supported();
  button.disabled = !state.supported;
  button.addEventListener('click', () => {
    const toggled = ctx.xr.active ? ctx.xr.exit() : ctx.xr.enter();
    toggled.catch((err: unknown) => {
      state.lastError = err instanceof Error ? err.message : String(err);
      console.warn('[harness] xr', err);
    });
  });
  window.__harnessXr = {
    state: () => state,
    enter: () => ctx.xr.enter(),
    exit: () => ctx.xr.exit(),
  };
  state.ready = true;
}

/** The scene: a lit ground and a turning block 2 m ahead, and a marker in front of the head. */
function wire(ctx: EngineCtx<'select', null>): void {
  const { renderer, surface } = ctx;
  const lit = renderer.createMaterial({ label: 'xr-lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = new Transform({ y: -0.05, z: -2, scaleX: 6, scaleY: 0.1, scaleZ: 6 });
  const block = new Transform({ y: 0.5, z: -2, scaleX: 0.6, scaleY: 1, scaleZ: 0.6 });
  const marker = new Transform({ scaleX: 0.1, scaleY: 0.1, scaleZ: 0.1 });
  const groundP: InstanceParams = { tint: [0.3, 0.5, 0.3, 1] };
  const blockP: InstanceParams = { tint: [0.9, 0.4, 0.2, 1] };
  const markerP: InstanceParams = { tint: [1, 1, 0.2, 1] };
  const lights = new Lights();
  lights.ambient.set([0.22, 0.22, 0.28]);
  lights.sun.direction = new Float32Array([0.4, -1, -0.3]);
  lights.sun.color = new Float32Array([0.9, 0.85, 0.8]);

  // On the page: a standing viewer 1.6 m up looking down -z, the frame a headset gives.
  const camera = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
  camera.lookAt([0, 1.6, 0], [0, 1, -2], [0, 1, 0]);
  renderer.camera = camera;
  const fitAspect = () => {
    const { width, height } = surface.backbuffer;
    camera.setPerspective(Math.PI / 3, width / Math.max(1, height), 0.1, 100);
  };
  fitAspect();
  surface.onResize(fitAspect);

  let t = 0;
  ctx.hooks.update = (dt) => {
    t += dt;
  };
  ctx.stack.push({
    render(frame: Frame, cam: Camera) {
      frame.clear(0.05, 0.06, 0.1);
      frame.lights.ambient.set(lights.ambient);
      frame.lights.sun.direction = lights.sun.direction;
      frame.lights.sun.color = lights.sun.color;
      frame.mesh(cube, lit, ground, groundP);
      block.setAxisAngle(0, 1, 0, t * 0.5);
      frame.mesh(cube, lit, block, blockP);
      // 0.6 m ahead of whatever head renders: the page camera, or the XR head between the eyes.
      const p = cam.position;
      marker.setPosition(p[0]!, p[1]!, p[2]! - 0.6);
      frame.mesh(cube, lit, marker, markerP);
    },
  });
  ctx.hooks.afterRender = () => {
    state.frames++;
    state.active = ctx.xr.active;
  };
  ctx.loop.start();
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
