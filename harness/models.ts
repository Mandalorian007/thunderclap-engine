/**
 * Part-models demo page: a toon windmill and a small walking machine, each a part tree
 * compiled against the page's own material table and animated by state channels in the
 * shader. Nothing here is engine code: the specs, the materials and the toon shade function
 * are what a game would write.
 *
 * - The windmill: a frustum tower, a wedge roof, a door, a lit window (`glow` on the `lamp`
 *   channel) and four sails (`repeat` with a turn) that `spin` on the `spin` channel, its rate
 *   set once, so the sails turn with nothing written per frame.
 * - The walker: a box body with a cylinder boiler, four legs that `swing` on `stride` (diagonal
 *   pairs half a turn apart), a gear that `spin`s on the same channel and a glowing eye. It
 *   walks a circle round the mill, re-placed each frame (its matrix changes).
 * - The ground: a flat cylinder.
 * - `?still` parks everything (sails at `spin` 0, the walker mid-stride) for pixel specs.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import {
  compileModel,
  createModelScene,
  type MaterialCodeTable,
  type Part,
  type PartModel,
} from '@thunderclap-engine/engine/models';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Renderer,
  Transform,
} from '@thunderclap-engine/engine/render';
import type { HarnessModelsApi, HarnessModelsState } from './models-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const still = new URLSearchParams(location.search).has('still');

/** The page's material table: everyday names, linear colours. Codes are declaration order. */
const MATERIALS: MaterialCodeTable = {
  plaster: { color: [0.82, 0.74, 0.6] },
  timber: { color: [0.36, 0.2, 0.1] },
  cloth: { color: [0.78, 0.2, 0.12] },
  slate: { color: [0.22, 0.26, 0.36] },
  grass: { color: [0.25, 0.5, 0.18] },
  iron: { color: [0.3, 0.32, 0.34] },
  brass: { color: [0.8, 0.55, 0.18] },
  lamp: { color: [1, 0.75, 0.3], emissive: [3, 1.8, 0.6] },
};

/**
 * Toon shading: the light quantized into three bands, a rim, sail cloth striped by height in
 * model space, and the glow to the emissive target.
 */
const TOON = /* wgsl */ `
fn model_shade(s: ModelSurface) -> ModelShaded {
  let light = engine_lambert(s.normal, s.world_pos);
  let l = dot(light, vec3f(0.299, 0.587, 0.114));
  let band = select(select(0.5, 0.8, l > 0.55), 1.05, l > 0.95);
  let view = normalize(camera.camera_pos.xyz - s.world_pos);
  let rim = pow(1.0 - max(dot(s.normal, view), 0.0), 4.0) * 0.35;
  var c = s.base * (band + rim);
  if (s.material == MODEL_MAT_CLOTH) {
    c = c * (0.85 + 0.15 * step(0.5, fract(s.local_pos.y * 3.0)));
  }
  return ModelShaded(engine_fog(c, s.world_pos), s.emissive);
}
`;

/** The sails' hub, in windmill space. */
const HUB = [0, 3, 0.95] as const;
const SAIL_TIP = 1.9;

const sail: Part = {
  parts: [
    {
      material: 'timber',
      shape: { type: 'box', from: [-0.05, 0, 0.06], to: [0.05, SAIL_TIP, 0.12] },
    },
    {
      material: 'cloth',
      shape: { type: 'box', from: [0.05, 0.45, 0.07], to: [0.5, SAIL_TIP - 0.05, 0.1] },
    },
  ],
};

