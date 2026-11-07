/**
 * Audio zones page (ws/audio-zones): the mesh page's scene with two audio zones, a sphere
 * "room" and a box "corridor", drawn as translucent tinted shells. The camera orbits through
 * both on its own; the listener follows it, `audio.update(dt)` weighs the zones, ramps their
 * ambient loops and resolves the reverb sends. A small cube orbits the scene with a spatial
 * voice following its `Transform` (`Voice.follow`). Audio stays locked in a headless run, so
 * e2e/zones.spec.ts asserts the bookkeeping on `window.__harnessZones`, not sound.
 */
import { AudioEngine, recipes } from '@thunderclap/engine/audio';
import { GameLoop } from '@thunderclap/engine/core';
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
import type { HarnessZonesState, ZoneSnapshot } from './zones-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessZonesState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  camera: { yaw: 0, eye: [0, 0, 0] },
  audioState: 'locked',
  zones: [],
  weights: [],
  peaks: [],
  sends: { music: 0, sfx: 0, ui: 0 },
  baseSends: { music: 0, sfx: 0, ui: 0 },
  inside: null,
  partial: null,
  ambientPeaks: [],
  ambientGains: [],
  followPos: [0, 0, 0],
  moverPos: [0, 0, 0],
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
};
window.__harnessZones = { state };

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
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

/** A unit quad in the XZ plane (y = 0) facing +y, white. */
function groundGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

/** A unit-radius UV sphere, `rings` × `segments`, normals outward, white. */
function sphereGeometry(rings: number, segments: number) {
  const vertices = new Float32Array((rings + 1) * (segments + 1) * 12);
  const indices = new Uint16Array(rings * segments * 6);
  let v = 0;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const y = Math.cos(phi);
    const s = Math.sin(phi);
    for (let c = 0; c <= segments; c++) {
      const theta = (c / segments) * Math.PI * 2;
      const x = s * Math.cos(theta);
      const z = s * Math.sin(theta);
      vertices.set([x, y, z, x, y, z, c / segments, r / rings, 1, 1, 1, 1], v);
      v += 12;
    }
  }
  let i = 0;
  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < segments; c++) {
      const a = r * (segments + 1) + c;
      const b = a + segments + 1;
      indices.set([a, b, a + 1, a + 1, b, b + 1], i);
      i += 6;
    }
  }
  return { vertices, indices };
}

