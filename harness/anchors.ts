/**
 * Anchors demo page (ws/anchors): DOM that follows world points, through `createGame`. Noun-free;
 * the scene and the labels are what a game would write.
 *
 * - A field of cubes under a perspective camera (`ctx.camera`, re-aimed in place), a label over
 *   each, built with `ctx.ui.anchors(() => ctx.camera)` on the overlay's `hud` layer. The engine
 *   updates the anchors after every frame; the page never calls `update()`.
 * - `behind`: a label at a point behind the default camera, so it is hidden.
 * - `marker`: a clamped marker on the far cube, which stays inside the viewport when the cube
 *   leaves it (`aim` turns the camera away).
 *
 * e2e/anchors.spec.ts reads `window.__harnessAnchors.state()`.
 */
import { createGame } from '@thunderclap-engine/engine';
import {
  type InstanceParams,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { AnchorHandle } from '@thunderclap-engine/engine/ui';
import type { AnchorsBox, HarnessAnchorsApi, HarnessAnchorsState } from './anchors-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const EYE: [number, number, number] = [0, 6, 12];
const TARGET: [number, number, number] = [0, 0, 0];
const SPACING = 3;
const FAR_CUBE: [number, number, number] = [7, 0.5, -7];

const state: HarnessAnchorsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  canvas: { x: 0, y: 0, width: 0, height: 0 },
  viewProjection: [],
  screen: { x: 0, y: 0, width: 0, height: 0 },
  labels: [],
};

let read: () => HarnessAnchorsState = () => state;
let aim: HarnessAnchorsApi['aim'] = () => {
  throw new Error('not booted');
};
window.__harnessAnchors = { state: () => read(), aim: (e, t) => aim(e, t) };

/** A unit cube centred on the origin in `VERTEX_LAYOUT_3D` (a normal per face), white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      const u = (axis + 1) % 3;
      const w = (axis + 2) % 3;
      const base = v / 12;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const p = [0, 0, 0];
        p[axis] = sign * 0.5;
        p[u] = a * 0.5 * sign;
        p[w] = b * 0.5;
        vertices.set([p[0]!, p[1]!, p[2]!], v);
        vertices[v + 3 + axis] = sign;
        vertices.set([(a + 1) / 2, (1 - b) / 2, 1, 1, 1, 1], v + 6);
        v += 12;
      }
      indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
      i += 6;
    }
  }
  return { vertices, indices };
}

const WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let light = 0.45 + 0.35 * max(n.y, 0.0) + 0.2 * abs(n.x);
  var o: FragOut;
  o.color = vec4f(in.color.rgb * light, 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

function box(r: DOMRect): AnchorsBox {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

async function main(): Promise<void> {
  const ctx = await createGame({
    root,
    title: 'Engine anchors demo',
    design: LOGICAL,
    input: { bindings: { tap: [{ mouse: 0 }] } },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const { renderer, camera, ui, surface } = ctx;
  camera.setPerspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  camera.lookAt(EYE, TARGET);
  camera.depthTest = true;
  camera.depthWrite = true;
  aim = (eye, target) => {
    camera.lookAt(eye, target);
  };

  const material = renderer.createMaterial({ label: 'anchors', blend: 'opaque', wgsl: WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = new Transform({ y: -0.05, scaleX: 24, scaleY: 0.1, scaleZ: 24 });
  const groundP: InstanceParams = { tint: [0.3, 0.34, 0.28, 1] };
  const cubes: { t: Transform; p: InstanceParams }[] = [];

  const anchors = ui.anchors(() => camera);
  const handles: { id: string; h: AnchorHandle; world: [number, number, number] }[] = [];
  const label = (id: string, text: string, world: [number, number, number]) => {
    const el = document.createElement('div');
    el.className = 'label';
    el.textContent = text;
    el.dataset.id = id;
    handles.push({ id, h: anchors.add(el, world), world });
  };

  let n = 0;
  for (let gz = -1; gz <= 1; gz++) {
    for (let gx = -1; gx <= 1; gx++) {
      const x = gx * SPACING;
      const z = gz * SPACING;
      const hue = n / 9;
      cubes.push({
        t: new Transform({ x, y: 0.5, z }),
        p: { tint: [0.4 + 0.6 * hue, 0.5, 1 - 0.6 * hue, 1] },
      });
      label(`label-${n}`, `#${n}`, [x, 1.3, z]);
      n++;
    }
  }
  cubes.push({
    t: new Transform({ x: FAR_CUBE[0], y: FAR_CUBE[1], z: FAR_CUBE[2] }),
    p: { tint: [1, 0.85, 0.2, 1] },
  });
  label('behind', 'behind', [0, 1, 30]);
  const markerEl = document.createElement('div');
  markerEl.className = 'marker';
  const markerWorld: [number, number, number] = [FAR_CUBE[0], 1.3, FAR_CUBE[2]];
  handles.push({
    id: 'marker',
    h: anchors.add(markerEl, markerWorld, { clamp: true, margin: 16 }),
    world: markerWorld,
  });

  ctx.stack.push({
    render(frame) {
      frame.clear(0.05, 0.07, 0.12);
      frame.mesh(cube, material, ground, groundP);
      for (const c of cubes) frame.mesh(cube, material, c.t, c.p);
    },
  });
  ctx.hooks.afterRender = () => {
    state.frames++;
  };

  read = () => {
    state.canvas = box(surface.canvas.getBoundingClientRect());
    state.viewProjection = Array.from(camera.viewProjection);
    const s = camera.screen;
    state.screen = { x: s.x, y: s.y, width: s.width, height: s.height };
    state.labels = handles.map(({ id, h, world }) => ({
      id,
      world,
      rect: box(h.el.getBoundingClientRect()),
      hidden: h.el.hidden === true,
      clamped: h.el.hasAttribute('data-anchor-clamped'),
    }));
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
