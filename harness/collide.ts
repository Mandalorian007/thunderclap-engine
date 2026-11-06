/**
 * Collision page (ws/collide): a level built from `@thunderclap/engine/geom` builders (a box
 * floor, stairs onto a platform, an arch, a tilted ramp, a wall and a heightfield patch) merged
 * into one `StaticCollider`, and a capsule walked through it with `slide` under gravity. WASD or
 * the arrows (through `Look`'s move keys), the touch stick or the pad's left stick move it; the
 * camera follows from behind. The collider's wireframe (`colliderWireframe`: the triangles or the
 * BVH leaves) is drawn through `createDebugDraw` over the lit meshes. Nothing here is engine
 * code beyond the imports: the gravity and the camera are what a game would write.
 *
 * - `?grid`: the 2D case instead, a corridor of solid tiles seen from above and a circle moved
 *   with `slide2`.
 * - `?still` (E-017): the sim steps only through `advance`, never on a frame, so a spec's reads
 *   are a function of what it asked for.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { createDebugDraw } from '@thunderclap/engine/fx';
import {
  arch,
  box,
  type Capsule,
  type Circle,
  type ColliderSource,
  capsule,
  colliderWireframe,
  colliderWireframeLength,
  createHeightfield,
  createSlideResult,
  createStaticCollider,
  createSweepHit,
  type Geometry,
  type GridSource,
  heightfieldGeometry,
  mergeGeometry,
  type StaticCollider,
  slide,
  slide2,
  stairs,
  sweep2,
  sweepShape,
  transformGeometry,
  type WireframeMode,
} from '@thunderclap/engine/geom';
import { Input, Look } from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  type Mesh,
  Renderer,
  Transform,
} from '@thunderclap/engine/render';
import {
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  CIRCLE_RADIUS,
  CORRIDOR_COL,
  CORRIDOR_ROW,
  GRID_HEIGHT,
  GRID_WIDTH,
  type HarnessCollideApi,
  type HarnessCollideState,
  RAMP_TILT,
  RAMP_X,
  RAMP_Z,
  STAIR_RISE,
  STAIR_RUN,
  STAIR_STEPS,
  STAIRS_Z0,
  STEP,
  WALK_PER_S,
  WALL_X,
  WALL_Z,
} from './collide-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const params = new URLSearchParams(location.search);
const GRID = params.has('grid');
const STILL = params.has('still');
const GRAVITY = 9.8;
/** Below the level: back to the start. */
const FLOOR_LIMIT = -5;
const START: [number, number, number] = [0, CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS, 2];
const GRID_START: [number, number, number] = [CORRIDOR_COL + 0.5, 0, 0.5];

const state: HarnessCollideState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  mode: GRID ? 'grid' : 'level',
  still: STILL,
  ticks: 0,
  pos: GRID ? [...GRID_START] : [...START],
  grounded: false,
  groundNormal: [0, 1, 0],
  hits: 0,
  hitWall: false,
  triangleCount: 0,
  lastSweepT: -1,
  wireLines: 0,
  wire: 'triangles',
  move: [0, 0],
  gpuErrors: 0,
};

// ------------------------------------------------------------------ the level

function translate(x: number, y: number, z: number): Float32Array {
  return new Transform({ x, y, z }).world;
}

/** The level's parts, each a lit mesh and a collider source with the same transform. */
function levelParts(): { geometry: Geometry; transform: Float32Array }[] {
  const parts: { geometry: Geometry; transform: Float32Array }[] = [];
  parts.push({
    geometry: box({ size: [20, 1, 20], color: [0.45, 0.5, 0.38, 1] }),
    transform: translate(0, -0.5, 0),
  });
  // The stairs climb along +z as built; turned about y they climb away from the camera.
  const stairsT = new Transform({ x: 0, y: (STAIR_STEPS * STAIR_RISE) / 2, z: STAIRS_Z0 - 0.75 });
  stairsT.setAxisAngle(0, 1, 0, Math.PI);
  parts.push({
    geometry: stairs({
      steps: STAIR_STEPS,
      rise: STAIR_RISE,
      run: STAIR_RUN,
      width: 2,
      color: [0.8, 0.8, 0.85, 1],
    }),
    transform: stairsT.world,
  });
  const top = STAIR_STEPS * STAIR_RISE;
  parts.push({
    geometry: box({ size: [2, top, 2], color: [0.75, 0.75, 0.8, 1] }),
    transform: translate(0, top / 2, STAIRS_Z0 - STAIR_STEPS * STAIR_RUN - 1),
  });
  parts.push({
    geometry: box({ size: [0.5, 2, 2], color: [0.9, 0.35, 0.3, 1] }),
    transform: translate(WALL_X + 0.25, 1, WALL_Z),
  });
  parts.push({
    geometry: arch({
      width: 2,
      height: 2.4,
      depth: 0.5,
      thickness: 0.3,
      color: [0.95, 0.5, 0.6, 1],
    }),
    transform: translate(4.5, 1.2, -4),
  });
  // The ramp: a slab tilted about x, its low end resting near the floor.
  const rampT = new Transform({ x: RAMP_X, y: 2 * Math.sin(RAMP_TILT) + 0.1, z: RAMP_Z });
  rampT.setAxisAngle(1, 0, 0, RAMP_TILT);
  parts.push({
    geometry: box({ size: [2, 0.2, 4], color: [0.3, 0.8, 0.95, 1] }),
    transform: rampT.world,
  });
  return parts;
}