// ------------------------------------------------------------------ materials

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
  let lit = albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky);
  o.color = vec4f(engine_fog(lit, in.worldPos), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** A translucent shell: the tint's alpha, brighter towards the silhouette. */
const ZONE_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  var o: FragOut;
  let n = normalize(in.normal);
  let rim = 0.6 + 0.4 * (1.0 - abs(n.y));
  o.color = vec4f(in.color.rgb * rim * in.color.a, in.color.a);
  o.emissive = vec4f(0.0);
  return o;
}`;

const AMBIENT = [0.18, 0.18, 0.2] as const;
const SUN_DIR = [-0.45, -1.0, -0.65] as const;
const SUN_COLOR = [0.8, 0.8, 0.78] as const;
const FOG_COLOR = [0.6, 0.65, 0.75] as const;

// ------------------------------------------------------------------ the scene

const TARGET = [0, 0.9, 0] as const;
const ORBIT_DISTANCE = 9;
const ORBIT_PITCH = 0.2;
/** The camera's own orbit: a full circle every ~6.3 s, through both zones. */
const ORBIT_RAD_PER_S = 1.0;
/** The eye's orbit radius in the ground plane, where the zones sit. */
const ORBIT_R = ORBIT_DISTANCE * Math.cos(ORBIT_PITCH);
const EYE_Y = TARGET[1] + ORBIT_DISTANCE * Math.sin(ORBIT_PITCH);

/** The sphere room, on the eye's path at yaw 0 (+z). */
const ROOM_CENTER = [0, EYE_Y - 0.5, ORBIT_R] as const;
const ROOM_RADIUS = 3;
/** The box corridor, on the eye's path at yaw π/2 (+x), a quarter orbit after the room. */
const CORRIDOR_CENTER = [ORBIT_R, EYE_Y - 0.5, 0] as const;
const CORRIDOR_HALF = [2, 2.5, 4] as const;
const ROOM_SEND = { music: 0.6, sfx: 0.9, ui: 0 } as const;
const CORRIDOR_SEND = { music: 0.2, sfx: 0.5, ui: 0 } as const;

const MOVER_RADIUS = 4;
const MOVER_HEIGHT = 1.2;
const MOVER_RAD_PER_S = 1.5;

const eye = new Float32Array(3);
let yaw = 0;

function placeCamera(camera: Camera): void {
  const cp = Math.cos(ORBIT_PITCH);
  eye[0] = TARGET[0] + ORBIT_DISTANCE * Math.sin(yaw) * cp;
  eye[1] = EYE_Y;
  eye[2] = TARGET[2] + ORBIT_DISTANCE * Math.cos(yaw) * cp;
  camera.lookAt(eye, TARGET);
  state.camera.yaw = yaw;
  state.camera.eye[0] = eye[0]!;
  state.camera.eye[1] = eye[1]!;
  state.camera.eye[2] = eye[2]!;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine audio zones demo' });
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
  placeCamera(camera);

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const shell = renderer.createMaterial({ label: 'zone', blend: 'alpha', wgsl: ZONE_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });
  const sphere = renderer.createMesh({
    ...sphereGeometry(12, 18),
    layout: VERTEX_LAYOUT_3D,
    label: 'sphere',
  });

  const groundT = new Transform({ scaleX: 24, scaleY: 1, scaleZ: 24 });
  const near = new Transform({ x: 0, y: 0.5, z: 1.5 });
  const far = new Transform({ x: 0, y: 1.5, z: -0.5, scaleX: 2, scaleY: 3, scaleZ: 1 });
  const mover = new Transform({
    x: MOVER_RADIUS,
    y: MOVER_HEIGHT,
    z: 0,
    scaleX: 0.5,
    scaleY: 0.5,
    scaleZ: 0.5,
  });
  const roomT = new Transform({
    x: ROOM_CENTER[0],
    y: ROOM_CENTER[1],
    z: ROOM_CENTER[2],
    scaleX: ROOM_RADIUS,
    scaleY: ROOM_RADIUS,
    scaleZ: ROOM_RADIUS,
  });
  const corridorT = new Transform({
    x: CORRIDOR_CENTER[0],
    y: CORRIDOR_CENTER[1],
    z: CORRIDOR_CENTER[2],
    scaleX: CORRIDOR_HALF[0] * 2,
    scaleY: CORRIDOR_HALF[1] * 2,
    scaleZ: CORRIDOR_HALF[2] * 2,
  });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const nearP: InstanceParams = { tint: [1.0, 0.1, 0.06, 1] };
  const farP: InstanceParams = { tint: [0.08, 0.28, 1.0, 1] };
  const moverP: InstanceParams = { tint: [0.95, 0.8, 0.2, 1] };
  const roomP: InstanceParams = { tint: [0.3, 0.9, 0.5, 0.3] };
  const corridorP: InstanceParams = { tint: [0.9, 0.5, 0.2, 0.3] };

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.direction = SUN_DIR;
  lights.sun.color = SUN_COLOR;
  lights.sun.shadow = { extent: 20, size: 1024 };
  lights.fog.color = FOG_COLOR;
  lights.fog.density = 1;
  lights.fog.near = 10;
  lights.fog.far = 40;

  // ---- audio: a reverb room, two zones and a following voice. Locked until a gesture.
  const audio = new AudioEngine({ reverb: { seconds: 1.5, decay: 3 } });
  audio.attach();
  audio.define('drip', recipes.crackleLoop({ density: 6, pitch: 900 }));
  audio.define('wind', recipes.dronePad({ pitch: 65, brightness: 0.2 }));
  audio.define('hum', recipes.dronePad({ pitch: 220, brightness: 0.5 }));
  audio.prepare().catch(() => {});
  const room = audio.zones.add({
    shape: { sphere: { center: ROOM_CENTER, radius: ROOM_RADIUS } },
    feather: 1.5,
    ambient: { sound: 'drip', bus: 'sfx', gain: 0.7 },
    reverbSend: ROOM_SEND,
    fade: 0.4,
  });
  const corridor = audio.zones.add({
    shape: { box: { center: CORRIDOR_CENTER, halfExtents: CORRIDOR_HALF } },
    feather: 1.5,
    ambient: { sound: 'wind', bus: 'music', gain: 0.5 },
    reverbSend: CORRIDOR_SEND,
    fade: 0.4,
  });
  state.zones = [
    { kind: 'sphere', reverbSend: { ...ROOM_SEND } },
    { kind: 'box', reverbSend: { ...CORRIDOR_SEND } },
  ];
  const hum = audio.loop('hum', { at: [MOVER_RADIUS, MOVER_HEIGHT, 0], bus: 'sfx', gain: 0.4 });
  hum.follow(mover);
  const handles = [room, corridor];
  state.weights = [0, 0];
  state.peaks = [0, 0];
  state.ambientGains = [0, 0];
  state.ambientPeaks = [0, 0];
  const snapshot = (w: ReadonlyArray<number>): ZoneSnapshot => ({
    weights: [...w],
    sends: { ...state.sends },
    baseSends: { ...state.baseSends },
  });

  let spin = 0;
  const loop = new GameLoop({
    update(dt) {
      yaw += ORBIT_RAD_PER_S * dt;
      spin += dt;
      placeCamera(camera);
      mover.setPosition(
        TARGET[0] + MOVER_RADIUS * Math.cos(spin * MOVER_RAD_PER_S),
        MOVER_HEIGHT,
        TARGET[2] + MOVER_RADIUS * Math.sin(spin * MOVER_RAD_PER_S),
      );
      audio.listener.fromCamera(camera);
      audio.update(dt);
      const w = audio.zones.weights();
      for (let i = 0; i < w.length; i++) {
        state.weights[i] = w[i]!;
        if (w[i]! > state.peaks[i]!) state.peaks[i] = w[i]!;
        state.ambientGains[i] = handles[i]!.ambientGain;
        if (state.ambientGains[i]! > state.ambientPeaks[i]!)
          state.ambientPeaks[i] = state.ambientGains[i]!;
      }
      const s = audio.effectiveReverbSendLevels;
      state.sends.music = s.music;
      state.sends.sfx = s.sfx;
      state.sends.ui = s.ui;
      const b = audio.reverbSendLevels;
      state.baseSends.music = b.music;
      state.baseSends.sfx = b.sfx;
      state.baseSends.ui = b.ui;
      if (!state.inside && w[0]! > 0.99) state.inside = snapshot(w);
      if (!state.partial && w[0]! > 0.05 && w[0]! < 0.95) state.partial = snapshot(w);
      const p = hum.position;
      state.followPos[0] = p[0]!;
      state.followPos[1] = p[1]!;
      state.followPos[2] = p[2]!;
      const m = mover.world;
      state.moverPos[0] = m[3]!;
      state.moverPos[1] = m[7]!;
      state.moverPos[2] = m[11]!;
      state.audioState = audio.state;
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      frame.mesh(cube, lit, near, nearP);
      frame.mesh(cube, lit, far, farP);
      frame.mesh(cube, lit, mover, moverP);
      frame.mesh(sphere, shell, roomT, roomP);
      frame.mesh(cube, shell, corridorT, corridorP);
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
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