const WINDMILL: PartModel = {
  name: 'windmill',
  channels: [{ name: 'spin', wrap: Math.PI * 2 }, 'lamp'],
  parts: [
    {
      name: 'tower',
      material: 'plaster',
      shape: { type: 'frustum', center: [0, 0, 0], bottom: 1.8, top: 1.1, height: 3.2 },
    },
    {
      name: 'cap',
      material: 'plaster',
      shape: { type: 'box', from: [-0.6, 3.2, -0.6], to: [0.6, 3.25, 0.6] },
    },
    {
      name: 'roof',
      material: 'slate',
      shape: { type: 'wedge', from: [-0.75, 3.25, -0.75], to: [0.75, 4.1, 0.75], cap: 'timber' },
    },
    {
      name: 'door',
      material: 'timber',
      shape: { type: 'box', from: [-0.25, 0, 0.78], to: [0.25, 0.9, 0.93] },
    },
    {
      name: 'sails',
      motion: { type: 'spin', axis: 'z', pivot: HUB, channel: 'spin' },
      parts: [
        {
          material: 'iron',
          shape: {
            type: 'cylinder',
            center: [HUB[0], HUB[1], HUB[2] - 0.2],
            axis: 'z',
            radius: 0.16,
            length: 0.6,
            cap: 'brass',
          },
        },
        {
          move: [HUB[0], HUB[1], HUB[2]],
          repeat: { count: 4, turn: { axis: 'z', angle: Math.PI / 2, pivot: HUB } },
          parts: [sail],
        },
      ],
    },
    {
      name: 'window',
      material: 'lamp',
      glow: { channel: 'lamp', max: 1 },
      shape: { type: 'box', from: [-0.18, 1.7, 0.65], to: [0.18, 2.1, 0.74] },
    },
  ],
};

const HIP_Y = 0.85;
const leg = (x: number, z: number, phase: number): Part => ({
  name: `leg ${x > 0 ? 'right' : 'left'} ${z > 0 ? 'front' : 'back'}`,
  material: 'iron',
  motion: {
    type: 'swing',
    axis: 'x',
    pivot: [x, HIP_Y, z],
    channel: 'stride',
    amplitude: 0.5,
    phase,
  },
  parts: [
    {
      shape: {
        type: 'box',
        from: [x - 0.07, 0.12, z - 0.07],
        to: [x + 0.07, HIP_Y + 0.05, z + 0.07],
      },
    },
    {
      material: 'brass',
      shape: { type: 'box', from: [x - 0.11, 0, z - 0.06], to: [x + 0.11, 0.12, z + 0.2] },
    },
  ],
});

const WALKER: PartModel = {
  name: 'walker',
  channels: [{ name: 'stride', wrap: Math.PI * 2 }, 'power'],
  parts: [
    {
      name: 'body',
      material: 'timber',
      shape: { type: 'box', from: [-0.35, HIP_Y - 0.05, -0.5], to: [0.35, 1.3, 0.5] },
      parts: [
        {
          material: 'brass',
          shape: {
            type: 'cylinder',
            center: [0, 1.45, -0.1],
            axis: 'z',
            radius: 0.22,
            length: 0.7,
            cap: 'iron',
          },
        },
        {
          material: 'iron',
          shape: {
            type: 'cylinder',
            center: [0, 1.75, -0.35],
            axis: 'y',
            radius: 0.07,
            length: 0.5,
            sides: 6,
          },
        },
        {
          material: 'iron',
          shape: {
            type: 'prism',
            center: [0, 1.15, 0.58],
            axis: 'z',
            radii: [0.22, 0.16, 0.22, 0.16, 0.22, 0.16],
            length: 0.18,
          },
        },
      ],
    },
    leg(0.3, 0.32, 0),
    leg(-0.3, 0.32, Math.PI),
    leg(0.3, -0.32, Math.PI),
    leg(-0.3, -0.32, 0),
    {
      name: 'gear',
      material: 'brass',
      motion: { type: 'spin', axis: 'x', pivot: [0.38, 1.05, 0], channel: 'stride', ratio: 1 },
      shape: {
        type: 'gear',
        center: [0.38, 1.05, 0],
        axis: 'x',
        outer: 0.24,
        root: 0.19,
        teeth: 10,
        length: 0.06,
      },
    },
    {
      name: 'eye',
      material: 'lamp',
      glow: { channel: 'power', scale: 1, max: 1 },
      shape: {
        type: 'cylinder',
        center: [0, 1.15, 0.68],
        axis: 'z',
        radius: 0.08,
        length: 0.04,
        sides: 10,
      },
    },
  ],
};

const GROUND: PartModel = {
  name: 'ground',
  parts: [
    {
      material: 'grass',
      shape: {
        type: 'cylinder',
        center: [0, -0.05, 0],
        axis: 'y',
        radius: 9,
        length: 0.1,
        sides: 40,
      },
    },
  ],
};

