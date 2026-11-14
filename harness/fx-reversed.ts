/**
 * Reversed-Z effects page (ws/fx-fit, B9): every core effect on a reversed-Z render core
 * (`createRenderCore(gpu, { reversedZ: true })`, an infinite reversed projection), none of
 * them told anything but by the pass they draw in. A lit ground and three blocks (one static
 * draw set) under a sky pass with a game shade hook (the default dome tinted by
 * `sky_param(0)`), `Water`, a `ParticleSystem` fountain, a lit-box `ParticleSystem`
 * (`shape: 'box'`) of debris, `Weather` rain with splashes on a wrapping occlusion map and a
 * held `Lightning` bolt. `api.set({ show })` takes one effect off the core, `api.set({ paused })`
 * freezes them all so on/off pictures compare; `?standard` builds the same scene on a standard
 * core. `?fit` (ws/fx-fit) builds it as a game fitting its renderer would: the sky a member of
 * the opaque pass with a hook and no `SkyLook`, the fountain in a pass of its own, debris lit boxes
 * with an emit axis, colour jitter, flutter and flat boxes, eight weather layers (a leaf one
 * among them) on a floored occlusion map. Nothing here is a game.
 */

import {
  createSkyPass,
  ParticleSystem,
  type PrecipLayer,
  Water,
} from '@thunderclap-engine/engine/fx';
import { Lightning, WEATHER_RAIN_SPLASHES, Weather } from '@thunderclap-engine/engine/fx/weather';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CoreTarget,
  createInstanceLayout,
  createRenderCore,
  createRenderView,
  createVertexLayout,
  gpuDiagnostics,
  installGpuErrorLogging,
  setViewFromCamera,
} from '@thunderclap-engine/engine/render';
import type { FxReversedEffect, FxReversedSet, HarnessFxReversedState } from './fx-reversed-state';

const root = document.getElementById('root') as HTMLElement;
const query = new URLSearchParams(location.search);
const reversedZ = !query.has('standard');
const fit = query.has('fit');

const state: HarnessFxReversedState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  gpuErrors: 0,
  paused: query.has('still'),
  reversedZ,
  show: { water: true, particles: true, boxes: true, weather: true, lightning: true },
  skyTint: [0, 0, 0],
  horizon: [0, 0, 0],
  skyDraws: 0,
  weatherInstances: 0,
  drawables: 0,
  fit,
  passes: 0,
  particleDraws: 0,
  boxDraws: 0,
  weatherLayers: 0,
  passOrder: [],
};
let apply: (o: FxReversedSet) => void = (o) => {
  if (o.paused !== undefined) state.paused = o.paused;
};
window.__harnessFxReversed = { state, set: (o) => apply(o) };

/** Position (3) and normal (3) per vertex; a box is six quads on the core's shared quad index. */
const MESH = createVertexLayout({
  stride: 24,
  attributes: [
    { name: 'position', format: 'float32x3', offset: 0 },
    { name: 'normal', format: 'float32x3', offset: 12 },
  ],
});
/** Per instance: centre and half size (xyz), colour. */
const PLACE = createInstanceLayout({
  stride: 32,
  attributes: [
    { name: 'place', format: 'float32x4', offset: 0 },
    { name: 'half', format: 'float32x4', offset: 16 },
  ],
});

const LIT_WGSL = /* wgsl */ `
struct Out { @builtin(position) clip: vec4f, @location(0) n: vec3f, @location(1) c: vec3f };
@vertex fn vs(in: VertexIn) -> Out {
  var o: Out;
  o.clip = view.viewProj * vec4f(in.place.xyz + in.position * in.half.xyz, 1.0);
  o.n = in.normal;
  o.c = vec3f(in.place.w, in.half.w, 0.5 * (in.place.w + in.half.w));
  return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let d = max(dot(normalize(in.n), normalize(vec3f(0.45, 1.0, 0.65))), 0.0);
  return vec4f(in.c * (0.25 + 0.75 * d), 1.0);
}`;

/** A unit box (-1..1): six quads of 4 vertices, outward normals, counter-clockwise from outside. */
function box(): Float32Array {
  const out = new Float32Array(24 * 6);
  let o = 0;
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [-1, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const corner = (a: number, b: number) => {
        const p = [0, 0, 0];
        p[axis] = side;
        p[u] = a * side;
        p[v] = b;
        out.set(p, o);
        out[o + 3 + axis] = side;
        o += 6;
      };
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        corner(a, b);
      }
    }
  }
  return out;
}

/** An infinite reversed-Z perspective (near maps to depth 1, infinity to 0). */
function reversedProjection(out: Float32Array, fovY: number, aspect: number, near: number): void {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  out[14] = near;
}

/** The hook: the default dome, plus `sky_param(0)` (rgb) towards the zenith. */
const SKY_SHADE = /* wgsl */ `
fn sky_look(i: SkyInput) -> SkyShade {
  var s = sky_shade(i.dir, i.sun_dir, i.sun_color, i.fog);
  s.color += sky_param(0u).rgb * max(i.dir.y, 0.0);
  return s;
}`;

