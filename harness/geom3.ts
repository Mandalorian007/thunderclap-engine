/**
 * Geometry-pipeline page (ws/geom-3): the build-time tools of `@thunderclap/engine/geom` on screen.
 *
 * - `?lod` (default): a lumpy rock, `createLodChain` to four levels, drawn at four distances,
 *   each at the level `selectLod` picks for its projected size.
 * - `?hull`: a torus beside its `convexHull`.
 * - `?slice`: a cube cut by a horizontal plane that sweeps through it (`sliceGeometry` with
 *   caps), the halves drawn apart. The cuts are made once at start-up and cycled.
 * - `?tiles`: a box dropped onto a moving platform over a tile map, moved by `slideTiles` and
 *   carried with `carryBy`; tile y grows downward, drawn flipped.
 * - `?still` parks the animation in any mode.
 *
 * Nothing here is engine code beyond the imports. e2e/geom3.spec.ts reads the state.
 */
import { GameLoop } from '@thunderclap/engine/core';
import {
  box,
  carryBy,
  convexHull,
  createLodChain,
  createTileSlideResult,
  type Geometry,
  icosphere,
  mergeGeometry,
  selectLod,
  sliceGeometry,
  slideTiles,
  TILE_EMPTY,
  TILE_ONE_WAY,
  TILE_SOLID,
  type TileMover,
  type TileQuery,
  torus,
  transformGeometry,
} from '@thunderclap/engine/geom';
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
  type Geom3Mode,
  type HarnessGeom3State,
  LOD_DISTANCES,
  LOD_THRESHOLDS_PX,
  SLICE_STEPS,
} from './geom3-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const FOV_Y = (50 * Math.PI) / 180;
const query = new URLSearchParams(location.search);
const MODES: readonly Geom3Mode[] = ['lod', 'hull', 'slice', 'tiles'];
const mode: Geom3Mode = MODES.find((m) => query.has(m)) ?? 'lod';
const still = query.has('still');

const state: HarnessGeom3State = {
  ready: false,
  gpu: 'pending',
  mode,
  still,
  frames: 0,
  levels: [],
  chainTriangles: [],
  triangles: 0,
  sourceTriangles: 0,
  hullTriangles: 0,
  sliceD: 0,
  capTriangles: 0,
  closed: false,
  onGround: false,
  carried: 0,
  riding: false,
  boxX: 0,
  boxY: 0,
  stats: { drawCalls: 0, instances: 0, culled: 0 },
  gpuErrors: 0,
};
window.__harnessGeom3 = { state };

const tris = (g: Geometry) => g.indices.length / 3;
const translate = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];

// ------------------------------------------------------------------ build-time geometry

/** An icosphere pushed in and out by a few sines of its position: the same at shared corners. */
function rock(): Geometry {
  const g = icosphere({ radius: 1, subdivisions: 4, color: [0.62, 0.58, 0.52, 1] });
  const F = g.layout.floats;
  const v = g.vertices;
  for (let o = 0; o < v.length; o += F) {
    const x = v[o]!;
    const y = v[o + 1]!;
    const z = v[o + 2]!;
    const k =
      1 + 0.12 * Math.sin(x * 4.1 + y * 1.3) * Math.cos(z * 3.7) + 0.06 * Math.sin(y * 7 + z * 5);
    v[o] = x * k;
    v[o + 1] = y * k;
    v[o + 2] = z * k;
  }
  return g;
}

/** Signed area vector sum of a mesh is zero when it is closed and consistently wound. */
function isClosed(g: Geometry): boolean {
  if (g.indices.length === 0) return false;
  const F = g.layout.floats;
  const v = g.vertices;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t]! * F;
    const b = g.indices[t + 1]! * F;
    const c = g.indices[t + 2]! * F;
    const ux = v[b]! - v[a]!;
    const uy = v[b + 1]! - v[a + 1]!;
    const uz = v[b + 2]! - v[a + 2]!;
    const wx = v[c]! - v[a]!;
    const wy = v[c + 1]! - v[a + 1]!;
    const wz = v[c + 2]! - v[a + 2]!;
    sx += uy * wz - uz * wy;
    sy += uz * wx - ux * wz;
    sz += ux * wy - uy * wx;
  }
  return Math.hypot(sx, sy, sz) < 1e-4;
}

