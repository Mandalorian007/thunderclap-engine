/**
 * Geometry page: every builder in `@thunderclap/engine/geom` in two rows (primitives in front,
 * sweeps and shapes behind), lit by the engine's lighting block and slowly turning, over a
 * heightfield ground built from a sine bump map (`heightfieldGeometry`). Nothing here is engine
 * code beyond the imports: a game would write the same page. e2e/geom.spec.ts checks the shape
 * count, that a probe pixel on each shape is lit, that `computeTangents` over the extruded star is
 * right-handed throughout, and that the height the page reads under the camera matches the map it
 * was built from.
 */
import { GameLoop } from '@thunderclap/engine/core';
import {
  arch,
  box,
  capsule,
  computeTangents,
  createHeightfield,
  cylinder,
  extrude,
  type Geometry,
  heightAt,
  heightfieldGeometry,
  icosphere,
  lathe,
  plane,
  sphere,
  stairs,
  TANGENT_FLOATS,
  torus,
  transformGeometry,
  tube,
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
  ALL_SHAPE_NAMES,
  bumpHeight,
  GROUND_ORIGIN,
  GROUND_SAMPLES,
  GROUND_SPACING,
  type HarnessGeomApi,
  type HarnessGeomState,
  SHAPE_NAMES,
  SHAPE_NAMES_2,
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
    extrude: { x: 0, y: 0 },
    lathe: { x: 0, y: 0 },
    tube: { x: 0, y: 0 },
    stairs: { x: 0, y: 0 },
    arch: { x: 0, y: 0 },
    sky: { x: 0, y: 0 },
  },
  stats: { drawCalls: 0, instances: 0, culled: 0 },
  tangentW: 0,
  tangentVertices: 0,
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
/**
 * The second row sits behind the first and a little higher: from the eye it projects above the
 * front row and below the sky probe, and the depth test keeps it off every front-row pixel, so the
 * front row's probes are untouched by it.
 */
const ROW2_SPACING = 2.0;
const ROW2_Y = 1.6;
const ROW2_Z = -3.2;
/** Each shape's spin axis (unit-ish; `setAxisAngle` normalises) and rate in radians per second. */
interface ShapeSpec {
  build(): Geometry;
  axis: [number, number, number];
  rate: number;
  /**
   * The world point the spec samples, relative to the shape's centre: a world-space offset, or
   * (with `probeLocal`) a point in the shape's own space that turns with it.
   */
  probe: [number, number, number];
  probeLocal?: boolean;
}

/** A ten-point star, outer radius 0.7, counter-clockwise. */
function starProfile(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.7 : 0.32;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    out.push(r * Math.cos(a), r * Math.sin(a));
  }
  return out;
}

/** A vase: (radius, y) pairs from the foot up to the lip, centred on y = 0. */
const VASE_PROFILE = [0, -0.6, 0.3, -0.6, 0.45, -0.3, 0.35, 0.1, 0.2, 0.3, 0.3, 0.6];

/** Two and a half turns of a helix about +y, radius 0.45, rising from y = -0.6 to 0.6. */
function helixPath(): Float32Array {
  const steps = 60;
  const out = new Float32Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * Math.PI * 2 * 2.5;
    out[i * 3] = 0.45 * Math.cos(a);
    out[i * 3 + 1] = -0.6 + 1.2 * t;
    out[i * 3 + 2] = 0.45 * Math.sin(a);
  }
  return out;
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
  extrude: {
    // Solid through its centre (inner radius 0.32, depth 0.5): the probe is always inside.
    build: () => extrude(starProfile(), { depth: 0.5, bevel: 0.04, color: [0.95, 0.85, 0.3, 1] }),
    axis: [0.2, 1, 0.3],
    rate: 0.4,
    probe: [0, 0, 0],
  },
  lathe: {
    // Spins about its own axis, so the surface is still; the probe sits just inside the wall at
    // y = 0, where the eye's ray meets the outer wall first.
    build: () => lathe(VASE_PROFILE, { segments: 32, color: [0.9, 0.55, 0.4, 1] }),
    axis: [0, 1, 0],
    rate: 0.3,
    probe: [0, 0, 0.3],
  },
  tube: {
    // The probe is the helix's start, on the tube's centreline, carried round with the spin.
    build: () => tube(helixPath(), { radius: 0.12, segments: 12, color: [0.45, 0.9, 0.85, 1] }),
    axis: [0, 1, 0],
    rate: 0.15,
    probe: [0.45, -0.6, 0],
    probeLocal: true,
  },
  stairs: {
    // Four steps of 0.25 × 0.3 recentred: (0, -0.1, 0) is inside the second step.
    build: () => stairs({ steps: 4, width: 1.1, rise: 0.25, run: 0.3, color: [0.8, 0.8, 0.85, 1] }),
    axis: [0, 1, 0],
    rate: 0.25,
    probe: [0, -0.1, 0],
  },
  arch: {
    // The centre is the opening; the probe is in the lintel above it, on the spin axis.
    build: () =>
      arch({ width: 1.2, height: 1.2, depth: 0.3, thickness: 0.18, color: [0.95, 0.5, 0.6, 1] }),
    axis: [0, 1, 0],
    rate: 0.35,
    probe: [0, 0.5, 0],
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
  const names = ALL_SHAPE_NAMES;
  for (let i = 0; i < SHAPE_NAMES.length; i++) {
    const spec = SHAPES[SHAPE_NAMES[i]!];
    meshes.push(renderer.createMesh(spec.build()));
    transforms.push(
      new Transform({ x: (i - (SHAPE_NAMES.length - 1) / 2) * SHAPE_SPACING, y: SHAPE_Y }),
    );
  }
  for (let i = 0; i < SHAPE_NAMES_2.length; i++) {
    const spec = SHAPES[SHAPE_NAMES_2[i]!];
    meshes.push(renderer.createMesh(spec.build()));
    transforms.push(
      new Transform({
        x: (i - (SHAPE_NAMES_2.length - 1) / 2) * ROW2_SPACING,
        y: ROW2_Y,
        z: ROW2_Z,
      }),
    );
  }
  state.shapes = names.length;

  // Tangent-space probe: every frame on the extruded star is right-handed, so the handedness
  // signs sum to the vertex count.
  const tangents = computeTangents(SHAPES.extrude.build());
  state.tangentVertices = tangents.vertices.length / TANGENT_FLOATS;
  let wSum = 0;
  for (let o = TANGENT_FLOATS - 1; o < tangents.vertices.length; o += TANGENT_FLOATS) {
    wSum += tangents.vertices[o]!;
  }
  state.tangentW = wSum;

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.direction = SUN_DIR;
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
        if (spec.probeLocal) {
          const m = t.world;
          probe(
            camera,
            m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
            m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
            m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
            state.probes[names[i]!],
          );
        } else {
          const c = t.position;
          probe(camera, c.x + p[0], c.y + p[1], c.z + p[2], state.probes[names[i]!]);
        }
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