/** ?fit: no `SkyLook`, so the hook paints the whole dome (a gradient), tinted the same way. */
const SKY_FIT_SHADE = /* wgsl */ `
fn sky_look(i: SkyInput) -> SkyShade {
  var s = sky_shade(i.dir, i.sun_dir, i.sun_color, i.fog);
  let up = max(i.dir.y, 0.0);
  s.color += mix(vec3f(0.62, 0.7, 0.82), vec3f(0.16, 0.3, 0.66), up) + sky_param(0u).rgb * up;
  return s;
}`;

/** ?fit: rain and splashes, a leaf layer and five thin ones: eight layers in one draw. */
const LEAVES: PrecipLayer = {
  shape: 'leaf',
  count: 400,
  radius: 8,
  height: 7,
  speed: 0.8,
  windFactor: 0.6,
  length: 0.22,
  width: 0.12,
  color: [0.45, 0.6, 0.2],
  alpha: 1,
  flutter: 0.4,
};
const FIT_LAYERS: PrecipLayer[] = [
  ...WEATHER_RAIN_SPLASHES.layers,
  LEAVES,
  ...Array.from({ length: 5 }, (_, i) => ({
    ...LEAVES,
    count: 40,
    color: [0.6, 0.3 + i * 0.1, 0.1] as const,
  })),
];

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine reversed-Z effects demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { gpu } = res;
  installGpuErrorLogging(gpu.device);
  gpu.context.configure({
    device: gpu.device,
    format: gpu.format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const core = createRenderCore(gpu, { reversedZ });

  const look = {
    zenith: [0.16, 0.3, 0.66],
    horizon: [0.62, 0.7, 0.82],
    ground: [0.3, 0.28, 0.25],
    sunSize: 0.03,
    sunGlow: 1,
    stars: null,
    exposure: 1,
    ambientFloor: 0.06,
  };
  // ?fit: no SkyLook (the hook paints a dome of its own), drawn in the opaque pass.
  const sky = fit
    ? createSkyPass(core, null, { shade: SKY_FIT_SHADE, params: 1, member: 'opaque' })
    : createSkyPass(core, look, { shade: SKY_SHADE, params: 1 });
  sky.sunDir.set([-0.4, -0.6, -0.7]);

  const vertices = core.createArena({ kind: 'vertex', blockBytes: 16 << 10, label: 'boxes' });
  const instances = core.createArena({ kind: 'instance', blockBytes: 4 << 10, label: 'places' });
  const set = core.createDrawSet({
    label: 'scene',
    shader: { code: LIT_WGSL },
    vertexLayout: MESH,
    instanceLayout: PLACE,
    vertices,
    instances,
    capacity: 8,
    kind: 'static',
    cull: 'gpu',
  });
  const mesh = vertices.alloc(24 * 24, 24);
  vertices.write(mesh, box());
  const place = (c: number[], half: number[], r: number, g: number): void => {
    const inst = instances.alloc(32, 32);
    instances.write(
      inst,
      new Float32Array([c[0]!, c[1]!, c[2]!, r, half[0]!, half[1]!, half[2]!, g]),
    );
    set.add({
      vertices: mesh,
      indexCount: 36,
      instances: inst,
      bounds: [c[0]!, c[1]!, c[2]!, Math.hypot(half[0]!, half[1]!, half[2]!)],
    });
  };
  place([0, -0.05, 0], [14, 0.05, 14], 0.55, 0.5);
  place([0, 1.5, -2], [1, 1.5, 0.5], 0.1, 0.3);
  place([-3.2, 0.6, 0.4], [0.6, 0.6, 0.6], 0.3, 0.85);
  place([3, 0.6, 0], [0.6, 0.6, 0.6], 0.95, 0.8);

  const water = new Water(core, {
    size: [5, 3],
    segments: [20, 12],
    origin: [-1.2, 0, 3],
    level: 0.25,
    depthFade: 0.8,
  });
  // ?fit: the fountain in a pass of the game's own (soft particles read depth: a read pass).
  if (fit) core.definePass({ id: 'late', after: 'transparent', depth: 'read' });
  const fountain = new ParticleSystem(core, {
    capacity: 4096,
    softness: 0.3,
    ...(fit ? { pass: 'late', order: 5 } : {}),
  });
  const debris = new ParticleSystem(core, { capacity: 1024, shape: 'box' });
  const lit = debris.coreDrawable!.boxLight;
  if (fit) {
    lit.fog.color.set([0.5, 0.55, 0.65]);
    lit.fog.density = 0.02;
  }
  lit.sunDir.set([-0.4, -0.6, -0.7]);
  lit.sunColor.set([1.2, 1.1, 0.95]);
  lit.ambient.set([0.25, 0.3, 0.4]);
  // Rain stops on a wrapping 4×4 occlusion map (a roof over every other cell).
  const occl = gpu.device.createTexture({
    size: [4, 4],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const heights = new Float32Array(16);
  // ?fit: the heights carry a fraction the decode floors away (3.6 stops at 3).
  for (let i = 0; i < 16; i++) heights[i] = (i + (i >> 2)) % 2 === 0 ? 0 : fit ? 3.6 : 3;
  gpu.device.queue.writeTexture({ texture: occl }, heights, { bytesPerRow: 16 }, [4, 4]);
  const weather = new Weather(core, {
    ...WEATHER_RAIN_SPLASHES,
    ...(fit ? { layers: FIT_LAYERS } : {}),
    occlusionHeight: 0,
  });
  weather.setOcclusionMap({
    texture: occl,
    origin: [0, 0],
    size: [8, 8],
    wrap: true,
    ...(fit ? { decode: { floor: true } } : {}),
  });
  const lightning = new Lightning(core, { fadeTime: 1e6, height: 40 });
  lightning.strike(5, 0, -10, 11);

  const drawables: Record<FxReversedEffect, Parameters<typeof core.addDrawable>[0]> = {
    water: water.coreDrawable!,
    particles: fountain.coreDrawable!,
    boxes: debris.coreDrawable!,
    weather,
    lightning,
  };
  apply = (o) => {
    if (o.paused !== undefined) state.paused = o.paused;
    if (o.skyTint) state.skyTint = [...o.skyTint];
    if (o.clear) {
      fountain.clear();
      debris.clear();
    }
    for (const k of Object.keys(o.show ?? {}) as FxReversedEffect[]) {
      const on = o.show![k]!;
      if (on === state.show[k]) continue;
      if (on) core.addDrawable(drawables[k]);
      else core.removeDrawable(drawables[k]);
      state.show[k] = on;
    }
  };

  const fovY = (55 * Math.PI) / 180;
  const camera = Camera.perspective(fovY, 1, 0.1, 100);
  const proj = new Float32Array(16);
  const view = createRenderView();
  const target: CoreTarget = {
    view: undefined as unknown as GPUTextureView,
    format: gpu.format,
    width: 1,
    height: 1,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  };
  const spray = {
    x: 1.5,
    y: 0.2,
    z: 1.5,
    angle: Math.PI / 2,
    spread: 0.35,
    speed: [3.5, 5] as [number, number],
    life: [1.2, 1.8] as [number, number],
    size: [0.12, 0.22] as [number, number],
    colorStart: [1, 0.55, 0.15, 1],
    colorEnd: [1, 0.15, 0.05, 0],
    gravity: [0, -6, 0] as [number, number, number],
  };
  const chunks = {
    ...spray,
    x: -3.2,
    y: 1.3,
    z: 0.4,
    spread: 1,
    speed: [2, 3] as [number, number],
    size: [0.14, 0.2] as [number, number],
    colorStart: [0.55, 0.42, 0.3, 1],
    colorEnd: [0.55, 0.42, 0.3, 1],
    gravity: [0, -9, 0] as [number, number, number],
    // ?fit: thrown along a tilted axis, jittered, fluttering, flat.
    ...(fit
      ? { axis: [0.4, 1, 0.3], colorJitter: 0.25, flutter: 0.3, boxScale: [1, 0.25, 1] }
      : {}),
  };
  let last = performance.now();
  let aspect = 0;
  state.gpu = 'ok';
  state.ready = true;

  const frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!state.paused) {
      fountain.emit(spray, 30);
      debris.emit(chunks, 4);
      fountain.update(dt);
      debris.update(dt);
      water.update(dt);
      weather.update(dt);
      lightning.update(dt);
      sky.time += dt;
    } else {
      fountain.update(0);
      debris.update(0);
    }
    const texture = gpu.context.getCurrentTexture();
    const a = texture.width / texture.height;
    if (a !== aspect) {
      aspect = a;
      camera.setPerspective(fovY, a, 0.1, 100);
      if (reversedZ) {
        reversedProjection(proj, fovY, a, 0.1);
        camera.setProjection(proj);
      }
    }
    camera.lookAt([2.5, 4.2, 11], [0, 0.8, 0]);
    setViewFromCamera(view, camera);
    target.view = texture.createView();
    target.texture = texture;
    target.width = texture.width;
    target.height = texture.height;
    sky.params.set(state.skyTint);
    sky.prepare();
    const encoder = gpu.device.createCommandEncoder();
    core.prepare(encoder, [view]);
    core.draw(encoder, 0, target);
    gpu.device.queue.submit([encoder.finish()]);
    state.frames++;
    state.horizon = [sky.horizon[0]!, sky.horizon[1]!, sky.horizon[2]!];
    state.skyDraws = sky.draws;
    state.weatherInstances = state.show.weather ? weather.instances : 0;
    state.drawables = core.coreDrawables.length;
    state.passes = core.stats.passes;
    state.passOrder = [...core.passes.order];
    state.particleDraws = fountain.drawCount;
    state.boxDraws = debris.drawCount;
    state.weatherLayers = weather.layerCount;
    state.gpuErrors = gpuDiagnostics.errorCount;
    requestAnimationFrame(frame);
  };
  res.onDeviceLost(() => {
    state.gpu = 'lost';
  });
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
