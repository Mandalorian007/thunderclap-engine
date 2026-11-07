/**
 * Arena demo (E-021): a third-person skinned humanoid runs around a lit arena. Idle and run
 * clips blend by speed in an `AnimationMixer`; a sword rides a hand socket and leaves a `Trail`
 * when swung and stamps a `Decals` scorch where the blade meets a pillar or an orb; a `Follow`
 * camera is driven by `Look`; PBR ground, pillars and the skinned body through
 * `createStandardMaterial` under a shadowing sun and two coloured point lights; dust at the feet
 * from the engine's world-space particles; fog; a toast on each swing; a stamina `bar` in the HUD.
 *
 * Controls: WASD / left stick / left-half touch stick moves (relative to the camera); mouse
 * (click for the pointer lock) / right stick / right-half drag looks; click, tap, Space or the
 * pad's A button swings; the wheel, a pinch or the shoulder buttons zoom (`Look.zoom` → `Follow`).
 *
 * `?still` parks the idle bob and the dust so probes read a steady frame.
 */

import { createGame } from '@thunderclap/engine';
import {
  AnimationMixer,
  attachTransform,
  createSocket,
  poseToWorld,
  skinMatrices,
  WORLD_NODE_FLOATS,
} from '@thunderclap/engine/anim';
import type { Scene } from '@thunderclap/engine/core';
import { Decals, Trail } from '@thunderclap/engine/fx';
import { box, cylinder, mergeGeometry, plane, transformGeometry } from '@thunderclap/engine/geom';
import { Follow, Look } from '@thunderclap/engine/input';
import {
  type Camera,
  createStandardMaterial,
  type Frame,
  gpuDiagnostics,
  type InstanceParams,
  JOINT_FLOATS,
  Lights,
  type Mesh,
  SkinPalette,
  Transform,
  VERTEX_LAYOUT_3D,
  VERTEX_LAYOUT_SKINNED,
} from '@thunderclap/engine/render';
import { bar } from '@thunderclap/engine/ui';
import { scorchPixels, tilePixels } from './geom';
import {
  createBodyMesh,
  createIdleClip,
  createRunClip,
  createSkeleton,
  createSwingClip,
  createSwordMesh,
  NODE_COUNT,
  NODES,
  SWORD_LENGTH,
} from './rig';
import type { ArenaDemoState } from './state';

const state: ArenaDemoState = {
  ready: false,
  gpu: 'pending',
  frame: 0,
  fps: 0,
  simTime: 0,
  speed: 0,
  swinging: false,
  swings: 0,
  position: [0, 0, 0],
  yaw: 0,
  camera: { yaw: 0, pitch: 0, distance: 0 },
  drawCalls: 0,
  shadowDraws: 0,
  triangles: 0,
  stats: { drawCalls: 0, instances: 0, drawables: 0, culled: 0, shadowDraws: 0 },
  trailPoints: 0,
  trailPeak: 0,
  hits: 0,
  decals: 0,
  stamina: 100,
  still: new URLSearchParams(location.search).has('still'),
  gpuErrors: 0,
};
window.__demo = state;

const RUN_SPEED = 5.5;
/** Mixer sub-steps per fixed step while the sword swings: the blade tip is sampled along its arc. */
const SWING_SUBSTEPS = 4;
const ACCEL = 28;
const TURN_RATE = 12;
const ARENA_RADIUS = 11;
const PILLAR_RING = 8.5;
const PILLAR_COUNT = 8;
const FOV = (55 * Math.PI) / 180;
/** The blade tip within this of a pillar's axis (shaft radius 0.36) or an orb's centre is a hit. */
const PILLAR_HIT = 0.6;
const PILLAR_SURFACE = 0.37;
const ORB_HIT = 0.35;
const ORB_SURFACE = 0.14;
/** A swing costs a quarter of the stamina bar; it refills at this rate. */
const STAMINA_MAX = 100;
const SWING_COST = 25;
const STAMINA_REGEN = 20;

type Action = 'swing';

const look = new Look({
  keys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  // The zoom axis: wheel and pinch by default, plus the pad's shoulder buttons. `Follow` reads
  // it from the linked look, so the demo binds no zoom actions of its own.
  zoom: { pad: 'shoulders' },
});

