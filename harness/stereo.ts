/**
 * Stereo page (ws/xr-merge): a game in an emulated headset, drawn by the render core. The fake
 * WebXR stack runs on the page's real GPU device (`emulateXr` from `./testing`), stepped by the
 * browser's frames; `createGame({ xr })` enters it as it would a headset, and
 * `ctx.xr.setCore(core, { immediate: false })` hands both eyes to the core: each eye is a core
 * view, both eyes one `union` cull group, so a frame is one cull dispatch and a core pass per eye
 * into its half of the layer. The emulator copies the layer onto `#mirror`, where the spec
 * samples both eyes.
 *
 * The scene is static boxes in the core (a floor, a red block straight ahead at eye height, a
 * row of grey blocks behind it), flat-coloured so pixels are easy to read.
 */
import { createGame } from '@thunderclap-engine/engine';
import {
  createInstanceLayout,
  createRenderCore,
  createVertexLayout,
  gpuDiagnostics,
  installGpuErrorLogging,
} from '@thunderclap-engine/engine/render';
import { emulateXr } from '@thunderclap-engine/engine/testing';
import type { HarnessStereoState } from './stereo-state';

const root = document.getElementById('root') as HTMLElement;
const mirror = document.getElementById('mirror') as HTMLCanvasElement;

const state: HarnessStereoState = {
  ready: false,
  gpu: 'pending',
  active: false,
  frames: 0,
  mirrored: 0,
  maxDispatches: 0,
  dispatches: 0,
  views: 0,
  eyes: [],
  draws: 0,
  mirror: { width: 0, height: 0 },
  gpuErrors: 0,
};
window.__harnessStereo = { state };

/** A unit cube centred on the origin, as six quads (4 vertices each: x, y, z, pad). */
function cubeVertices(): Float32Array {
  const faces = [
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
  const v = new Float32Array(24 * 4);
  let o = 0;
  for (const [n, r, u] of faces) {
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      for (let k = 0; k < 3; k++) v[o + k] = (n![k]! + sx! * r![k]! + sy! * u![k]!) * 0.5;
      v[o + 3] = 1;
      o += 4;
    }
  }
  return v;
}

const VERTEX = createVertexLayout({
  stride: 16,
  attributes: [{ name: 'position', format: 'float32x4', offset: 0 }],
});
/** Per instance: centre and size (xyz, pad), colour. */
const INSTANCE = createInstanceLayout({
  stride: 32,
  attributes: [
    { name: 'place', format: 'float32x4', offset: 0 },
    { name: 'tint', format: 'float32x4', offset: 16 },
  ],
});

const FLAT_WGSL = /* wgsl */ `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
};
@vertex fn vs(in: VertexIn) -> Out {
  // place: centre xyz, w the size (x and z), the block's height in tint.w.
  let size = vec3f(in.place.w, in.tint.w, in.place.w);
  let w = in.place.xyz + in.position.xyz * size;
  var o: Out;
  o.clip = view.viewProj * vec4f(w, 1.0);
  // A face shade by height so the floor is told from the blocks.
  o.color = in.tint.rgb * (0.75 + 0.25 * in.position.y);
  return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}`;

/** Centre x, y, z, width/depth, then r, g, b, height. */
const BOXES: readonly (readonly number[])[] = [
  [0, -0.05, -3, 8, 0.25, 0.4, 0.25, 0.1], // floor
  [0, 1.6, -2.5, 0.8, 0.95, 0.1, 0.08, 0.8], // red block, straight ahead at eye height
  [-2, 1, -5, 1, 0.6, 0.6, 0.6, 2],
  [2, 1, -5, 1, 0.6, 0.6, 0.6, 2],
];

async function main(): Promise<void> {
  const emu = emulateXr({ eyeWidth: 320, eyeHeight: 240, mirror });
  const ctx = await createGame<'select', null>({
    root,
    title: 'Engine harness: stereo',
    input: { bindings: { select: [{ mouse: 0 }, { xr: 'trigger' }] } },
    xr: { referenceSpace: 'local' },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const device = ctx.gpu.device;
  installGpuErrorLogging(device);
  const core = createRenderCore(device);
  const vertices = core.createArena({ kind: 'vertex', blockBytes: 16 << 10, label: 'cube' });
  const instances = core.createArena({ kind: 'instance', blockBytes: 4 << 10, label: 'boxes' });
  const set = core.createDrawSet({
    label: 'stereo',
    shader: { code: FLAT_WGSL },
    vertexLayout: VERTEX,
    instanceLayout: INSTANCE,
    vertices,
    instances,
    capacity: 8,
    kind: 'static',
    cull: 'gpu',
  });
  const cube = vertices.alloc(24 * 16, 16);
  vertices.write(cube, cubeVertices());
  for (const b of BOXES) {
    const inst = instances.alloc(32, 16);
    instances.write(inst, new Float32Array(b));
    const r = 0.87 * Math.max(b[3]!, b[7]!);
    set.add({ vertices: cube, indexCount: 36, instances: inst, bounds: [b[0]!, b[1]!, b[2]!, r] });
  }
  ctx.xr.setCore(core, { immediate: false, clear: { r: 0.05, g: 0.07, b: 0.12, a: 1 } });

  // Count the core passes of each frame.
  let draws = 0;
  const draw = core.draw.bind(core);
  core.draw = (enc, i, t) => {
    draws++;
    draw(enc, i, t);
  };
  ctx.hooks.afterRender = () => {
    state.active = ctx.xr.active;
    if (!ctx.xr.active) return;
    state.frames++;
    state.dispatches = core.stats.dispatches;
    state.maxDispatches = Math.max(state.maxDispatches, core.stats.dispatches);
    state.draws = draws;
    draws = 0;
    const group = ctx.xr.surface?.group;
    state.views = group?.views.length ?? 0;
    state.eyes = (group?.views ?? []).map((v) => {
      const e = v.eye;
      return [e?.[0] ?? 0, e?.[1] ?? 0, e?.[2] ?? 0];
    });
    state.mirrored = emu.mirrored;
    state.mirror = { width: mirror.width, height: mirror.height };
    state.gpuErrors = gpuDiagnostics.errorCount;
  };
  ctx.loop.start();
  await ctx.xr.enter();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
