/**
 * Follow camera page (ws/follow): a capsule on a ground grid between a few walls, moved on WASD,
 * the touch stick or the pad through `Look.move`; a `Follow` drives the camera from `Look`'s
 * look deltas. Noun-free; the world and its line-of-sight test are what a game would write.
 *
 * - Desktop: click the canvas for the pointer lock, then the mouse orbits; WASD moves relative
 *   to the camera; `V` toggles first and third person; the wheel zooms.
 * - Touch: left-half finger moves, right-half drag orbits. Pad: left stick moves, right looks.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { Follow, Input, Look, type Vec3 } from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import type { HarnessFollowApi, HarnessFollowState } from './follow-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessFollowState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  mode: 'third',
  position: [0, 0, 0],
  distance: 0,
  wanted: 0,
  target: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  instances: 0,
  culled: 0,
  gpuErrors: 0,
  projected: 0,
  nearCornerZ: 0,
};

/** A unit cube centred on the origin, 24 vertices (12 floats each), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
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

/**
 * A capsule of radius `r` whose straight part is `h` tall, feet at y = 0: two hemispheres on a
 * cylinder, `rings` latitude bands per half and `segs` around. Smooth normals.
 */
function capsuleGeometry(
  r: number,
  h: number,
  rings = 6,
  segs = 16,
): { vertices: Float32Array; indices: Uint16Array } {
  const rows = rings * 2 + 2;
  const cols = segs + 1;
  const vertices = new Float32Array(rows * cols * 12);
  const indices = new Uint16Array(rings * 2 * segs * 6 + segs * 6);
  let v = 0;
  for (let row = 0; row < rows; row++) {
    // Rows 0..rings: top hemisphere (pole first); rows rings+1..: bottom hemisphere.
    const top = row <= rings;
    const k = top ? row : row - rings - 1;
    const lat = top ? (k / rings) * (Math.PI / 2) : Math.PI / 2 + (k / rings) * (Math.PI / 2);
    const ny = Math.cos(lat);
    const ring = Math.sin(lat);
    const cy = top ? r + h : r;
    for (let col = 0; col < cols; col++) {
      const a = (col / segs) * Math.PI * 2;
      const nx = Math.cos(a) * ring;
      const nz = Math.sin(a) * ring;
      vertices[v] = nx * r;
      vertices[v + 1] = cy + ny * r;
      vertices[v + 2] = nz * r;
      vertices[v + 3] = nx;
      vertices[v + 4] = ny;
      vertices[v + 5] = nz;
      vertices[v + 6] = col / segs;
      vertices[v + 7] = row / (rows - 1);
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += 12;
    }
  }
  let i = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < segs; col++) {
      const a = row * cols + col;
      const b = a + cols;
      indices[i++] = a;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = b + 1;
    }
  }
  return { vertices, indices };
}

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** An axis-aligned wall: centre and half extents. */
interface Wall {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
}

/** Centre (x, z), half size (hx, hz), height. */
function wall(cx: number, cz: number, hx: number, hz: number, height = 3): Wall {
  return { cx, cy: height / 2, cz, hx, hy: height / 2, hz };
}

const WALLS: Wall[] = [
  wall(0, 6, 3, 0.25), // across, behind the start (the camera swings in against it)
  wall(-6, 0, 0.25, 5), // left
  wall(6, 0, 0.25, 5), // right
  wall(2, -5, 1.5, 0.25), // a short one ahead
];

/** The game's line of sight: first `t` in [0, 1] where the segment enters any wall. */
function obstacle(from: Vec3, to: Vec3, out: Vec3): boolean {
  let best = Number.POSITIVE_INFINITY;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  for (const w of WALLS) {
    let t0 = 0;
    let t1 = 1;
    t0 = Math.max(t0, slab(from[0], dx, w.cx - w.hx, w.cx + w.hx, 0));
    t1 = Math.min(t1, slab(from[0], dx, w.cx - w.hx, w.cx + w.hx, 1));
    t0 = Math.max(t0, slab(from[1], dy, w.cy - w.hy, w.cy + w.hy, 0));
    t1 = Math.min(t1, slab(from[1], dy, w.cy - w.hy, w.cy + w.hy, 1));
    t0 = Math.max(t0, slab(from[2], dz, w.cz - w.hz, w.cz + w.hz, 0));
    t1 = Math.min(t1, slab(from[2], dz, w.cz - w.hz, w.cz + w.hz, 1));
    if (t0 <= t1 && t0 < best) best = t0;
  }
  if (!Number.isFinite(best)) return false;
  out[0] = from[0] + dx * best;
  out[1] = from[1] + dy * best;
  out[2] = from[2] + dz * best;
  return true;
}

/** Entry (`end` 0) or exit (`end` 1) parameter of a ray through a slab `lo..hi` on one axis. */
function slab(o: number, d: number, lo: number, hi: number, end: 0 | 1): number {
  if (d === 0) {
    const inside = o >= lo && o <= hi;
    return end === 0
      ? inside
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY
      : inside
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY;
  }
  const a = (lo - o) / d;
  const b = (hi - o) / d;
  return end === 0 ? Math.min(a, b) : Math.max(a, b);
}

