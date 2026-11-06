/**
 * Geometry page: every builder in `@thunderclap/engine/geom` in a row, lit by the engine's
 * lighting block and slowly turning, over a heightfield ground built from a sine bump map
 * (`heightfieldGeometry`). Nothing here is engine code beyond the imports: a game would write the
 * same page. e2e/geom.spec.ts checks the shape count, that a probe pixel on each shape is lit,
 * and that the height the page reads under the camera matches the map it was built from.
 */
import { GameLoop } from '@thunderclap/engine/core';
import {
  box,
  capsule,
  createHeightfield,
  cylinder,
  type Geometry,
  heightAt,
  heightfieldGeometry,
  icosphere,
  plane,
  sphere,
  torus,
  transformGeometry,
} from '@thunderclap/engine/geom';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  type Mesh,
  Renderer,
  Transform,
} from '@thunderclap/engine/render';
import {
  bumpHeight,
  GROUND_ORIGIN,
  GROUND_SAMPLES,
  GROUND_SPACING,
  type HarnessGeomApi,
  type HarnessGeomState,
  SHAPE_NAMES,
  type ShapeName,
} from './geom-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

// ------------------------------------------------------------------ the ground

const ground = createHeightfield(GROUND_SAMPLES, GROUND_SAMPLES, {
  scale: [GROUND_SPACING, 1, GROUND_SPACING],
  origin: [GROUND_ORIGIN, 0, GROUND_ORIGIN],
});
for (let j = 0; j < GROUND_SAMPLES; j++) {
  for (let i = 0; i < GROUND_SAMPLES; i++) {
    const x = GROUND_ORIGIN + i * GROUND_SPACING;
    const z = GROUND_ORIGIN + j * GROUND_SPACING;
    ground.heights[j * GROUND_SAMPLES + i] = bumpHeight(x, z);
  }
}

/** The eye sits on a grid node of the ground, so the sampled height is a stored sample. */
const EYE = [0, 4.2, 7.5] as const;
const TARGET = [0, 0.8, 0] as const;

const state: HarnessGeomState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  shapes: 0,
  heightUnderCamera: heightAt(ground, EYE[0], EYE[2]),
  sample: [EYE[0], EYE[2]],
  probes: {
    box: { x: 0, y: 0 },
    plane: { x: 0, y: 0 },
    sphere: { x: 0, y: 0 },
    icosphere: { x: 0, y: 0 },
    capsule: { x: 0, y: 0 },
    cylinder: { x: 0, y: 0 },
    torus: { x: 0, y: 0 },
    sky: { x: 0, y: 0 },
  },
  stats: { drawCalls: 0, instances: 0, culled: 0 },
  gpuErrors: 0,
};

const api: HarnessGeomApi = {
  state,
  heightAt: (x, z) => heightAt(ground, x, z),
};
window.__harnessGeom = api;

// ------------------------------------------------------------------ the shapes

const SHAPE_SPACING = 1.7;
const SHAPE_Y = 1.3;
/** Each shape's spin axis (unit-ish; `setAxisAngle` normalises) and rate in radians per second. */
interface ShapeSpec {
  build(): Geometry;
  axis: [number, number, number];
  rate: number;
  /** The world point the spec samples, relative to the shape's centre. */
  probe: [number, number, number];
}

/** The plane is tilted to face the eye and spins about its own normal, so it never goes edge-on. */
const PLANE_TILT = -Math.PI / 3;
const planeNormal: [number, number, number] = [0, Math.cos(PLANE_TILT), -Math.sin(PLANE_TILT)];

const SHAPES: Record<ShapeName, ShapeSpec> = {
  box: {
    build: () => box({ size: 1, color: [0.95, 0.3, 0.25, 1] }),
    axis: [0.3, 1, 0.2],
    rate: 0.5,
    probe: [0, 0, 0],
  },
  plane: {
    build: () => {
      const g = plane({ size: 1.3, segments: 4, color: [0.3, 0.8, 0.95, 1] });
      const tilt = new Transform();
      tilt.setAxisAngle(1, 0, 0, PLANE_TILT);
      return transformGeometry(g, tilt.world);
    },
    axis: planeNormal,
    rate: 0.4,
    probe: [0, 0, 0],
  },
  sphere: {
    build: () => sphere({ radius: 0.6, color: [0.95, 0.8, 0.25, 1] }),
    axis: [0, 1, 0],
    rate: 0.3,
    probe: [0, 0, 0],
  },
  icosphere: {
    build: () => icosphere({ radius: 0.6, subdivisions: 1, color: [0.4, 0.9, 0.4, 1] }),
    axis: [0.5, 1, 0],
    rate: 0.45,
    probe: [0, 0, 0],
  },
  capsule: {
    build: () => capsule({ radius: 0.3, height: 1.4, color: [0.85, 0.5, 0.95, 1] }),
    axis: [1, 0, 0.4],
    rate: 0.35,
    probe: [0, 0, 0],
  },
  cylinder: {
    build: () => cylinder({ radius: [0.25, 0.5], height: 1.1, color: [0.95, 0.6, 0.3, 1] }),
    axis: [1, 0.2, 0],
    rate: 0.4,
    probe: [0, 0, 0],
  },
  torus: {
    // Spins about y, so the ring stays in the xz plane and the probe on its near tube holds.
    build: () => torus({ radius: 0.5, tube: 0.2, color: [0.5, 0.75, 0.95, 1] }),
    axis: [0, 1, 0],
    rate: 0.6,
    probe: [0, 0, 0.5],
  },
};

// ------------------------------------------------------------------ the material

/** Vertex colour × the engine lighting block plus a faint sky term from above. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.1 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const AMBIENT = [0.2, 0.2, 0.22] as const;
const SUN_DIR = [-0.4, -1.0, -0.5] as const;
const SUN_COLOR = [0.9, 0.88, 0.82] as const;
const CLEAR = [0.05, 0.07, 0.12] as const;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine geometry demo' });
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
  camera.lookAt(EYE, TARGET);

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  // A `Geometry` is a `MeshDesc`: it goes to `createMesh` as it is.
  const groundMesh = renderer.createMesh(
    heightfieldGeometry(ground, { color: [0.45, 0.5, 0.38, 1] }),
  );
  const groundT = new Transform();

  const meshes: Mesh[] = [];
  const transforms: Transform[] = [];
  const names = SHAPE_NAMES;
  for (let i = 0; i < names.length; i++) {
    const spec = SHAPES[names[i]!];
    meshes.push(renderer.createMesh(spec.build()));
    transforms.push(new Transform({ x: (i - (names.length - 1) / 2) * SHAPE_SPACING, y: SHAPE_Y }));
  }
  state.shapes = names.length;

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.dir = SUN_DIR;
  lights.sun.color = SUN_COLOR;

  let spin = 0;
  const loop = new GameLoop({
    update(dt) {
      spin += dt;
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      frame.mesh(groundMesh, lit, groundT);
      for (let i = 0; i < names.length; i++) {
        const spec = SHAPES[names[i]!];
        const t = transforms[i]!;
        t.setAxisAngle(spec.axis[0], spec.axis[1], spec.axis[2], spin * spec.rate);
        frame.mesh(meshes[i]!, lit, t);
        const p = spec.probe;
        const c = t.position;
        probe(camera, c.x + p[0], c.y + p[1], c.z + p[2], state.probes[names[i]!]);
      }
      // Far beyond the ground's edge, below the horizon from the eye: only the clear colour.
      probe(camera, 0, 0, -60, state.probes.sky);
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.stats.culled = renderer.stats.culled;
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