const HF_SAMPLES = 9;
const heightfield = createHeightfield(HF_SAMPLES, HF_SAMPLES, {
  scale: [0.5, 1, 0.5],
  origin: [-7, 0, 2],
});
for (let j = 0; j < HF_SAMPLES; j++) {
  for (let i = 0; i < HF_SAMPLES; i++) {
    heightfield.heights[j * HF_SAMPLES + i] =
      0.4 * Math.sin((i / (HF_SAMPLES - 1)) * Math.PI) * Math.sin((j / (HF_SAMPLES - 1)) * Math.PI);
  }
}

const grid: GridSource = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  cellSize: 1,
  origin: [0, 0],
  wallHeight: 1,
  solid: (x: number, z: number) =>
    !(
      (x === CORRIDOR_COL && z <= CORRIDOR_ROW) ||
      (z === CORRIDOR_ROW && x >= CORRIDOR_COL && x < GRID_WIDTH - 1)
    ),
};

// ------------------------------------------------------------------ the sim

const cap: Capsule = {
  x: START[0],
  y: START[1],
  z: START[2],
  halfHeight: CAPSULE_HALF_HEIGHT,
  r: CAPSULE_RADIUS,
};
const circle: Circle = { x: GRID_START[0], z: GRID_START[2], r: CIRCLE_RADIUS };
const result = createSlideResult();
const probeHit = createSweepHit();
let vy = 0;
let held: [number, number] | null = null;

const look = new Look({
  keys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
});

function step(collider: StaticCollider): void {
  const mx = held ? held[0] : look.move.x;
  const my = held ? held[1] : look.move.y;
  state.move[0] = mx;
  state.move[1] = my;
  // Screen forward is -z (the camera looks down -z from behind), right is +x.
  const dx = mx * WALK_PER_S * STEP;
  const dz = -my * WALK_PER_S * STEP;
  if (GRID) {
    slide2(collider, circle, dx, dz, {}, result);
    circle.x = result.x;
    circle.z = result.z;
    state.pos[0] = circle.x;
    state.pos[1] = 0;
    state.pos[2] = circle.z;
  } else {
    if (state.grounded) vy = 0;
    else vy -= GRAVITY * STEP;
    const dy = state.grounded ? -0.001 : vy * STEP;
    slide(collider, cap, dx, dy, dz, { wasGrounded: state.grounded }, result);
    cap.x = result.x;
    cap.y = result.y;
    cap.z = result.z;
    if (cap.y < FLOOR_LIMIT) {
      cap.x = START[0];
      cap.y = START[1];
      cap.z = START[2];
      vy = 0;
    }
    state.pos[0] = cap.x;
    state.pos[1] = cap.y;
    state.pos[2] = cap.z;
    state.groundNormal[0] = result.groundNormal[0];
    state.groundNormal[1] = result.groundNormal[1];
    state.groundNormal[2] = result.groundNormal[2];
  }
  state.grounded = result.grounded;
  state.hits = result.hits;
  state.hitWall = result.hitWall;
  state.ticks++;
}

