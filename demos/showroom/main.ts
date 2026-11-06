/**
 * Showroom (E-021, ws/demo-showroom): materials, lights and post looks in one view, as quality
 * validation for the renderer. Nothing here is engine code: the textures, the orbit and the
 * looks are what a game would write; the meshes are `geom` builders.
 *
 * - A 7×7 grid of spheres, metallic 0..1 across and roughness 0..1 down, through one standard
 *   material: a 7×7 metallic-roughness texture (G roughness, B metallic) sampled per sphere
 *   through a collapsed instance `uv` rect, so the grid is one instanced draw.
 * - A floor with a canvas-drawn checker albedo and a canvas-drawn roughness map (rough light
 *   tiles, glossy dark tiles); an emissive strip behind the grid (`InstanceParams.emissive`).
 * - The engine's sun with a shadow map, distance fog and three point lights circling the grid.
 * - `PostStack` with five looks switched by keys 1–5 through `post.blendTo`: neutral, warm
 *   bloom, god rays, high contrast, off.
 * - Orbit camera: drag (one-pointer pan) orbits; the wheel and a pinch zoom through a `Look`'s
 *   `zoom` axis. A DOM readout (`ui`) of draw calls and GPU ms. `?still` parks the lights, the
 *   strip and the blends for stable measurements.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { box, plane, sphere } from '@thunderclap/engine/geom';
import { Gestures, Input, Look } from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import {
  applyPostPatch,
  defaultPostSettings,
  type PostSettings,
  type PostSettingsPatch,
  PostStack,
} from '@thunderclap/engine/post';
import {
  Camera,
  type CameraPoint,
  createStandardMaterial,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type PointLight,
  Renderer,
  Transform,
} from '@thunderclap/engine/render';
import { createOverlay, h } from '@thunderclap/engine/ui';
import { LOOK_NAMES, type LookName, type ShowroomState } from './state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const STILL = new URLSearchParams(location.search).has('still');

const COLS = 7;
const ROWS = 7;

const state: ShowroomState = {
  ready: false,
  gpu: 'pending',
  frame: 0,
  fps: 0,
  gpuMs: null,
  gpuSource: 'queue',
  drawCalls: 0,
  stats: { drawCalls: 0, instances: 0, shadowDraws: 0 },
  look: 'neutral',
  blending: false,
  lightPositions: [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
  still: STILL,
  logical: LOGICAL,
  grid: { cols: COLS, rows: ROWS },
  probe: { x: 0, y: 0 },
  gpuErrors: 0,
};
(window as unknown as { __demo: ShowroomState }).__demo = state;

// ------------------------------------------------------------------ procedural textures (canvas)

const CHECKER_SIZE = 512;
const CHECKER_TILES = 8;

/** Paints `tiles × tiles` squares with `light` and `dark` as CSS colours. */
function checkerCanvas(light: string, dark: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CHECKER_SIZE;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  const cell = CHECKER_SIZE / CHECKER_TILES;
  for (let y = 0; y < CHECKER_TILES; y++) {
    for (let x = 0; x < CHECKER_TILES; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? light : dark;
      g.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  return canvas;
}

// ------------------------------------------------------------------ the scene

const SPHERE_RADIUS = 0.5;
const SPACING = 1.18;
const GRID_CENTRE = [0, 4.6, 0] as const;
const SPHERE_TINT = [0.82, 0.3, 0.22, 1] as const;
const FLOOR_SIZE = 80;
const FLOOR_REPEAT = 10;
const STRIP = { x: 0, y: 0.5, z: -3.2, w: 11, h: 0.3, d: 0.3 } as const;
const STRIP_TINT = [1.0, 0.6, 0.3, 1] as const;
const STRIP_GLOW = 3;
const STRIP_PULSE = 0.8;

const AMBIENT = [0.16, 0.17, 0.2] as const;
const SUN_DIR = [-0.4, -1.0, -0.55] as const;
const SUN_COLOR = [0.9, 0.88, 0.84] as const;
const SHADOW_EXTENT = 18;
const SHADOW_SIZE = 2048;
const FOG_COLOR = [0.45, 0.5, 0.6] as const;
const FOG_NEAR = 22;
const FOG_FAR = 70;

/** Three lights circling the grid: colour, orbit radius, height, angular speed, phase. */
const MOVING_LIGHTS = [
  { color: [2.6, 1.3, 0.5], radius: 5.5, height: 2.0, speed: 0.5, phase: 0 },
  { color: [0.5, 1.3, 2.8], radius: 6.0, height: 5.0, speed: -0.35, phase: 2.1 },
  { color: [2.2, 0.6, 1.9], radius: 5.0, height: 7.8, speed: 0.7, phase: 4.2 },
] as const;
const LIGHT_RADIUS = 9;
const LIGHT_ORBIT_CENTRE_Z = 2.0;

const TARGET = [GRID_CENTRE[0], GRID_CENTRE[1], GRID_CENTRE[2]] as const;
const orbit = { yaw: 0.25, pitch: 0.12, distance: 14 };
const ORBIT_PER_PX = 0.005;
/** Distance factor per `Look.zoom` unit (a wheel notch, or a pinch of `stepPx`): e^-0.15 is 14% closer. */
const ZOOM_PER_UNIT = 0.15;
const PITCH_MIN = -0.3;
const PITCH_MAX = 1.35;
const DISTANCE_MIN = 4;
const DISTANCE_MAX = 40;

const BLEND_SECONDS = 1.2;

// ------------------------------------------------------------------ post looks

/**
 * The looks are full `PostSettings`, so any look can follow any other through `blendTo`: a
 * neutral base on the engine defaults, then each look as the patch that differs from it.
 */
const NEUTRAL: PostSettings = applyPostPatch(defaultPostSettings(), {
  bloom: { enabled: true, intensity: 0.35, threshold: 1.3, knee: 0.5, scatter: 0.6 },
  fog: { enabled: false, density: 0 },
  godRays: { enabled: false, intensity: 0 },
  vignette: { enabled: true, intensity: 0.3, radius: 0.6, softness: 0.5, color: [0, 0, 0] },
  grade: { enabled: true, exposure: 1, tonemap: 'aces', saturation: 1, contrast: 1 },
});
const look = (patch: PostSettingsPatch): PostSettings =>
  applyPostPatch(structuredClone(NEUTRAL), patch);
const LOOKS: Record<LookName, PostSettings> = {
  neutral: NEUTRAL,
  warm: look({
    bloom: { intensity: 1.2, threshold: 0.9, knee: 0.6, scatter: 0.8 },
    fog: { enabled: true, density: 0.35, color: [0.36, 0.22, 0.12], top: 0.6, bottom: 1 },
    vignette: { intensity: 0.45, radius: 0.5, softness: 0.6, color: [0.05, 0, 0] },
    grade: {
      exposure: 1.1,
      lift: [0.02, 0.01, 0],
      gain: [1.12, 0.98, 0.82],
      saturation: 1.2,
      contrast: 1.02,
    },
  }),
  rays: look({
    bloom: { intensity: 0.5, threshold: 1.1, scatter: 0.7 },
    godRays: {
      enabled: true,
      intensity: 0.7,
      decay: 0.965,
      density: 0.85,
      weight: 0.04,
      color: [0.95, 0.88, 0.7],
      sourceRadius: 140,
      sourceIntensity: 1.2,
      bloomSource: 0.3,
    },
    grade: { saturation: 1.05 },
  }),
  contrast: look({
    bloom: { intensity: 0.25, threshold: 1.5, knee: 0.4, scatter: 0.5 },
    vignette: { intensity: 0.7, radius: 0.4 },
    grade: {
      exposure: 1.15,
      lift: [-0.03, -0.03, -0.03],
      gain: [1.05, 1.05, 1.05],
      saturation: 0.85,
      contrast: 1.45,
    },
  }),
  off: look({
    bloom: { enabled: false, intensity: 0 },
    vignette: { enabled: false, intensity: 0 },
    grade: { enabled: false, tonemap: 'none' },
  }),
};

// ------------------------------------------------------------------ camera

const eye = new Float32Array(3);
const scratch = new Float32Array(3);
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

type Action = 'look1' | 'look2' | 'look3' | 'look4' | 'look5';
const bindings = {
  look1: [{ key: 'Digit1' }, { key: 'Numpad1' }],
  look2: [{ key: 'Digit2' }, { key: 'Numpad2' }],
  look3: [{ key: 'Digit3' }, { key: 'Numpad3' }],
  look4: [{ key: 'Digit4' }, { key: 'Numpad4' }],
  look5: [{ key: 'Digit5' }, { key: 'Numpad5' }],
} as const;
const LOOK_ACTIONS: Action[] = ['look1', 'look2', 'look3', 'look4', 'look5'];

function placeCamera(camera: Camera): void {
  const o = orbit;
  o.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, o.pitch));
  o.distance = Math.min(DISTANCE_MAX, Math.max(DISTANCE_MIN, o.distance));
  const cp = Math.cos(o.pitch);
  eye[0] = TARGET[0] + o.distance * Math.sin(o.yaw) * cp;
  eye[1] = TARGET[1] + o.distance * Math.sin(o.pitch);
  eye[2] = TARGET[2] + o.distance * Math.cos(o.yaw) * cp;
  camera.lookAt(eye, TARGET);
}