async function main(): Promise<void> {
  const root = document.getElementById('app') as HTMLElement;
  const ctx = await createGame<Action>({
    root,
    title: 'ThunderClap demo: arena',
    design: { width: 1920, height: 1080 },
    particles: {
      space: 'world',
      blend: 'alpha',
      lit: true,
      floorY: 0,
      capacity: 2048,
      softness: 0.3,
    },
    input: {
      bindings: {
        swing: [{ gesture: 'tap' }, { key: 'Space' }, { padButton: 0 }],
      },
    },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const { renderer, camera, surface, input, particles, hooks, ui } = ctx;

  // ── Camera: perspective, aspect from the backbuffer ─────────────────────
  surface.onResize(({ backbuffer }) => {
    camera.setPerspective(FOV, backbuffer.width / Math.max(1, backbuffer.height), 0.1, 120);
  });

  // ── The arena ───────────────────────────────────────────────────────────
  const stoneTex = renderer.textureFromPixels({
    width: 128,
    height: 128,
    data: tilePixels({
      size: 128,
      tiles: 4,
      grout: 3,
      base: [0.62, 0.6, 0.56],
      groutColor: [0.22, 0.2, 0.19],
      jitter: 0.35,
      seed: 3,
    }),
    format: 'rgba8unorm-srgb',
    label: 'arena-stone',
  });
  const pillarTex = renderer.textureFromPixels({
    width: 64,
    height: 64,
    data: tilePixels({
      size: 64,
      tiles: 2,
      grout: 2,
      base: [0.78, 0.74, 0.68],
      groutColor: [0.4, 0.37, 0.34],
      jitter: 0.2,
      seed: 11,
    }),
    format: 'rgba8unorm-srgb',
    label: 'arena-pillar',
  });
  const groundMat = createStandardMaterial(renderer, {
    label: 'arena-ground',
    baseColor: stoneTex,
    metallic: 0,
    roughness: 0.9,
  });
  const pillarMat = createStandardMaterial(renderer, {
    label: 'arena-pillar',
    baseColor: pillarTex,
    metallic: 0.05,
    roughness: 0.55,
  });
  const orbMat = createStandardMaterial(renderer, {
    label: 'arena-orb',
    metallic: 0,
    roughness: 0.4,
    baseColorFactor: [0.6, 0.6, 0.6, 1],
  });
  const palette = new SkinPalette(renderer.device, {
    joints: NODE_COUNT,
    instances: 1,
    label: 'arena-skin',
  });
  // The skinned body through the standard material: vertex colours multiply the (white) base
  // colour, the palette is bound by `skin`, and the slot rides in `params[SKIN_PARAM]` (0 here).
  const skinMat = createStandardMaterial(renderer, {
    label: 'arena-skinned',
    skin: palette,
    metallic: 0,
    roughness: 0.72,
  });
  // Hit decals: one scorch tile, box-projected onto the pillar or orb the blade struck.
  const decals = new Decals(renderer, {
    texture: renderer.textureFromPixels({
      width: 32,
      height: 32,
      data: scorchPixels(32, 7),
      label: 'arena-scorch',
    }),
    capacity: 64,
    lifetime: 12,
    fade: [0.9, 0],
  });

  const mesh = (
    data: { vertices: Float32Array; indices: Uint16Array | Uint32Array },
    label: string,
    skinned = false,
  ): Mesh =>
    renderer.createMesh({
      ...data,
      layout: skinned ? VERTEX_LAYOUT_SKINNED : VERTEX_LAYOUT_3D,
      label,
    });

  // The arena's static meshes come from `geom` (a `Geometry` is a `MeshDesc`): a plane for the
  // ground, a plinth + shaft + capital merged into one pillar, a squat cylinder for each orb.
  const lift = (y: number) => new Transform({ y }).world;
  const groundMesh = renderer.createMesh({
    ...plane({ size: ARENA_RADIUS * 2 + 8, uvScale: 15 }),
    label: 'ground',
  });
  const pillarMesh = renderer.createMesh({
    ...mergeGeometry(
      transformGeometry(box({ size: [1.1, 0.4, 1.1] }), lift(0.2)),
      transformGeometry(
        cylinder({ radius: 0.36, height: 3.2, segments: [14, 1], uvScale: [4, 3] }),
        lift(2.0),
      ),
      transformGeometry(box({ size: [1.0, 0.3, 1.0] }), lift(3.75)),
    ),
    label: 'pillar',
  });
  const orbMesh = renderer.createMesh({
    ...cylinder({ radius: 0.14, height: 0.24, segments: [10, 1] }),
    label: 'orb',
  });
  const groundT = new Transform({});
  const groundP: InstanceParams = { receiveShadow: true, castShadow: false };
  const pillars: Transform[] = [];
  for (let i = 0; i < PILLAR_COUNT; i++) {
    const a = (i / PILLAR_COUNT) * Math.PI * 2 + Math.PI / PILLAR_COUNT;
    pillars.push(new Transform({ x: Math.cos(a) * PILLAR_RING, z: Math.sin(a) * PILLAR_RING }));
  }
  const pillarP: InstanceParams = { castShadow: true, receiveShadow: true };

  // ── Lights: a low sun with a shadow map, two coloured points on orbs, fog ─
  const lights = new Lights();
  lights.ambient.set([0.16, 0.17, 0.2]);
  lights.sun.direction = [-0.55, -1.0, 0.35];
  lights.sun.color = [1.05, 0.98, 0.88];
  lights.sun.shadow = { extent: 18, size: 2048 };
  const POINTS = [
    { position: [-4.5, 1.6, -3.5], color: [2.4, 0.9, 0.3], radius: 9 },
    { position: [4.5, 1.6, 3.5], color: [0.3, 0.9, 2.6], radius: 9 },
  ];
  for (const p of POINTS) lights.points.push(p);
  lights.fog.color = [0.38, 0.42, 0.52];
  lights.fog.density = 1;
  lights.fog.near = 14;
  lights.fog.far = 48;
  const orbs = POINTS.map((p) => ({
    t: new Transform({ x: p.position[0]!, y: p.position[1]!, z: p.position[2]! }),
    p: {
      tint: [p.color[0]! / 2.6, p.color[1]! / 2.6, p.color[2]! / 2.6, 1],
      emissive: 2.5,
      castShadow: false,
    } as InstanceParams,
  }));

  // ── The character: skeleton, skinned body, mixer, sword on a hand socket ─
  const skeleton = createSkeleton();
  const bodyMesh = mesh(createBodyMesh(skeleton), 'body', true);
  const swordMesh = mesh(createSwordMesh(), 'sword');
  const world = new Float32Array(NODE_COUNT * WORLD_NODE_FLOATS);
  const jointMats = new Float32Array(NODE_COUNT * JOINT_FLOATS);
  const mixer = new AnimationMixer(skeleton);
  const idle = mixer.play(createIdleClip(), { layer: 0, weight: 1 });
  const run = mixer.play(createRunClip(), { layer: 0, weight: 0 });
  // `?still`: the idle bob stops, so a probe reads the same pose every frame.
  if (state.still) idle.speed = 0;
  const swingClip = createSwingClip();
  let swing: ReturnType<typeof mixer.play> | null = null;
  const body = new Transform({});
  const bodyP: InstanceParams = { params: [0, 0, 0, 0], castShadow: true, receiveShadow: true };
  const handSocket = createSocket(skeleton, NODES.handR, { position: [0, -0.07, 0] });
  const sword = new Transform({});
  const swordP: InstanceParams = { castShadow: true, receiveShadow: true };
  const tip = new Float32Array(3);
  const trail = new Trail(renderer, {
    space: 'world',
    maxPoints: 48,
    width: 0.16,
    color: [1.0, 0.85, 0.5, 0.9],
    lifetime: 0.28,
    minDistance: 0.02,
    facing: 'camera',
    blend: 'additive',
  });

  // ── Movement and camera ─────────────────────────────────────────────────
  const target = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
  const vel = { x: 0, z: 0 };
  const follow = new Follow(camera, {
    distance: 4.5,
    minDistance: 1.6,
    maxDistance: 9,
    shoulder: [0.45, 0],
    eyeHeight: 1.45,
    smoothing: 10,
    pitch: 0.28,
  });
  follow.target = target;
  follow.setLook(look);
  follow.update(0);
  input.setLook(look);
  surface.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && !look.locked) void look.request();
  });

  let dustCarry = 0;
  const DUST_RATE = 60;

  // ── HUD: a stamina bar (ui widgets `bar`) in the bottom region ──────────
  const stamina = bar('Stamina', STAMINA_MAX, { min: 0, max: STAMINA_MAX, segments: 4 });
  stamina.element.id = 'arena-stamina';
  ui.layout.add(stamina.element, { place: { default: 'bottom' } });

  /** Targets the blade already marked this swing: bit i is pillar i, bit PILLAR_COUNT + i orb i. */
  let hitMask = 0;
  const startSwing = () => {
    if (swing && !swing.finished) return;
    swing = mixer.play(swingClip, { layer: 1, loop: false, fadeIn: 0.04 });
    state.swings++;
    state.trailPeak = 0;
    state.stamina = Math.max(0, state.stamina - SWING_COST);
    hitMask = 0;
    trail.clear();
    ui.toasts.show(`Swing ${state.swings}`, { tone: 'info', duration: 900 });
  };

  const stamp = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    size: number,
  ) => {
    decals.add({
      x,
      y,
      z,
      nx,
      ny,
      nz,
      size,
      rotation: state.hits * 1.7,
      color: [0.3, 0.24, 0.2, 1],
    });
    state.hits++;
  };
  /** The blade tip against every pillar shaft and orb; the first touch per target stamps a decal. */
  const stampHits = () => {
    for (let i = 0; i < PILLAR_COUNT; i++) {
      if (hitMask & (1 << i)) continue;
      const p = pillars[i]!.position;
      const dx = tip[0]! - p.x;
      const dz = tip[2]! - p.z;
      const d = Math.hypot(dx, dz);
      if (d > PILLAR_HIT || tip[1]! < 0.1 || tip[1]! > 3.9) continue;
      hitMask |= 1 << i;
      stamp(
        p.x + (dx / d) * PILLAR_SURFACE,
        tip[1]!,
        p.z + (dz / d) * PILLAR_SURFACE,
        dx,
        0,
        dz,
        0.5,
      );
    }
    for (let i = 0; i < orbs.length; i++) {
      if (hitMask & (1 << (PILLAR_COUNT + i))) continue;
      const p = orbs[i]!.t.position;
      const dx = tip[0]! - p.x;
      const dy = tip[1]! - p.y;
      const dz = tip[2]! - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > ORB_HIT) continue;
      hitMask |= 1 << (PILLAR_COUNT + i);
      const k = ORB_SURFACE / d;
      stamp(p.x + dx * k, p.y + dy * k, p.z + dz * k, dx, dy, dz, 0.3);
    }
  };

  hooks.update = (dt) => {
    state.simTime += dt;
    if (input.pressed('swing')) startSwing();

    // Move relative to the camera's yaw; the character turns toward its velocity.
    const mv = look.move;
    const fx = Math.sin(follow.yaw);
    const fz = -Math.cos(follow.yaw);
    const wantX = (fx * mv.y + -fz * mv.x) * RUN_SPEED;
    const wantZ = (fz * mv.y + fx * mv.x) * RUN_SPEED;
    const k = Math.min(1, ACCEL * dt);
    vel.x += (wantX - vel.x) * k;
    vel.z += (wantZ - vel.z) * k;
    const p = target.position;
    p[0] += vel.x * dt;
    p[2] += vel.z * dt;
    const r = Math.hypot(p[0], p[2]);
    if (r > ARENA_RADIUS) {
      p[0] *= ARENA_RADIUS / r;
      p[2] *= ARENA_RADIUS / r;
    }
    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 0.3) {
      const wantYaw = Math.atan2(vel.x, -vel.z);
      let d = wantYaw - target.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      target.yaw += d * Math.min(1, TURN_RATE * dt);
    }
    follow.update(dt);
    body.setPosition(p[0], 0, p[2]);
    body.setAxisAngle(0, 1, 0, target.yaw);

    // Blend idle and run by speed; the run clip keeps pace with the feet.
    const t = Math.min(1, speed / RUN_SPEED);
    idle.weight = 1 - t;
    run.weight = t;
    run.speed = 0.6 + 0.4 * t;
    // While the sword swings the mixer runs in sub-steps and the blade tip is pushed into the
    // trail after each one, so one fixed step (or a clamped burst of them after a stalled frame)
    // samples the whole arc instead of one point. `trailPeak` is the most points the trail held
    // during the current swing, read here before the trail ages them.
    const swinging = swing !== null && !swing.finished;
    const steps = swinging ? SWING_SUBSTEPS : 1;
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      mixer.update(sub);
      poseToWorld(skeleton, mixer.pose, world);
      attachTransform(handSocket, world, body.world, sword);
      if (swinging) {
        const m = sword.world;
        const y = -SWORD_LENGTH;
        tip[0] = m[1]! * y + m[3]!;
        tip[1] = m[5]! * y + m[7]!;
        tip[2] = m[9]! * y + m[11]!;
        trail.push(tip[0]!, tip[1]!, tip[2]!);
        stampHits();
      }
    }
    skinMatrices(skeleton, world, jointMats);
    if (trail.count > state.trailPeak) state.trailPeak = trail.count;
    trail.update(dt, camera);
    decals.update(dt);
    state.stamina = Math.min(STAMINA_MAX, state.stamina + STAMINA_REGEN * dt);
    stamina.set(Math.round(state.stamina));
    stamina.tone(state.stamina < SWING_COST ? 'warn' : 'accent');

    // Dust kicked up at the feet while running.
    if (!state.still) dustCarry += DUST_RATE * t * dt;
    const n = Math.floor(dustCarry);
    if (n > 0) {
      dustCarry -= n;
      particles.emit(
        {
          x: p[0] - Math.sin(target.yaw) * 0.2,
          y: 0.05,
          z: p[2] + Math.cos(target.yaw) * 0.2,
          shape: { kind: 'sphere', radius: 0.18 },
          speed: [0.4, 1.4],
          vz: 0,
          life: [0.5, 1.1],
          size: [0.12, 0.3],
          colorStart: [0.6, 0.55, 0.45, 0.45],
          colorEnd: [0.6, 0.55, 0.45, 0],
          gravity: [0, -0.6, 0],
          drag: 2.5,
        },
        n,
      );
    }

    state.speed = speed;
    state.swinging = swinging;
    state.position[0] = p[0];
    state.position[1] = p[1];
    state.position[2] = p[2];
    state.yaw = target.yaw;
    state.camera.yaw = follow.yaw;
    state.camera.pitch = follow.pitch;
    state.camera.distance = follow.currentDistance;
  };

  // ── Render: one scene draws the arena ───────────────────────────────────
  let triangles = 0;
  const draw = (
    frame: Frame,
    m: Mesh,
    mat: Parameters<Frame['mesh']>[1],
    t: Transform,
    p: InstanceParams,
  ) => {
    frame.mesh(m, mat, t, p);
    triangles += m.indexCount / 3;
  };
  const scene: Scene<unknown, Frame, Camera> = {
    render(frame) {
      triangles = 0;
      frame.clear(0.38, 0.42, 0.52);
      frame.lights = lights;
      palette.set(0, jointMats);
      palette.flush();
      draw(frame, groundMesh, groundMat, groundT, groundP);
      for (const t of pillars) draw(frame, pillarMesh, pillarMat, t, pillarP);
      for (const o of orbs) draw(frame, orbMesh, orbMat, o.t, o.p);
      draw(frame, bodyMesh, skinMat, body, bodyP);
      draw(frame, swordMesh, pillarMat, sword, swordP);
      frame.drawable(decals, 1);
      trail.draw(frame);
      frame.drawable(particles);
    },
  };
  ctx.stack.push(scene);

  let fps = 0;
  hooks.afterRender = (time) => {
    state.frame++;
    const dt = time.frameDt;
    if (dt > 0 && dt < 1) {
      const inst = 1 / dt;
      fps = fps === 0 ? inst : fps + (inst - fps) * 0.08;
    }
    state.fps = fps;
    const s = renderer.stats;
    state.stats = { ...s };
    state.drawCalls = s.drawCalls;
    state.shadowDraws = s.shadowDraws;
    state.triangles = triangles;
    state.trailPoints = trail.count;
    state.decals = decals.count;
    state.gpuErrors = gpuDiagnostics.errorCount;
  };

  ui.toasts.show('WASD / stick: run · mouse / drag: look · click / tap: swing', {
    tone: 'info',
    duration: 5000,
  });
  ctx.loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[arena]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
