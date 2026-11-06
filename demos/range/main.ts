/**
 * Range demo: a first-person target range. Look + pick + fx + spatial audio, end to end.
 *
 * - A courtyard with 12 plates on posts. Mouse look under the pointer lock (click to take it),
 *   touch drags look (no move stick), the pad's right stick looks.
 * - A shot (click, tap, right trigger) fires a ray from the eye along the view direction, the
 *   reticle at the screen centre, through one `meshTester` per plate over the cube it draws.
 * - A hit knocks the plate over (the hinge rotation tweened by hand), bursts sparks
 *   (`ParticleSystem`, world space), draws a tracer (`Trail`), plays a positioned synthesised
 *   chime at the plate and adds to the score shown in a `ui` anchor over the range. A plate
 *   rises again `RESET_SECONDS` after it fell.
 *
 * Nothing here is engine code: the camera, the tween and the target rules are what a game writes.
 */
import { AudioEngine, recipes } from '@thunderclap/engine/audio';
import { GameLoop } from '@thunderclap/engine/core';
import { ParticleSystem, Trail } from '@thunderclap/engine/fx';
import {
  createRay,
  Gestures,
  type Hit,
  type HitTester,
  Input,
  Look,
  meshTester,
} from '@thunderclap/engine/input';
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
import { createOverlay } from '@thunderclap/engine/ui';
import { cubeGeometry } from './geometry';
import { type RangeDemoApi, type RangeDemoState, RESET_SECONDS, TARGET_COUNT } from './state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

/** The eye: the shooter stands at the courtyard's near end. */
const EYE = [0, 1.6, 6] as const;
const PITCH_LIMIT = 1.4;
/** Post height (the hinge sits on top) and the plate's half height above it. */
const POST_H = 1.1;
const PLATE_HALF = 0.4;
/** Seconds the plate takes to fall and to rise. */
const FALL_S = 0.35;
const RISE_S = 0.45;
/** How far a miss travels before the tracer ends. */
const MISS_RANGE = 60;
const TRACER_POINTS = 24;