/** World centre of the sphere at grid (col, row): metallic across, roughness down. */
function sphereCentre(col: number, row: number): [number, number, number] {
  return [
    GRID_CENTRE[0] + (col - (COLS - 1) / 2) * SPACING,
    GRID_CENTRE[1] + ((ROWS - 1) / 2 - row) * SPACING,
    GRID_CENTRE[2],
  ];
}

/** The point on a sphere nearest the eye. */
function facingPoint(c: readonly number[], out: Float32Array): void {
  const vx = eye[0]! - c[0]!;
  const vy = eye[1]! - c[1]!;
  const vz = eye[2]! - c[2]!;
  const vl = Math.hypot(vx, vy, vz);
  out[0] = c[0]! + (SPHERE_RADIUS * vx) / vl;
  out[1] = c[1]! + (SPHERE_RADIUS * vy) / vl;
  out[2] = c[2]! + (SPHERE_RADIUS * vz) / vl;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const res = await boot(root, { title: 'ThunderClap showroom' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.timingEvery = 10;
  // `gpuMs` is published once the first GPU sample has landed (`timing.ready()`), not polled.
  let timed = false;
  void renderer.timing.ready().then(() => {
    timed = true;
  });
  const post = new PostStack(renderer, LOOKS.neutral);
  renderer.post = post;
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((45 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  placeCamera(camera);

  // The grid's metallic-roughness map: one texel per sphere, G roughness (down), B metallic.
  const mr = new Uint8Array(COLS * ROWS * 4);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const o = (row * COLS + col) * 4;
      mr[o] = 0;
      mr[o + 1] = Math.round((row / (ROWS - 1)) * 255);
      mr[o + 2] = Math.round((col / (COLS - 1)) * 255);
      mr[o + 3] = 255;
    }
  }
  const mrTex = renderer.textureFromPixels({ width: COLS, height: ROWS, data: mr, label: 'mr' });
  // The floor: a checker albedo (sRGB) and a roughness map in G (rough light tiles, glossy dark
  // ones), both painted on a canvas.
  const albedoTex = renderer.textureFromSource(checkerCanvas('#b9b3a6', '#4a4f58'), 'floor-albedo');
  const floorMrTex = renderer.textureFromSource(
    checkerCanvas('rgb(0, 224, 0)', 'rgb(0, 56, 0)'),
    'floor-mr',
    { linear: true },
  );

  const spheresMat = createStandardMaterial(renderer, {
    label: 'spheres',
    metallicRoughness: mrTex,
    metallic: 1,
    roughness: 1,
  });
  const floorMat = createStandardMaterial(renderer, {
    label: 'floor',
    baseColor: albedoTex,
    metallicRoughness: floorMrTex,
    metallic: 1,
    roughness: 1,
  });
  const stripMat = createStandardMaterial(renderer, {
    label: 'strip',
    metallic: 0,
    roughness: 0.6,
  });

  // `geom` builders (a `Geometry` is a `MeshDesc`): a unit-radius UV sphere scaled per instance,
  // a unit plane the floor transform stretches with its uv tiled `FLOOR_REPEAT` times, a unit cube.
  const sphereMesh = renderer.createMesh({
    ...sphere({ radius: 1, segments: [42, 28] }),
    label: 'sphere',
  });
  const floor = renderer.createMesh({ ...plane({ uvScale: FLOOR_REPEAT }), label: 'floor' });
  const cube = renderer.createMesh({ ...box(), label: 'box' });

  // Instances: one transform and one params object each, reused every frame. `order` groups the
  // draws (floor, then the grid, then the strip) so the grid stays one instanced draw.
  const sphereT: Transform[] = [];
  const sphereP: InstanceParams[] = [];
  const centres: [number, number, number][] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const c = sphereCentre(col, row);
      centres.push(c);
      sphereT.push(
        new Transform({
          x: c[0],
          y: c[1],
          z: c[2],
          scaleX: SPHERE_RADIUS,
          scaleY: SPHERE_RADIUS,
          scaleZ: SPHERE_RADIUS,
        }),
      );
      const u = (col + 0.5) / COLS;
      const v = (row + 0.5) / ROWS;
      sphereP.push({ tint: SPHERE_TINT, uv: [u, v, u, v], order: 1 });
    }
  }
  const floorT = new Transform({ scaleX: FLOOR_SIZE, scaleY: 1, scaleZ: FLOOR_SIZE });
  const floorP: InstanceParams = { tint: [1, 1, 1, 1], order: 0 };
  const stripT = new Transform({
    x: STRIP.x,
    y: STRIP.y,
    z: STRIP.z,
    scaleX: STRIP.w,
    scaleY: STRIP.h,
    scaleZ: STRIP.d,
  });
  const stripP: InstanceParams = { tint: STRIP_TINT, emissive: STRIP_GLOW, order: 2 };

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.dir = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  lights.sun.shadow = { extent: SHADOW_EXTENT, size: SHADOW_SIZE };
  lights.fog.color = FOG_COLOR;
  lights.fog.density = 1;
  lights.fog.near = FOG_NEAR;
  lights.fog.far = FOG_FAR;
  const moving: PointLight[] = MOVING_LIGHTS.map((l) => ({
    position: new Float32Array(3),
    color: l.color,
    radius: LIGHT_RADIUS,
  }));
  for (const l of moving) lights.points.push(l);

  /** Places the three lights for motion time `t` (seconds) and mirrors them into the state. */
  function placeLights(t: number): void {
    for (let i = 0; i < moving.length; i++) {
      const spec = MOVING_LIGHTS[i]!;
      const a = spec.phase + t * spec.speed;
      const p = moving[i]!.position as Float32Array;
      p[0] = GRID_CENTRE[0] + spec.radius * Math.cos(a);
      p[1] = spec.height;
      p[2] = LIGHT_ORBIT_CENTRE_Z + spec.radius * Math.sin(a);
      const s = state.lightPositions[i]!;
      s[0] = p[0];
      s[1] = p[1];
      s[2] = p[2];
    }
  }

  // The sun's position on screen drives the god rays' source.
  const sunPoint = new Float32Array(3);
  {
    const len = Math.hypot(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
    const far = 60;
    sunPoint[0] = TARGET[0] - (SUN_DIR[0] / len) * far;
    sunPoint[1] = TARGET[1] - (SUN_DIR[1] / len) * far;
    sunPoint[2] = TARGET[2] - (SUN_DIR[2] / len) * far;
  }

  // The `Look` supplies only its zoom axis (wheel notches, two-finger pinch); the one-pointer pan
  // from `Gestures` orbits. No pointer lock is taken, so `look.look` stays zero for the mouse.
  const gestures = new Gestures();
  const look = new Look({ touch: { moveZone: 'none' } });
  const input = new Input<Action>(bindings, { gestures, look });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  // The readout: a DOM widget in the overlay's top region.
  const ui = createOverlay({ parent: root });
  surface.onResize(({ rect }) => ui.setFrame(rect));
  const readout = h('div', { class: 'showroom-readout', role: 'status' });
  ui.layout.add(readout, { place: { default: 'top' }, id: 'readout' });
  let readoutAt = 0;
  function updateReadout(now: number): void {
    if (now - readoutAt < 250) return;
    readoutAt = now;
    const gpuMs = state.gpuMs === null ? '…' : state.gpuMs.toFixed(2);
    readout.textContent =
      `draws ${state.drawCalls}  gpu ${gpuMs} ms (${state.gpuSource})  ${state.fps.toFixed(0)} fps\n` +
      `look ${state.look}${state.blending ? ' (blending)' : ''}  keys 1-5 looks  drag orbit  wheel zoom`;
  }

  function setLook(name: LookName): void {
    state.look = name;
    post.blendTo(LOOKS[name], BLEND_SECONDS);
    if (STILL) post.finishBlend();
  }

  const middle = centres[Math.floor(ROWS / 2) * COLS + Math.floor(COLS / 2)]!;
  let motionT = 0;
  placeLights(0);

  const loop = new GameLoop({
    update() {
      input.update();
      const pan = gestures.pan;
      if (pan && pan.pointers === 1 && (pan.phase === 'start' || pan.phase === 'move')) {
        orbit.yaw -= pan.dx * ORBIT_PER_PX;
        orbit.pitch += pan.dy * ORBIT_PER_PX;
      }
      if (look.zoom !== 0) orbit.distance *= Math.exp(-look.zoom * ZOOM_PER_UNIT);
      placeCamera(camera);
      for (let i = 0; i < LOOK_ACTIONS.length; i++) {
        if (input.pressed(LOOK_ACTIONS[i]!)) setLook(LOOK_NAMES[i]!);
      }
    },
    render(_alpha, time) {
      if (!STILL) {
        motionT += time.frameDt;
        placeLights(motionT);
        stripP.emissive = STRIP_GLOW + STRIP_PULSE * Math.sin(motionT * 1.7);
      }
      camera.worldToScreen(sunPoint[0]!, sunPoint[1]!, sunPoint[2]!, probePoint);
      post.settings.godRays.x = probePoint.x;
      post.settings.godRays.y = probePoint.y;

      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.06, 0.09);
      frame.lights = lights;
      frame.mesh(floor, floorMat, floorT, floorP);
      for (let i = 0; i < sphereT.length; i++) {
        frame.mesh(sphereMesh, spheresMat, sphereT[i]!, sphereP[i]!);
      }
      frame.mesh(cube, stripMat, stripT, stripP);
      renderer.endFrame();

      state.frame++;
      if (time.frameDt > 0) {
        const fps = 1 / time.frameDt;
        state.fps = state.fps === 0 ? fps : state.fps + (fps - state.fps) * 0.05;
      }
      const timing = renderer.timing;
      state.gpuMs = timed ? timing.gpuMs : null;
      state.gpuSource = timing.source;
      const st = renderer.stats;
      state.drawCalls = st.drawCalls;
      state.stats.drawCalls = st.drawCalls;
      state.stats.instances = st.instances;
      state.stats.shadowDraws = st.shadowDraws;
      state.blending = post.blending;
      state.gpuErrors = gpuDiagnostics.errorCount;
      facingPoint(middle, scratch);
      camera.worldToScreen(scratch[0]!, scratch[1]!, scratch[2]!, probePoint);
      state.probe.x = probePoint.x;
      state.probe.y = probePoint.y;
      updateReadout(time.realTime * 1000);
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[showroom]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