/** Triangles whose first corner's normal faces `ny` (±1) on y: a horizontal cut's cap. */
function facingY(g: Geometry, ny: number): number {
  const F = g.layout.floats;
  let n = 0;
  for (let t = 0; t < g.indices.length; t += 3)
    if (g.vertices[g.indices[t]! * F + 4]! * ny > 0.999) n++;
  return n;
}

// ------------------------------------------------------------------ the tile map

const TILE_ROWS = [
  '................',
  '................',
  '................',
  '..........----..',
  '#..............#',
  '#..............#',
  '#..............#',
  '################',
];
const tiles: TileQuery = {
  cellSize: 1,
  solidAt: (cx, cy) => {
    const ch = TILE_ROWS[cy]?.[cx];
    return ch === '#' ? TILE_SOLID : ch === '-' ? TILE_ONE_WAY : TILE_EMPTY;
  },
};
const PLATFORM_HOME = 3;
const platform: TileMover = { x: PLATFORM_HOME, y: 5, w: 3, h: 0.4, dx: 0, dy: 0 };
const movers = [platform];
const player = { x: PLATFORM_HOME + 1, y: 1, w: 0.8, h: 0.8 };
const slide = createTileSlideResult();
const slideOpts = { movers };
let vy = 0;

function tileGeometry(): Geometry {
  const parts: Geometry[] = [];
  for (let cy = 0; cy < TILE_ROWS.length; cy++) {
    for (let cx = 0; cx < TILE_ROWS[cy]!.length; cx++) {
      const k = tiles.solidAt(cx, cy);
      if (k === TILE_EMPTY) continue;
      const oneWay = k === TILE_ONE_WAY;
      const g = box({
        size: [0.96, oneWay ? 0.2 : 0.96, 0.96],
        color: oneWay ? [0.4, 0.75, 0.9, 1] : [0.45, 0.5, 0.42, 1],
      });
      parts.push(transformGeometry(g, translate(cx + 0.5, -(cy + (oneWay ? 0.1 : 0.5)), 0)));
    }
  }
  return mergeGeometry(...parts);
}

// ------------------------------------------------------------------ the material

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

interface Draw {
  mesh: Mesh;
  t: Transform;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine geometry pipeline demo' });
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