const state: HarnessModelsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  drawCalls: 0,
  instances: 0,
  units: 0,
  instanceBytes: 0,
  moving: !still,
  spin: 0,
  probes: {
    sail: { x: 0, y: 0 },
    tower: { x: 0, y: 0 },
    walker: { x: 0, y: 0 },
    sky: { x: 120, y: 80 },
  },
  gpuErrors: 0,
};

const CLEAR = [0.45, 0.65, 0.9] as const;
const EYE = [4.5, 3.6, 9.5] as const;
const TARGET = [0.6, 2, 0] as const;
const WALK_RADIUS = 2.8;
/** Walker turns round the mill (rad/s) and strides (stride radians per second). */
const WALK_TURN = 0.25;
const STRIDE_RATE = 5;
const SPIN_RATE = 0.8;
/** Where the walker parks under `?still`: in front of the mill, to the right. */
const PARK_ANGLE = 0.95;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine part-models demo' });
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

  const camera = Camera.perspective((45 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt(EYE, TARGET);
  renderer.camera = camera;

  const scene = createModelScene(renderer, {
    materials: MATERIALS,
    shade: TOON,
    label: 'harness-models',
    maxInstances: 64,
  });
  const windmill = compileModel(WINDMILL, MATERIALS);
  const walker = compileModel(WALKER, MATERIALS);
  const ground = compileModel(GROUND, MATERIALS);
  state.units = windmill.units.length + walker.units.length + ground.units.length;

  const millAt = new Transform();
  const walkerAt = new Transform();
  const SLOT_GROUND = 0;
  const SLOT_MILL = 1;
  const SLOT_WALKER = SLOT_MILL + windmill.units.length;
  const sails = windmill.units.find((u) => u.name === 'windmill/sails')!;
  const sailSlot = SLOT_MILL + windmill.units.indexOf(sails);

  scene.placeModel(ground, SLOT_GROUND, new Transform());
  const placeMill = (): void => {
    scene.placeModel(windmill, SLOT_MILL, millAt, {
      channels: { spin: state.moving ? [state.spin, SPIN_RATE] : state.spin, lamp: 0.8 },
    });
  };
  let walkAngle = PARK_ANGLE;
  const placeWalker = (time: number): void => {
    walkerAt.setPosition(Math.sin(walkAngle) * WALK_RADIUS, 0, Math.cos(walkAngle) * WALK_RADIUS);
    // Facing along the circle (model +z forward), counter-clockwise seen from above.
    walkerAt.setAxisAngle(0, 1, 0, walkAngle + Math.PI / 2);
    const stride = state.moving ? time * STRIDE_RATE : 1;
    scene.placeModel(walker, SLOT_WALKER, walkerAt, {
      channels: { stride: state.moving ? [stride, STRIDE_RATE] : stride, power: 1 },
    });
  };
  placeMill();
  placeWalker(0);

  const p: CameraPoint = { x: 0, y: 0, z: 0 };
  const probe = (x: number, y: number, z: number, out: { x: number; y: number }): void => {
    camera.worldToScreen(x, y, z, p);
    out.x = p.x;
    out.y = p.y;
  };
  probe(0.3, HUB[1] + 1.3, HUB[2] + 0.1, state.probes.sail);
  probe(0, 0.45, 0.93, state.probes.tower); // the door

  const api: HarnessModelsApi = {
    state,
    setSpin(angle) {
      state.spin = angle;
      scene.place(sails, sailSlot, millAt, { channels: { spin: angle, lamp: 0.8 } });
    },
    setMoving(on) {
      state.moving = on;
      placeMill();
    },
  };
  window.__harnessModels = api;

  let last = 0;
  let lit = false;
  const loop = new GameLoop({
    update() {},
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      if (!lit) {
        lit = true;
        frame.lights.ambient.set([0.42, 0.45, 0.55]);
        frame.lights.sun.direction = [-0.5, -1, -0.6];
        frame.lights.sun.color = [1.05, 0.98, 0.88];
      }
      if (state.moving) {
        walkAngle += WALK_TURN * (t.realTime - last);
        placeWalker(t.realTime);
      }
      last = t.realTime;
      probe(walkerAt.position.x, 1.1, walkerAt.position.z, state.probes.walker);
      frame.drawable(scene);
      renderer.endFrame();
      state.frames++;
      state.drawCalls = scene.stats.drawCalls;
      state.instances = scene.count;
      state.instanceBytes = scene.stats.instanceBytes;
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