// ------------------------------------------------------------------ drawing

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.1 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const CLEAR = [0.05, 0.07, 0.12] as const;
const WIRE_COLOR = 0xffd060a0;
const LEAF_COLOR = 0x60c0ffa0;
const eye = new Float32Array(3);
const target = new Float32Array(3);
const segA = new Float32Array(3);
const segB = new Float32Array(3);

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine collision demo' });
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

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.dir = [-0.4, -1.0, -0.5];
  lights.sun.color = [0.9, 0.88, 0.82];
  const identity = new Transform();

  // The level: one merged mesh and one collider from the same parts.
  const meshes: Mesh[] = [];
  const sources: ColliderSource[] = [];
  let shapeMesh: Mesh;
  if (GRID) {
    sources.push({ grid, userData: 'corridor' });
    shapeMesh = renderer.createMesh(
      capsule({ radius: CIRCLE_RADIUS, height: 1, color: [0.95, 0.8, 0.25, 1] }),
    );
  } else {
    // `transformGeometry` works in place: the placed parts feed both the mesh and the collider.
    const parts = levelParts().map((p) => transformGeometry(p.geometry, p.transform));
    const geometry = mergeGeometry(
      ...parts,
      heightfieldGeometry(heightfield, { color: [0.55, 0.45, 0.35, 1] }),
    );
    meshes.push(renderer.createMesh(geometry));
    for (const p of parts) sources.push({ geometry: p });
    sources.push({ heightfield, layer: 2, userData: 'patch' });
    shapeMesh = renderer.createMesh(
      capsule({
        radius: CAPSULE_RADIUS,
        height: 2 * (CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS),
        color: [0.95, 0.8, 0.25, 1],
      }),
    );
  }
  const collider = createStaticCollider(sources);
  state.triangleCount = collider.triangleCount;
  const shapeT = new Transform();

  const debug = createDebugDraw(renderer, { label: 'harness-collide' });
  let wire = colliderWireframe(collider, undefined, state.wire);
  let wireFloats = colliderWireframeLength(collider, state.wire);

  const input = new Input({}, { look });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  const api: HarnessCollideApi = {
    state,
    setMove(x, y) {
      held = [x, y];
    },
    clearMove() {
      held = null;
    },
    advance(steps) {
      for (let i = 0; i < steps; i++) step(collider);
    },
    teleport(x, y, z) {
      cap.x = x;
      cap.y = y;
      cap.z = z;
      circle.x = x;
      circle.z = z;
      vy = 0;
      state.grounded = false;
      state.pos[0] = x;
      state.pos[1] = GRID ? 0 : y;
      state.pos[2] = z;
    },
    setWire(mode: WireframeMode) {
      state.wire = mode;
      wire = colliderWireframe(collider, wire, mode);
      wireFloats = colliderWireframeLength(collider, mode);
    },
    sweepProbe(dx, dy, dz) {
      const hit = GRID
        ? sweep2(collider, circle, dx, dz, probeHit)
        : sweepShape(collider, cap, dx, dy, dz, probeHit);
      state.lastSweepT = hit ? probeHit.t : 1;
      return state.lastSweepT;
    },
  };
  window.__harnessCollide = api;

  const loop = new GameLoop({
    update() {
      input.update();
      if (!STILL) step(collider);
    },
    render(_alpha, time) {
      const p = state.pos;
      if (GRID) {
        eye[0] = GRID_WIDTH / 2;
        eye[1] = 14;
        eye[2] = GRID_HEIGHT / 2 + 4;
        target[0] = GRID_WIDTH / 2;
        target[1] = 0;
        target[2] = GRID_HEIGHT / 2;
        shapeT.setPosition(p[0], 0.5, p[2]);
      } else {
        eye[0] = p[0];
        eye[1] = p[1] + 4.5;
        eye[2] = p[2] + 7;
        target[0] = p[0];
        target[1] = p[1];
        target[2] = p[2];
        shapeT.setPosition(p[0], p[1], p[2]);
      }
      camera.lookAt(eye, target);

      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      for (const m of meshes) frame.mesh(m, lit, identity);
      frame.mesh(shapeMesh, lit, shapeT);
      const color = state.wire === 'leaves' ? LEAF_COLOR : WIRE_COLOR;
      for (let o = 0; o < wireFloats; o += 6) {
        segA[0] = wire[o]!;
        segA[1] = wire[o + 1]!;
        segA[2] = wire[o + 2]!;
        segB[0] = wire[o + 3]!;
        segB[1] = wire[o + 4]!;
        segB[2] = wire[o + 5]!;
        debug.line(segA, segB, color);
      }
      state.wireLines = debug.count;
      frame.drawable(debug);
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