const state: RangeDemoState = {
  ready: false,
  gpu: 'pending',
  frame: 0,
  fps: 0,
  stats: { drawCalls: 0, instances: 0, culled: 0 },
  score: 0,
  shots: 0,
  targetsUp: TARGET_COUNT,
  lastHit: null,
  aimDir: [0, 0, -1],
  yaw: 0,
  pitch: 0,
  locked: false,
  gpuErrors: 0,
};

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  let sky = 0.5 + 0.5 * n.y;
  // params.y: a plate flashes while it falls.
  let flash = in.params.y * vec3f(0.9, 0.6, 0.2);
  var o: FragOut;
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky) + flash, 1.0);
  o.emissive = vec4f(flash, 0.0);
  return o;
}`;

type Phase = 'up' | 'falling' | 'down' | 'rising';

/** One target: a post, a hinge on top and the plate hanging off the hinge. */
interface Target {
  index: number;
  post: Transform;
  hinge: Transform;
  plate: Transform;
  postParams: InstanceParams;
  plateParams: InstanceParams;
  /** `plateParams.params`: y is the flash. */
  flash: [number, number, number, number];
  phase: Phase;
  /** Seconds into the current phase. */
  t: number;
}

/**
 * Where the plates stand: a near row of six and a far row of six, world units. Seen from the
 * eye, each far plate sits in a gap between near plates (the gaps at the near row, scaled by the
 * ratio of the two depths), so every plate has a clear line of fire.
 */
function targetPlacements(): { x: number; z: number }[] {
  const near = -6;
  const far = -11;
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < 6; i++) out.push({ x: -5 + i * 2, z: near });
  const spread = (EYE[2] - far) / (EYE[2] - near);
  for (const gap of [-6, -4, -2, 2, 4, 6]) out.push({ x: gap * spread, z: far });
  return out;
}

function makeTargets(): Target[] {
  return targetPlacements().map(({ x, z }, index) => {
    const hinge = new Transform({ x, y: POST_H, z });
    const plate = new Transform({
      y: PLATE_HALF,
      scaleX: 0.8,
      scaleY: PLATE_HALF * 2,
      scaleZ: 0.08,
      parent: hinge,
    });
    const flash: [number, number, number, number] = [0, 0, 0, 0];
    const hue = index / TARGET_COUNT;
    return {
      index,
      post: new Transform({ x, y: POST_H / 2, z, scaleX: 0.12, scaleY: POST_H, scaleZ: 0.12 }),
      hinge,
      plate,
      postParams: { tint: [0.35, 0.3, 0.26, 1] },
      plateParams: { tint: [0.9, 0.35 + 0.5 * hue, 0.25, 1], params: flash },
      flash,
      phase: 'up',
      t: 0,
    };
  });
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The hinge angle (about +x) for a phase: 0 standing, -π/2 lying away from the shooter. */
function hingeAngle(target: Target): number {
  switch (target.phase) {
    case 'up':
      return 0;
    case 'falling':
      return (-Math.PI / 2) * easeOutCubic(Math.min(1, target.t / FALL_S));
    case 'down':
      return -Math.PI / 2;
    case 'rising':
      return (-Math.PI / 2) * (1 - easeInOutQuad(Math.min(1, target.t / RISE_S)));
  }
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'ThunderClap demo: range' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);

  const camera = Camera.perspective((70 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 120);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;

  // The overlay: the score rides a world anchor over the far row; a toast says how to play.
  const ui = createOverlay({ parent: root });
  ui.setFrame(surface.rect);
  surface.onResize(({ backbuffer, rect }) => {
    renderer.resize(backbuffer.width, backbuffer.height);
    ui.setFrame(rect);
  });
  const scoreEl = document.createElement('div');
  scoreEl.className = 'score';
  scoreEl.dataset.role = 'score';
  ui.anchors(() => camera).add(scoreEl, [0, POST_H + 2.4, -11], { align: [0.5, 1] });
  const showScore = () => {
    scoreEl.textContent = `${state.score} / ${state.shots}`;
  };
  showScore();

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const geometry = cubeGeometry();
  const cube = renderer.createMesh({ ...geometry, layout: VERTEX_LAYOUT_3D, label: 'cube' });

  // The courtyard: a checkered slab and four low walls.
  const ground = new Transform({ y: -0.5, scaleX: 44, scaleY: 1, scaleZ: 44 });
  const groundParams: InstanceParams = { tint: [0.4, 0.44, 0.36, 1], params: [1, 0, 0, 0] };
  const wallParams: InstanceParams = { tint: [0.5, 0.46, 0.42, 1] };
  const walls = [
    new Transform({ z: -16, y: 0.75, scaleX: 24, scaleY: 1.5, scaleZ: 0.6 }),
    new Transform({ z: 9, y: 0.75, scaleX: 24, scaleY: 1.5, scaleZ: 0.6 }),
    new Transform({ x: -12, y: 0.75, z: -3.5, scaleX: 0.6, scaleY: 1.5, scaleZ: 25.6 }),
    new Transform({ x: 12, y: 0.75, z: -3.5, scaleX: 0.6, scaleY: 1.5, scaleZ: 25.6 }),
  ];
  const targets = makeTargets();

  const lights = new Lights();
  lights.ambient.set([0.22, 0.22, 0.26]);
  lights.sun.dir = [-0.4, -1.0, -0.55];
  lights.sun.color = [0.85, 0.82, 0.76];

  // Sparks on a hit, a tracer along every shot.
  const sparks = new ParticleSystem(renderer, {
    space: 'world',
    capacity: 4096,
    floorY: 0,
    bounce: 0.3,
    stretch: 0.015,
  });
  const tracer = new Trail(renderer, {
    space: 'world',
    maxPoints: TRACER_POINTS + 1,
    widthCurve: [0.05, 0.02],
    color: [3.5, 2.6, 1.4, 1],
    lifetime: 0.22,
    minDistance: 0.01,
    facing: 'camera',
    blend: 'additive',
    label: 'tracer',
  });

  // Synthesised sounds; the chime plays at the plate, the listener follows the camera.
  const audio = new AudioEngine();
  audio.attach();
  audio.define('shot', recipes.thud({ pitch: 140, length: 0.22, brightness: 0.6 }));
  audio.define('hit', recipes.chime({ pitch: 880, length: 0.5, brightness: 0.7 }), {
    maxVoices: 6,
  });
  audio.define('miss', recipes.whoosh({ pitch: 600, length: 0.3, direction: 'down' }));
  void audio.prepare().catch(() => undefined);
  const spatial = { refDistance: 3, maxDistance: 60, rolloff: 'linear' as const };

  // Look (no move stick: every touch drags the view) and a fire action from tap or trigger. A
  // finger that never moves fires whether it lifts early (tap) or late (long press), so a slow
  // frame between down and up still shoots; a drag never does.
  const look = new Look({ touch: { moveZone: 'none' } });
  const gestures = new Gestures();
  const input = new Input(
    { fire: [{ gesture: 'tap' }, { gesture: 'longPress' }, { padButton: 7 }, { padButton: 0 }] },
    { look, gestures },
  );
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));
  surface.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !look.locked) void look.request();
  });

  // One tester per plate over the CPU copy of the cube it draws; the plate transform is read
  // on every call, so a falling plate is picked where it is.
  const testers: HitTester<number>[] = targets.map((t) =>
    meshTester(t.plate, geometry.vertices, geometry.indices, t.index),
  );
  const ray = createRay();
  const hitPoint: [number, number, number] = [0, 0, 0];

  const eye = new Float32Array(3);
  const lookTarget = new Float32Array(3);
  function placeCamera(): void {
    const cp = Math.cos(state.pitch);
    eye[0] = EYE[0];
    eye[1] = EYE[1];
    eye[2] = EYE[2];
    // Yaw 0 looks down -z; positive yaw turns right (towards +x).
    state.aimDir[0] = Math.sin(state.yaw) * cp;
    state.aimDir[1] = Math.sin(state.pitch);
    state.aimDir[2] = -Math.cos(state.yaw) * cp;
    lookTarget[0] = eye[0] + state.aimDir[0];
    lookTarget[1] = eye[1] + state.aimDir[1];
    lookTarget[2] = eye[2] + state.aimDir[2];
    camera.lookAt(eye, lookTarget);
  }

  function aim(yaw: number, pitch: number): void {
    state.yaw = yaw;
    state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    placeCamera();
  }

  function aimAt(index: number): void {
    const t = targets[index];
    if (!t) return;
    // The plate's centre while standing: the hinge plus half a plate up.
    const p = t.hinge.position;
    const dx = p.x - EYE[0];
    const dy = p.y + PLATE_HALF - EYE[1];
    const dz = p.z - EYE[2];
    aim(Math.atan2(dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }

  function knockOver(t: Target, at: Hit<number>): void {
    t.phase = 'falling';
    t.t = 0;
    t.flash[1] = 1;
    state.score++;
    sparks.emit(
      {
        x: at.point[0],
        y: at.point[1],
        z: at.point[2],
        shape: { kind: 'sphere', radius: 0.05 },
        speed: [1.5, 6],
        life: [0.25, 0.7],
        size: [0.07, 0.01],
        colorStart: [4, 2.6, 0.9, 1],
        colorEnd: [2.5, 0.5, 0.1, 0],
        gravity: [0, -9.8, 0],
        drag: 1.2,
        emissive: 1,
      },
      48,
    );
    audio.play('hit', { at: [at.point[0], at.point[1], at.point[2]], spatial });
  }

  function fire(): void {
    state.shots++;
    ray.origin[0] = eye[0];
    ray.origin[1] = eye[1];
    ray.origin[2] = eye[2];
    ray.dir[0] = state.aimDir[0];
    ray.dir[1] = state.aimDir[1];
    ray.dir[2] = state.aimDir[2];
    let best: Hit<number> | null = null;
    for (const test of testers) {
      const h = test(ray);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    // A plate that is not standing is not a target: the shot passes as a miss.
    const target = best ? targets[best.target] : undefined;
    const standing = target?.phase === 'up';
    const reach = best && standing ? best.distance : MISS_RANGE;
    hitPoint[0] = ray.origin[0] + ray.dir[0] * reach;
    hitPoint[1] = ray.origin[1] + ray.dir[1] * reach;
    hitPoint[2] = ray.origin[2] + ray.dir[2] * reach;

    // The tracer: a ribbon from just under the eye to where the shot ended, oldest first.
    tracer.clear();
    const mx = eye[0] + ray.dir[0] * 0.5;
    const my = eye[1] - 0.25;
    const mz = eye[2] + ray.dir[2] * 0.5;
    for (let i = 0; i <= TRACER_POINTS; i++) {
      const k = i / TRACER_POINTS;
      tracer.push(
        mx + (hitPoint[0] - mx) * k,
        my + (hitPoint[1] - my) * k,
        mz + (hitPoint[2] - mz) * k,
      );
    }

    audio.play('shot', { gain: 0.7 });
    if (best && target && standing) {
      state.lastHit = target.index;
      knockOver(target, best);
    } else {
      state.lastHit = null;
      audio.play('miss', { gain: 0.35, at: hitPoint, spatial });
    }
    showScore();
  }

  const api: RangeDemoApi = { state, aim, aimAt, fire };
  (window as unknown as { __demo: RangeDemoApi }).__demo = api;

  placeCamera();
  ui.toasts.show(
    navigator.maxTouchPoints > 0 ? 'Drag to look, tap to shoot' : 'Click to aim, click to shoot',
    { duration: 4000 },
  );

  const loop = new GameLoop({
    update(dt) {
      input.update();
      if (look.look.dx !== 0 || look.look.dy !== 0) {
        aim(state.yaw + look.look.dx, state.pitch + look.look.dy);
      }
      state.locked = look.locked;
      if (input.pressed('fire')) fire();

      let up = 0;
      for (const t of targets) {
        t.t += dt;
        if (t.phase === 'falling' && t.t >= FALL_S) {
          t.phase = 'down';
          t.t -= FALL_S;
        }
        if (t.phase === 'down' && t.t >= RESET_SECONDS - FALL_S) {
          t.phase = 'rising';
          t.t = 0;
        }
        if (t.phase === 'rising' && t.t >= RISE_S) {
          t.phase = 'up';
          t.t = 0;
        }
        t.flash[1] = t.phase === 'falling' ? 1 - t.t / FALL_S : 0;
        t.hinge.setAxisAngle(1, 0, 0, hingeAngle(t));
        if (t.phase === 'up') up++;
      }
      state.targetsUp = up;

      sparks.update(dt);
      tracer.update(dt, camera);
      audio.listener.fromCamera(camera);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.32, 0.46, 0.68);
      frame.lights = lights;
      frame.mesh(cube, lit, ground, groundParams);
      for (const w of walls) frame.mesh(cube, lit, w, wallParams);
      for (const t of targets) {
        frame.mesh(cube, lit, t.post, t.postParams);
        frame.mesh(cube, lit, t.plate, t.plateParams);
      }
      tracer.draw(frame);
      frame.drawable(sparks);
      renderer.endFrame();
      ui.updateAnchors();

      state.frame++;
      if (time.frameDt > 0) {
        const fps = 1 / time.frameDt;
        state.fps = state.fps === 0 ? fps : state.fps + (fps - state.fps) * 0.1;
      }
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
  console.error('[demo-range]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