  const camera = Camera.perspective(FOV_Y, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.dir = [-0.4, -1.0, -0.6];
  lights.sun.color = [0.9, 0.88, 0.82];

  const draws: Draw[] = [];
  // ?lod
  const lodMeshes: Mesh[] = [];
  let lodRadius = 1;
  const lodRocks: Transform[] = [];
  const EYE = [0, 0, 0] as const;
  // ?slice: one pair of meshes per plane position, below then above.
  const slices: { below: Mesh; above: Mesh; d: number; caps: number; closed: boolean }[] = [];
  const sliceBelow = new Transform();
  const sliceAbove = new Transform();
  // ?tiles
  const playerT = new Transform();
  const platformT = new Transform();

  if (mode === 'lod') {
    camera.lookAt(EYE, [0, 0, -1]);
    const chain = createLodChain(rock(), [0.4, 0.15, 0.05]);
    state.chainTriangles = chain.map(tris);
    lodRadius = chain[0]!.bounds.radius;
    for (const g of chain) lodMeshes.push(renderer.createMesh(g));
    // Each rock on a ray from the eye, fanned left to right, `LOD_DISTANCES[i]` away.
    for (let i = 0; i < LOD_DISTANCES.length; i++) {
      const d = LOD_DISTANCES[i]!;
      const a = (i - 1.5) * 0.22;
      lodRocks.push(new Transform({ x: Math.sin(a) * d, y: -0.12 * d, z: -Math.cos(a) * d }));
      state.levels.push(0);
    }
  } else if (mode === 'hull') {
    camera.lookAt([0, 1.4, 3.2], [0, 0, 0]);
    const t = torus({ radius: 0.6, tube: 0.22, color: [0.5, 0.75, 0.95, 1] });
    const hull = convexHull(t);
    state.sourceTriangles = tris(t);
    state.hullTriangles = tris(hull);
    draws.push({ mesh: renderer.createMesh(t), t: new Transform({ x: -0.95 }) });
    draws.push({ mesh: renderer.createMesh(hull), t: new Transform({ x: 0.95 }) });
  } else if (mode === 'slice') {
    camera.lookAt([2.2, 1.6, 3.2], [0, 0, 0]);
    const cube = box({ size: 1.2, color: [0.95, 0.55, 0.3, 1] });
    for (let s = 0; s < SLICE_STEPS; s++) {
      const d = -0.5 + (s + 0.5) / SLICE_STEPS;
      const { above, below } = sliceGeometry(cube, { nx: 0, ny: 1, nz: 0, d }, { cap: true });
      slices.push({
        below: renderer.createMesh(below),
        above: renderer.createMesh(above),
        d,
        caps: facingY(below, 1) + facingY(above, -1),
        closed: isClosed(below) && isClosed(above),
      });
    }
    sliceAbove.setPosition(0, 0.25, 0);
  } else {
    camera.lookAt([8, -4, 11], [8, -4, 0]);
    draws.push({ mesh: renderer.createMesh(tileGeometry()), t: new Transform() });
    const unit = box({ size: 1, color: [0.95, 0.85, 0.3, 1] });
    draws.push({ mesh: renderer.createMesh(unit), t: playerT });
    draws.push({
      mesh: renderer.createMesh(box({ size: 1, color: [0.85, 0.5, 0.95, 1] })),
      t: platformT,
    });
    playerT.setScale(player.w, player.h, 0.8);
    platformT.setScale(platform.w, platform.h, 0.9);
  }

  let time = 0;
  const loop = new GameLoop({
    update(dt) {
      if (!still) time += dt;
      if (mode !== 'tiles') return;
      // Platforms move first, then the box: carried by what it stood on, then its own motion.
      const x = still ? PLATFORM_HOME : PLATFORM_HOME + 2.5 * (1 - Math.cos(time * 0.9));
      platform.dx = x - platform.x;
      platform.dy = 0;
      platform.x = x;
      if (slide.riding >= 0) {
        carryBy(slide, movers[slide.riding]!);
        state.carried += Math.abs(platform.dx);
      }
      vy = Math.min(vy + 0.01, 0.3);
      slideTiles(tiles, player, 0, vy, slide, slideOpts);
      player.x = slide.x;
      player.y = slide.y;
      if (slide.onGround) vy = 0;
      state.onGround = slide.onGround;
      state.riding = slide.riding >= 0;
      state.boxX = player.x;
      state.boxY = player.y;
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      if (mode === 'lod') {
        let sum = 0;
        for (let i = 0; i < lodRocks.length; i++) {
          const r = lodRocks[i]!;
          r.setAxisAngle(0.3, 1, 0.1, time * 0.4 + i);
          const p = r.position;
          const dist = Math.hypot(p.x - EYE[0], p.y - EYE[1], p.z - EYE[2]);
          const level = selectLod(
            lodMeshes,
            lodRadius,
            dist,
            FOV_Y,
            LOGICAL.height,
            LOD_THRESHOLDS_PX,
          );
          state.levels[i] = level;
          sum += state.chainTriangles[level]!;
          frame.mesh(lodMeshes[level]!, lit, r);
        }
        state.triangles = sum;
      } else if (mode === 'slice') {
        const s = still ? SLICE_STEPS >> 1 : Math.floor(time * 2) % SLICE_STEPS;
        const cut = slices[s]!;
        state.sliceD = cut.d;
        state.capTriangles = cut.caps;
        state.closed = cut.closed;
        sliceBelow.setAxisAngle(0, 1, 0, time * 0.3);
        sliceAbove.setAxisAngle(0, 1, 0, time * 0.3);
        frame.mesh(cut.below, lit, sliceBelow);
        frame.mesh(cut.above, lit, sliceAbove);
      } else {
        if (mode === 'tiles') {
          playerT.setPosition(player.x + player.w / 2, -(player.y + player.h / 2), 0);
          platformT.setPosition(platform.x + platform.w / 2, -(platform.y + platform.h / 2), 0);
        } else {
          for (const d of draws) d.t.setAxisAngle(1, 0.4, 0, time * 0.4);
        }
        for (const d of draws) frame.mesh(d.mesh, lit, d.t);
      }
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