const WALK_PER_S = 4;
const ARENA = 9.5;

const look = new Look({
  keys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
});

type Action = 'view' | 'zoomIn' | 'zoomOut';

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine follow camera demo' });
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

  const camera = Camera.perspective((60 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const capsule = renderer.createMesh({
    ...capsuleGeometry(0.35, 1.1),
    layout: VERTEX_LAYOUT_3D,
    label: 'capsule',
  });

  const groundT = new Transform({ y: -0.5, scaleX: 40, scaleY: 1, scaleZ: 40 });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const walls = WALLS.map((w, i) => ({
    t: new Transform({
      x: w.cx,
      y: w.cy,
      z: w.cz,
      scaleX: w.hx * 2,
      scaleY: w.hy * 2,
      scaleZ: w.hz * 2,
    }),
    p: { tint: [0.55 + 0.1 * (i % 2), 0.4, 0.35, 1] } as InstanceParams,
  }));
  const body = new Transform({});
  const bodyP: InstanceParams = { tint: [0.9, 0.55, 0.2, 1] };
  // The six draw centres a HUD would label, projected in one call per frame (ws/camera-ergo).
  const centres = new Float32Array(6 * 3);
  centres.set([0, -0.5, 0], 0);
  WALLS.forEach((w, i) => {
    centres.set([w.cx, w.cy, w.cz], 3 + i * 3);
  });
  const projected = new Float32Array(6 * 3);
  const corners = new Float32Array(24);

  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];

  // The target the camera follows: the capsule's feet and facing.
  const target = { position: [0, 0, 0] as Vec3, yaw: 0 };
  const follow = new Follow(camera, {
    distance: 4,
    shoulder: [0.5, 0],
    eyeHeight: 1.5,
    obstacle,
  });
  follow.target = target;
  follow.setLook(look);
  follow.update(0);

  const input = new Input<Action>(
    {
      view: [{ key: 'KeyV' }, { padButton: 3 }],
      zoomIn: [{ wheel: -1 }],
      zoomOut: [{ wheel: 1 }],
    },
    { look },
  );
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));
  surface.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !look.locked) void look.request();
  });

  const api: HarnessFollowApi = {
    state,
    setMode(mode) {
      follow.mode = mode;
    },
    teleport(x, z) {
      target.position[0] = x;
      target.position[2] = z;
      follow.snap();
    },
    setYaw(yaw) {
      follow.yaw = yaw;
    },
  };
  window.__harnessFollow = api;

  const publish = () => {
    state.mode = follow.mode;
    state.position[0] = follow.position[0];
    state.position[1] = follow.position[1];
    state.position[2] = follow.position[2];
    state.distance = follow.currentDistance;
    state.wanted = follow.distance;
    state.target[0] = target.position[0];
    state.target[1] = target.position[1];
    state.target[2] = target.position[2];
    state.yaw = follow.yaw;
    state.pitch = follow.pitch;
    centres[15] = target.position[0];
    centres[16] = 0.9;
    centres[17] = target.position[2];
    state.projected = camera.projectMany(centres, projected);
    camera.frustumCorners(corners);
    state.nearCornerZ = camera.viewZ(corners[0]!, corners[1]!, corners[2]!);
  };

  const loop = new GameLoop({
    update(dt) {
      input.update();
      if (input.pressed('view')) follow.mode = follow.mode === 'third' ? 'first' : 'third';
      if (input.pressed('zoomIn')) follow.zoom(-1);
      if (input.pressed('zoomOut')) follow.zoom(1);
      // Move relative to the camera's yaw; the capsule faces where it walks.
      const mv = look.move;
      const fx = Math.sin(follow.yaw);
      const fz = -Math.cos(follow.yaw);
      const step = WALK_PER_S * dt;
      const p = target.position;
      p[0] = Math.max(-ARENA, Math.min(ARENA, p[0] + (fx * mv.y + -fz * mv.x) * step));
      p[2] = Math.max(-ARENA, Math.min(ARENA, p[2] + (fz * mv.y + fx * mv.x) * step));
      if (mv.x !== 0 || mv.y !== 0)
        target.yaw = Math.atan2(fx * mv.y - fz * mv.x, -(fz * mv.y + fx * mv.x));
      follow.update(dt);
      body.setPosition(p[0], 0, p[2]);
      body.setAxisAngle(0, 1, 0, target.yaw);
      publish();
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(cube, lit, groundT, groundP);
      for (const w of walls) frame.mesh(cube, lit, w.t, w.p);
      // In first person the body would sit on the lens; a game hides or trims it the same way.
      if (follow.mode === 'third') frame.mesh(capsule, lit, body, bodyP);
      renderer.endFrame();
      state.frames++;
      state.instances = renderer.stats.instances;
      state.culled = renderer.stats.culled;
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
