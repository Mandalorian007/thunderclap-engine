/**
 * ARPG demo (ws/demo-arpg): a Diablo-Immortal-class isometric slice. A hero in a ruined
 * courtyard at dusk clicks (or taps, or holds, or sticks) to move over a baked navmesh, cuts
 * down ghouls that path in with crowd separation, and swaps between three gear sets on sockets.
 *
 * - Scene: `courtyard.ts`, every prop kind one `InstanceList` of `geom` meshes on PBR stone,
 *   six braziers with emissive cores, additive flame particles and a flickering point light
 *   each, a low warm sun with a shadow map, bloom, AO, vignette and a saturated grade.
 * - Hero: the skinned rig on `createStandardMaterial({ skin })`, an anim graph (a 1D idle/run
 *   blend on `speed` plus an `attack` state), a cape on a spring chain, gear on head, shoulder
 *   and hand sockets. Ground picks through `screenRay` → navmesh height → `findMeshPath` →
 *   `followPath3`, steered with a turn rate; a held pointer re-picks every 0.2 s.
 * - Enemies: twelve ghouls on the same skeleton (one `InstanceList`, one `SkinPalette`), each
 *   with its own mixer and graph, replanning a `NavPath3` toward the hero and stepping through
 *   `createCrowd`. Three hits kill; a death shrinks, bursts and respawns at the edge after 3 s.
 * - HUD: health and mana orbs, a four-slot ability row with cooldown sweeps, gear buttons,
 *   anchored health bars and floating damage numbers.
 *
 * `?still` parks the idle bob, the flame flicker and the enemy AI; `?seed=N` fixes the spawns.
 */

import { createGame } from '@thunderclap/engine';
import {
  AnimationMixer,
  type AnimGraph,
  attachTransform,
  createAnimGraph,
  createSocket,
  createSpringChain,
  poseToWorld,
  skinMatrices,
  updateSpringChain,
  WORLD_NODE_FLOATS,
} from '@thunderclap/engine/anim';
import { createRandom, type Scene } from '@thunderclap/engine/core';
import { type EmitParams, ParticleSystem, Trail } from '@thunderclap/engine/fx';
import { createRay, createTouchZones, screenRay, shapeStick } from '@thunderclap/engine/input';
import {
  bakeNavMesh,
  createCrowd,
  createNavPath3,
  findMeshPath,
  followPath3,
  type NavPath3,
  type NavPoint3,
  pathDistance3,
} from '@thunderclap/engine/nav';
import {
  type Camera,
  createStandardMaterial,
  type Frame,
  gpuDiagnostics,
  type InstanceParams,
  JOINT_FLOATS,
  Lights,
  type Material,
  type Mesh,
  type PointLight,
  SkinPalette,
  Transform,
  VERTEX_LAYOUT_SKINNED,
} from '@thunderclap/engine/render';
import { buildCourtyard, HALF } from './courtyard';
import { createGearSets, GEAR_NAMES } from './gear';
import { runePixels, tilePixels, whitePixels } from './geom';
import {
  ability,
  DamageNumbers,
  gearButtons,
  type HealthBar,
  healthBar,
  injectCss,
  orb,
} from './hud';
import {
  createAttackClip,
  createBodyMesh,
  createIdleClip,
  createRunClip,
  createSkeleton,
  GHOUL_LOOK,
  HERO_LOOK,
  NODE_COUNT,
  NODES,
} from './rig';
import { type ArpgDemoState, demoWindow } from './state';

const params = new URLSearchParams(location.search);
const SEED = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const STILL = params.has('still');

const state: ArpgDemoState = {
  ready: false,
  gpu: 'pending',
  frame: 0,
  fps: 0,
  simTime: 0,
  drawCalls: 0,
  triangles: 0,
  heroPos: [0, 0, 0],
  heroState: 'move',
  heroSpeed: 0,
  heroHealth: 100,
  heroMana: 100,
  pathLength: 0,
  moveTarget: null,
  pathing: false,
  enemiesAlive: 0,
  kills: 0,
  hits: 0,
  attacks: 0,
  gearSet: GEAR_NAMES[0]!,
  gearMaterialIds: ['', '', ''],
  gearSwaps: 0,
  rigBuilds: 0,
  cameraPitch: 50,
  navPolys: 0,
  seed: SEED,
  still: STILL,
  gpuErrors: 0,
};
demoWindow.__demo = state;

// ── Tuning ────────────────────────────────────────────────────────────────
const FOV = (34 * Math.PI) / 180;
const PITCH = (50 * Math.PI) / 180;
const CAM_DIST = 24;
const CAM_SMOOTH = 6;
const RUN_SPEED = 6;
const ACCEL = 14;
/** Radians per second the hero turns toward its desired heading. */
const TURN_RATE = 11;
const ARRIVE = 0.25;
const HOLD_REPICK = 0.2;
const ATTACK_RANGE = 2.3;
const ATTACK_SPEED = 1.35;
/** Normalised attack time at which the blade lands. */
const HIT_PHASE = 0.42;
const SWING_SUBSTEPS = 4;
const HERO_MAX = 100;
const MANA_MAX = 100;
const MANA_REGEN = 9;
const ENEMY_COUNT = 12;
const ENEMY_HP = 3;
const ENEMY_SPEED = 3.1;
const ENEMY_REACH = 1.35;
const ENEMY_DAMAGE = 5;
const ENEMY_REPLAN = 0.5;
const RESPAWN_AFTER = 3;
const SHRINK_TIME = 0.45;
const SPAWN_RING = 22;

type Action =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'attack'
  | 'whirl'
  | 'dash'
  | 'nova'
  | 'gear1'
  | 'gear2'
  | 'gear3';

interface AbilityDef {
  name: string;
  hint: string;
  cooldown: number;
  mana: number;
}
const ABILITIES: AbilityDef[] = [
  { name: 'Strike', hint: 'Space', cooldown: 0, mana: 0 },
  { name: 'Whirl', hint: 'Q', cooldown: 4, mana: 20 },
  { name: 'Dash', hint: 'E', cooldown: 3, mana: 10 },
  { name: 'Nova', hint: 'R', cooldown: 8, mana: 40 },
];

/** One animated body: a mixer and graph over the shared skeleton, its pose and its palette slot. */
interface Actor {
  slot: number;
  mixer: AnimationMixer;
  graph: AnimGraph;
  world: Float32Array;
  joints: Float32Array;
  t: Transform;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Attack phase at the last step (to catch the HIT_PHASE crossing). */
  lastPhase: number;
}

interface Enemy extends Actor {
  alive: boolean;
  hp: number;
  /** Seconds since death (-1 alive). */
  dead: number;
  agent: number;
  path: NavPath3;
  replan: number;
  attackCd: number;
  /** Held in place by the spec's `summon()`. */
  held: boolean;
  flash: number;
  params: InstanceParams;
  bar: HealthBar;
  scale: number;
}

async function main(): Promise<void> {
  const root = document.getElementById('app') as HTMLElement;
  const ctx = await createGame<Action>({
    root,
    title: 'ThunderClap demo: arpg',
    design: { width: 1920, height: 1080 },
    post: {
      bloom: { enabled: true, intensity: 0.85, threshold: 1.0, knee: 0.5, scatter: 0.72 },
      fog: { enabled: false, density: 0 },
      godRays: { enabled: false, intensity: 0 },
      ao: { enabled: true, radius: 0.9, intensity: 1.1, bias: 0.04, power: 1.4 },
      vignette: {
        enabled: true,
        intensity: 0.5,
        radius: 0.55,
        softness: 0.55,
        color: [0.06, 0, 0.05],
      },
      grade: {
        enabled: true,
        tonemap: 'aces',
        exposure: 0.95,
        saturation: 1.28,
        contrast: 1.08,
        lift: [0.015, 0, 0.03],
        gain: [1.08, 0.95, 1.02],
      },
    },
    particles: {
      space: 'world',
      blend: 'alpha',
      lit: true,
      floorY: 0,
      capacity: 1024,
      softness: 0.3,
    },
    input: {
      bindings: {
        left: [{ key: 'KeyA' }, { key: 'ArrowLeft' }, { padAxis: 0, dir: -1, threshold: 0.2 }],
        right: [{ key: 'KeyD' }, { key: 'ArrowRight' }, { padAxis: 0, dir: 1, threshold: 0.2 }],
        up: [{ key: 'KeyW' }, { key: 'ArrowUp' }, { padAxis: 1, dir: -1, threshold: 0.2 }],
        down: [{ key: 'KeyS' }, { key: 'ArrowDown' }, { padAxis: 1, dir: 1, threshold: 0.2 }],
        attack: [{ key: 'Space' }, { padButton: 0 }],
        whirl: [{ key: 'KeyQ' }, { padButton: 2 }],
        dash: [{ key: 'KeyE' }, { padButton: 1 }],
        nova: [{ key: 'KeyR' }, { padButton: 3 }],
        gear1: [{ key: 'Digit1' }],
        gear2: [{ key: 'Digit2' }],
        gear3: [{ key: 'Digit3' }],
      },
    },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  const { renderer, camera, surface, input, particles, hooks, ui } = ctx;
  injectCss(document);

  surface.onResize(({ backbuffer }) => {
    camera.setPerspective(FOV, backbuffer.width / Math.max(1, backbuffer.height), 0.5, 140);
  });

  // ── Materials ───────────────────────────────────────────────────────────
  const stone = (label: string, base: [number, number, number], tiles: number, seed: number) =>
    renderer.textureFromPixels({
      width: 128,
      height: 128,
      data: tilePixels({
        size: 128,
        tiles,
        grout: 3,
        base,
        groutColor: [base[0] * 0.35, base[1] * 0.33, base[2] * 0.38],
        jitter: 0.3,
        seed,
      }),
      format: 'rgba8unorm-srgb',
      label,
    });
  const white = renderer.textureFromPixels({
    width: 4,
    height: 4,
    data: whitePixels(4),
    label: 'white',
  });
  const runes = renderer.textureFromPixels({
    width: 64,
    height: 64,
    data: runePixels(64, 5),
    format: 'rgba8unorm-srgb',
    label: 'runes',
  });
  const mats = {
    floor: createStandardMaterial(renderer, {
      label: 'courtyard-floor',
      baseColor: stone('floor', [0.3, 0.27, 0.32], 2, 3),
      roughness: 0.9,
    }),
    wall: createStandardMaterial(renderer, {
      label: 'courtyard-wall',
      baseColor: stone('wall', [0.4, 0.33, 0.32], 4, 9),
      roughness: 0.85,
    }),
    pillar: createStandardMaterial(renderer, {
      label: 'courtyard-pillar',
      baseColor: stone('pillar', [0.66, 0.6, 0.58], 2, 11),
      roughness: 0.7,
      metallic: 0.04,
    }),
    dark: createStandardMaterial(renderer, {
      label: 'courtyard-rubble',
      baseColorFactor: [0.3, 0.26, 0.3, 1],
      roughness: 0.95,
    }),
    metal: createStandardMaterial(renderer, {
      label: 'courtyard-iron',
      baseColorFactor: [0.18, 0.16, 0.16, 1],
      metallic: 0.85,
      roughness: 0.45,
    }),
    flame: createStandardMaterial(renderer, {
      label: 'brazier-flame',
      baseColorFactor: [1, 0.55, 0.2, 1],
      emissive: white,
      emissiveFactor: [7, 2.8, 0.7],
      roughness: 1,
    }),
  };
  const gearMats: [Material, Material][] = [
    [
      createStandardMaterial(renderer, {
        label: 'gear-iron',
        baseColorFactor: [0.5, 0.52, 0.56, 1],
        metallic: 0.9,
        roughness: 0.42,
      }),
      createStandardMaterial(renderer, {
        label: 'gear-iron-blade',
        baseColorFactor: [0.78, 0.8, 0.84, 1],
        metallic: 1,
        roughness: 0.22,
      }),
    ],
    [
      createStandardMaterial(renderer, {
        label: 'gear-gilded',
        baseColorFactor: [1, 0.74, 0.3, 1],
        metallic: 1,
        roughness: 0.3,
        emissive: runes,
        emissiveFactor: [2.4, 1.2, 0.3],
      }),
      createStandardMaterial(renderer, {
        label: 'gear-gilded-runeblade',
        baseColorFactor: [0.85, 0.82, 0.74, 1],
        metallic: 1,
        roughness: 0.2,
        emissive: runes,
        emissiveFactor: [0.5, 1.6, 3.2],
      }),
    ],
    [
      createStandardMaterial(renderer, {
        label: 'gear-bone',
        baseColorFactor: [0.88, 0.82, 0.68, 1],
        metallic: 0,
        roughness: 0.72,
      }),
      createStandardMaterial(renderer, {
        label: 'gear-bone-axe',
        baseColorFactor: [0.8, 0.74, 0.6, 1],
        metallic: 0,
        roughness: 0.6,
      }),
    ],
  ];
  const palette = new SkinPalette(renderer.device, {
    joints: NODE_COUNT,
    instances: 1 + ENEMY_COUNT,
    label: 'arpg-skin',
  });
  const heroMat = createStandardMaterial(renderer, {
    label: 'hero-skin',
    skin: palette,
    roughness: 0.68,
  });
  const ghoulMat = createStandardMaterial(renderer, {
    label: 'ghoul-skin',
    skin: palette,
    baseColorFactor: [0.5, 0.82, 0.48, 1],
    roughness: 0.92,
  });

  // ── The courtyard and its navmesh ───────────────────────────────────────
  const yard = buildCourtyard(renderer, mats);
  const nav = bakeNavMesh(yard.nav, {
    cellSize: 0.3,
    cellHeight: 0.1,
    agentHeight: 1.8,
    agentRadius: 0.4,
    agentMaxClimb: 0.3,
    agentMaxSlope: 45,
  });
  state.navPolys = nav.polyCount;

  // ── Lights ──────────────────────────────────────────────────────────────
  const lights = new Lights();
  lights.ambient.set([0.07, 0.06, 0.12]);
  lights.sun.dir = [0.55, -0.62, 0.55];
  lights.sun.color = [0.95, 0.5, 0.36];
  lights.sun.shadow = { extent: 30, size: 2048 };
  lights.fog.color = [0.16, 0.1, 0.2];
  lights.fog.density = 1;
  lights.fog.near = 30;
  lights.fog.far = 75;
  const FIRE: [number, number, number] = [3.4, 1.45, 0.42];
  const fires: { light: PointLight; color: Float32Array; phase: number }[] = [];
  for (let i = 0; i < yard.braziers.length; i++) {
    const b = yard.braziers[i]!;
    const color = new Float32Array(FIRE);
    const light: PointLight = { position: [b.x, b.y + 0.4, b.z], color, radius: 10 };
    lights.points.push(light);
    fires.push({ light, color, phase: i * 1.7 });
  }

  // ── Particles: flames and sparks (additive), death dust (the game's alpha system) ─
  const fire = new ParticleSystem(renderer, {
    space: 'world',
    blend: 'additive',
    capacity: 1536,
    softness: 0.2,
  });
  const flameEmit: EmitParams = {
    x: 0,
    y: 0,
    z: 0,
    shape: { kind: 'sphere', radius: 0.16 },
    angle: Math.PI / 2,
    spread: 0.5,
    speed: [0.6, 1.4],
    life: [0.35, 0.75],
    size: [0.14, 0.34],
    colorStart: [1, 0.55, 0.18, 0.9],
    colorEnd: [0.7, 0.12, 0.04, 0],
    gravity: [0, 0.6, 0],
    drag: 1.2,
    emissive: 3,
  };
  const sparkEmit: EmitParams = {
    x: 0,
    y: 0,
    z: 0,
    shape: { kind: 'sphere', radius: 0.1 },
    speed: [2, 5],
    life: [0.2, 0.45],
    size: [0.05, 0.12],
    colorStart: [1, 0.85, 0.45, 1],
    colorEnd: [1, 0.25, 0.05, 0],
    gravity: [0, -6, 0],
    drag: 2,
    emissive: 4,
  };
  const novaEmit: EmitParams = {
    x: 0,
    y: 0,
    z: 0,
    shape: { kind: 'sphere', radius: 0.5 },
    angle: 0,
    spread: Math.PI * 2,
    speed: [7, 10],
    life: [0.35, 0.6],
    size: [0.2, 0.4],
    colorStart: [0.5, 0.75, 1, 1],
    colorEnd: [0.3, 0.1, 1, 0],
    gravity: [0, 0, 0],
    drag: 3,
    emissive: 4,
  };
  const deathEmit: EmitParams = {
    x: 0,
    y: 0,
    z: 0,
    shape: { kind: 'sphere', radius: 0.5 },
    angle: Math.PI / 2,
    spread: 2,
    speed: [0.6, 2.2],
    life: [0.6, 1.3],
    size: [0.2, 0.45],
    colorStart: [0.35, 0.5, 0.3, 0.8],
    colorEnd: [0.15, 0.1, 0.2, 0],
    gravity: [0, 0.4, 0],
    drag: 1.5,
  };
  let flameCarry = 0;

  // ── The hero ────────────────────────────────────────────────────────────
  const skeleton = createSkeleton();
  state.rigBuilds++;
  const skinnedMesh = (label: string, look: typeof HERO_LOOK): Mesh =>
    renderer.createMesh({
      ...createBodyMesh(skeleton, look),
      layout: VERTEX_LAYOUT_SKINNED,
      label,
    });
  const heroMesh = skinnedMesh('hero', HERO_LOOK);
  const ghoulMesh = skinnedMesh('ghoul', GHOUL_LOOK);
  const idleClip = createIdleClip();
  const runClip = createRunClip();
  const attackClip = createAttackClip();

  const makeActor = (slot: number, attackSpeed: number): Actor => {
    const mixer = new AnimationMixer(skeleton);
    const graph = createAnimGraph(mixer, {
      params: { speed: 0, attack: false },
      states: {
        move: {
          blend: {
            param: 'speed',
            points: [
              { at: 0, clip: idleClip },
              { at: RUN_SPEED, clip: runClip },
            ],
          },
        },
        attack: { clip: attackClip, loop: false, speed: attackSpeed },
      },
      transitions: [
        { from: 'move', to: 'attack', when: (p) => p.attack === true, fade: 0.06 },
        { from: 'attack', to: 'move', when: () => true, fade: 0.16, exitTime: 0.96 },
      ],
      initial: 'move',
    });
    return {
      slot,
      mixer,
      graph,
      world: new Float32Array(NODE_COUNT * WORLD_NODE_FLOATS),
      joints: new Float32Array(NODE_COUNT * JOINT_FLOATS),
      t: new Transform({}),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      lastPhase: 0,
    };
  };
  const hero = makeActor(0, ATTACK_SPEED);
  hero.z = 6;
  const heroP: InstanceParams = {
    params: [0, 0, 0, 0],
    castShadow: true,
    receiveShadow: true,
  };
  // The cape: four bones behind the chest swinging on a spring chain, kept off the back.
  const back = new Float32Array([0, 1.25, 0.05]);
  const cape = createSpringChain(skeleton, {
    root: NODES.cape0,
    tip: NODES.cape3,
    stiffness: 40,
    damping: 4,
    gravity: [0, -9.8, 0],
    drag: 0.2,
    radius: 0.04,
    limitAngle: 1.3,
    collide: [{ center: back, radius: 0.24 }],
  });

  // Gear: every set's meshes are built once; a swap only changes which ones draw.
  const sets = createGearSets().map((g, i) => ({
    helmet: renderer.createMesh({ ...g.helmet, label: `${GEAR_NAMES[i]}-helmet` }),
    shoulder: renderer.createMesh({ ...g.shoulder, label: `${GEAR_NAMES[i]}-shoulder` }),
    weapon: renderer.createMesh({ ...g.weapon, label: `${GEAR_NAMES[i]}-weapon` }),
    reach: g.reach,
    armour: gearMats[i]![0],
    blade: gearMats[i]![1],
  }));
  let gear = 0;
  const headSocket = createSocket(skeleton, NODES.head, { position: [0, 0.16, 0] });
  const shoulderL = createSocket(skeleton, NODES.upperArmL, { position: [-0.03, 0.02, 0] });
  const shoulderR = createSocket(skeleton, NODES.upperArmR, { position: [0.03, 0.02, 0] });
  const handSocket = createSocket(skeleton, NODES.handR, { position: [0, -0.07, 0] });
  const helmT = new Transform({});
  const shLT = new Transform({});
  const shRT = new Transform({});
  const weaponT = new Transform({});
  const gearP: InstanceParams = { castShadow: true, receiveShadow: true };
  const gearUi = gearButtons(GEAR_NAMES, (i) => wear(i));
  const wear = (i: number) => {
    if (i !== gear) state.gearSwaps++;
    gear = i;
    const s = sets[i]!;
    state.gearSet = GEAR_NAMES[i]!;
    state.gearMaterialIds[0] = s.armour.label;
    state.gearMaterialIds[1] = s.armour.label;
    state.gearMaterialIds[2] = s.blade.label;
    gearUi.select(i);
  };
  ui.layout.add(gearUi.el, { place: { default: 'top' }, id: 'arpg-gear' });
  wear(0);
  state.gearSwaps = 0;

  const trail = new Trail(renderer, {
    space: 'world',
    maxPoints: 48,
    width: 0.22,
    color: [1, 0.78, 0.42, 0.9],
    lifetime: 0.24,
    minDistance: 0.03,
    facing: 'camera',
    blend: 'additive',
  });
  const tip = new Float32Array(3);

  // ── Enemies ─────────────────────────────────────────────────────────────
  // `?seed=N` fixes the enemy spawns (the engine's seeded random; `findRandomPoint` takes a thunk).
  const random = createRandom(SEED);
  const rng = () => random.next();
  const anchors = ui.anchors(() => camera);
  const numbers = new DamageNumbers(anchors, 16);
  const crowd = createCrowd({ maxAgents: ENEMY_COUNT + 1, maxNeighbors: 8, neighborDist: 3 });
  const heroAgent = crowd.add({ x: hero.x, z: hero.z, radius: 0.45, maxSpeed: RUN_SPEED });
  const enemyList = renderer.createInstanceList(ghoulMesh, ghoulMat, ENEMY_COUNT);
  const TINT: [number, number, number, number] = [1, 1, 1, 1];
  const FLASH: [number, number, number, number] = [2.4, 2.2, 2, 1];
  const barAt = new Float32Array(3);
  const enemies: Enemy[] = [];
  const spawnPt: NavPoint3 = { x: 0, y: 0, z: 0 };
  /** A seeded point `SPAWN_RING` m from the hero (clamped inside the walls), snapped to the mesh. */
  const spawnPoint = (ring: number): NavPoint3 => {
    for (let tries = 0; tries < 8; tries++) {
      const a = rng() * Math.PI * 2;
      const r = ring * (0.6 + 0.4 * rng());
      const x = Math.max(-HALF + 3, Math.min(HALF - 3, hero.x + Math.cos(a) * r));
      const z = Math.max(-HALF + 3, Math.min(HALF - 3, hero.z + Math.sin(a) * r));
      if (nav.findNearestPoly(x, 0, z, spawnPt, 3) >= 0 && Math.abs(spawnPt.y) < 0.05)
        return spawnPt;
    }
    nav.findRandomPoint(spawnPt, rng);
    return spawnPt;
  };
  for (let i = 0; i < ENEMY_COUNT; i++) {
    const a = makeActor(1 + i, 0.9);
    const p = spawnPoint(SPAWN_RING);
    a.x = p.x;
    a.y = p.y;
    a.z = p.z;
    a.yaw = rng() * Math.PI * 2;
    barAt[0] = a.x;
    barAt[1] = a.y + 2.15;
    barAt[2] = a.z;
    const e: Enemy = {
      ...a,
      alive: true,
      hp: ENEMY_HP,
      dead: -1,
      agent: crowd.add({ x: a.x, z: a.z, radius: 0.42, maxSpeed: ENEMY_SPEED }),
      path: createNavPath3(64),
      replan: (i / ENEMY_COUNT) * ENEMY_REPLAN,
      attackCd: rng(),
      held: false,
      flash: 0,
      params: { params: [0, 0, 0, 1 + i], tint: TINT, castShadow: true, receiveShadow: true },
      bar: healthBar(anchors, barAt),
      scale: 1,
    };
    enemies.push(e);
    e.t.setPosition(e.x, e.y, e.z);
    enemyList.set(i, e.t, e.params);
  }
  enemyList.castShadow = true;

  // ── HUD ─────────────────────────────────────────────────────────────────
  const healthOrb = orb('health', 'Health');
  const manaOrb = orb('mana', 'Mana');
  ui.layout.add(healthOrb.el, { place: { default: 'bottom' }, order: -1, id: 'arpg-health' });
  ui.layout.add(manaOrb.el, { place: { default: 'bottom' }, order: 1, id: 'arpg-mana' });
  const slots = ui.slots({
    count: ABILITIES.length,
    region: 'bottom',
    order: 0,
    hints: ABILITIES.map((a) => a.hint),
    label: 'Abilities',
    size: 72,
  });
  const abilityUi = ABILITIES.map((a, i) => {
    const ab = ability(a.name);
    slots.setContent(i, ab.content);
    return ab;
  });
  const cooldowns = new Float32Array(ABILITIES.length);

  // ── Pointer: click / tap / hold to move, click an enemy to attack ───────
  const touch = createTouchZones(input, {
    zones: {
      stick: {
        kind: 'stick',
        rect: (w, h) => ({ x: 0, y: h * 0.45, w: w * 0.38, h: h * 0.55 }),
        anchor: 'down',
        radius: 70,
        deadZone: 0.15,
      },
    },
  });
  const stick = touch.zones.stick;
  const pointer = { held: false, id: -1, cx: 0, cy: 0, pending: false, holdT: 0 };
  const canvas = surface.canvas;
  const inStick = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return false;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return x < r.width * 0.38 && y > r.height * 0.45;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || inStick(e)) return;
    pointer.held = true;
    pointer.id = e.pointerId;
    pointer.cx = e.clientX;
    pointer.cy = e.clientY;
    pointer.pending = true;
    pointer.holdT = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointer.held || e.pointerId !== pointer.id) return;
    pointer.cx = e.clientX;
    pointer.cy = e.clientY;
  });
  const release = (e: PointerEvent) => {
    if (e.pointerId === pointer.id) pointer.held = false;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  const ray = createRay();
  const logical = { x: 0, y: 0 };
  const groundPt: NavPoint3 = { x: 0, y: 0, z: 0 };
  const heroPt: NavPoint3 = { x: 0, y: 0, z: 0 };
  const path = createNavPath3(128);
  const vel3: NavPoint3 = { x: 0, y: 0, z: 0 };
  let pathing = false;
  let chase = -1;
  let chaseReplan = 0;

  /** Ray-sphere against each live enemy's torso; the nearest hit's index or -1. */
  const pickEnemy = (): number => {
    let best = -1;
    let bestT = Number.POSITIVE_INFINITY;
    const o = ray.origin;
    const d = ray.dir;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      if (!e.alive) continue;
      const cx = e.x - o[0];
      const cy = e.y + 1.0 - o[1];
      const cz = e.z - o[2];
      const t = cx * d[0] + cy * d[1] + cz * d[2];
      if (t <= 0) continue;
      const px = cx - d[0] * t;
      const py = cy - d[1] * t;
      const pz = cz - d[2] * t;
      if (px * px + py * py + pz * pz < 0.75 * 0.75 && t < bestT) {
        bestT = t;
        best = i;
      }
    }
    return best;
  };
  /** The ray onto the walkable surface: the y = 0 plane, refined by the navmesh height twice. */
  const pickGround = (): boolean => {
    const o = ray.origin;
    const d = ray.dir;
    if (d[1] > -1e-4) return false;
    let y = 0;
    let x = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const t = (y - o[1]) / d[1];
      x = o[0] + d[0] * t;
      z = o[2] + d[2] * t;
      const h = nav.height(x, z);
      y = Number.isNaN(h) ? 0 : h;
    }
    return nav.findNearestPoly(x, y, z, groundPt, 3) >= 0;
  };
  const planTo = (x: number, y: number, z: number): boolean => {
    heroPt.x = hero.x;
    heroPt.y = hero.y;
    heroPt.z = hero.z;
    groundPt.x = x;
    groundPt.y = y;
    groundPt.z = z;
    const ok = findMeshPath(nav, heroPt, groundPt, path, { snapRadius: 3 });
    pathing = ok && path.length > 1;
    return ok;
  };
  /** A click, tap or hold re-pick at the pointer. `click` lets an enemy under it start a chase. */
  const pick = (click: boolean) => {
    surface.clientToLogical(pointer.cx, pointer.cy, logical);
    if (!screenRay(camera, logical.x, logical.y, ray)) return;
    const hit = pickEnemy();
    if (hit >= 0) {
      if (click || chase >= 0) chase = hit;
      chaseReplan = 0;
      return;
    }
    if (!pickGround()) return;
    chase = -1;
    const gx = groundPt.x;
    const gy = groundPt.y;
    const gz = groundPt.z;
    if (planTo(gx, gy, gz)) {
      state.pathLength = pathDistance3(path);
      if (!state.moveTarget) state.moveTarget = [0, 0, 0];
      state.moveTarget[0] = gx;
      state.moveTarget[1] = gy;
      state.moveTarget[2] = gz;
    } else state.pathLength = 0;
  };

  // ── Combat ──────────────────────────────────────────────────────────────
  let mana = MANA_MAX;
  let health = HERO_MAX;
  /** Which ability the current attack state is (0 strike, 1 whirl). */
  let swingKind = 0;
  let queued = false;
  let dashT = 0;
  const dashDir = { x: 0, z: 0 };

  const nearestEnemy = (range: number): number => {
    let best = -1;
    let bestD = range;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      if (!e.alive) continue;
      const d = Math.hypot(e.x - hero.x, e.z - hero.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const startAttack = (kind: number): boolean => {
    if (hero.graph.state === 'attack') {
      if (kind === 0) queued = true;
      return false;
    }
    const lock = nearestEnemy(ATTACK_RANGE + 0.6);
    if (lock >= 0) {
      const e = enemies[lock]!;
      hero.yaw = Math.atan2(e.x - hero.x, -(e.z - hero.z));
    }
    swingKind = kind;
    pathing = false;
    hero.graph.set('attack', true);
    hero.lastPhase = 0;
    trail.clear();
    state.attacks++;
    return true;
  };
  const damage = (e: Enemy, n: number) => {
    if (!e.alive) return;
    e.hp -= n;
    e.flash = 0.12;
    state.hits++;
    sparkEmit.x = e.x;
    sparkEmit.y = e.y + 1.1;
    sparkEmit.z = e.z;
    fire.emit(sparkEmit, 18);
    numbers.spawn(String(n * 37 + ((state.hits * 7) % 11)), e.x, e.y + 2.0, e.z);
    e.bar.set(Math.max(0, e.hp) / ENEMY_HP);
    if (e.hp <= 0) {
      e.alive = false;
      e.dead = 0;
      e.held = false;
      state.kills++;
      deathEmit.x = e.x;
      deathEmit.y = e.y + 0.8;
      deathEmit.z = e.z;
      particles.emit(deathEmit, 40);
      if (chase === enemies.indexOf(e)) chase = -1;
    }
  };
  /** The blade lands: a strike hits enemies within reach in front, a whirl every one around. */
  const land = () => {
    const fx = Math.sin(hero.yaw);
    const fz = -Math.cos(hero.yaw);
    const reach = swingKind === 1 ? 3.2 : ATTACK_RANGE;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.x - hero.x;
      const dz = e.z - hero.z;
      const d = Math.hypot(dx, dz);
      if (d > reach) continue;
      if (swingKind === 0 && d > 0.3 && (dx * fx + dz * fz) / d < 0.2) continue;
      damage(e, 1);
    }
  };
  const tryAbility = (i: number) => {
    const a = ABILITIES[i]!;
    if (cooldowns[i]! > 0 || mana < a.mana) return;
    if (i === 0) {
      startAttack(0);
      return;
    }
    if (i === 1 && !startAttack(1)) return;
    if (i === 2) {
      dashT = 0.22;
      dashDir.x = Math.sin(hero.yaw);
      dashDir.z = -Math.cos(hero.yaw);
      pathing = false;
    }
    if (i === 3) {
      novaEmit.x = hero.x;
      novaEmit.y = hero.y + 0.6;
      novaEmit.z = hero.z;
      fire.emit(novaEmit, 120);
      for (const e of enemies) {
        if (e.alive && Math.hypot(e.x - hero.x, e.z - hero.z) < 6) damage(e, 1);
      }
    }
    mana -= a.mana;
    cooldowns[i] = a.cooldown;
  };

  // ── Simulation ──────────────────────────────────────────────────────────
  const snapPt: NavPoint3 = { x: 0, y: 0, z: 0 };
  /** Move an actor to `(x, z)` on the mesh (sliding to the nearest point off it). */
  const walkTo = (a: Actor, x: number, z: number) => {
    const p = nav.findPolyAt(x, a.y, z);
    if (p >= 0 && Math.abs(nav.polyHeight(p, x, z) - a.y) < 0.6) {
      a.x = x;
      a.z = z;
      a.y = nav.polyHeight(p, x, z);
    } else if (nav.findNearestPoly(x, a.y, z, snapPt, 1.5) >= 0 && Math.abs(snapPt.y - a.y) < 0.6) {
      a.x = snapPt.x;
      a.z = snapPt.z;
      a.y = snapPt.y;
    }
  };
  const turnToward = (a: Actor, wantYaw: number, rate: number, dt: number): number => {
    let d = wantYaw - a.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const step = rate * dt;
    a.yaw += Math.max(-step, Math.min(step, d));
    return d;
  };
  let heroSpeed = 0;
  const heading = { x: 0, z: 0 };
  const drive: [number, number] = [0, 0];
  const enemyPt: NavPoint3 = { x: 0, y: 0, z: 0 };
  const camEye = new Float32Array(3);
  const camAt = new Float32Array(3);
  const camGoal = new Float32Array(3);
  let camInit = false;

  const updateHero = (dt: number) => {
    // Direct movement (keys, pad, touch stick) overrides a click path.
    // Keys and the touch stick summed, through a radial deadzone, the length clamped to 1.
    shapeStick(input.axis('left', 'right') + stick.x, input.axis('up', 'down') + stick.y, drive, {
      deadzone: 0.15,
      shape: 'radial',
    });
    const mag = Math.hypot(drive[0], drive[1]);
    let want = 0;
    if (mag > 0) {
      heading.x = drive[0] / mag;
      heading.z = drive[1] / mag;
      want = RUN_SPEED * mag;
      pathing = false;
      chase = -1;
    } else if (chase >= 0) {
      const e = enemies[chase]!;
      const d = Math.hypot(e.x - hero.x, e.z - hero.z);
      if (!e.alive) chase = -1;
      else if (d < ATTACK_RANGE * 0.85) {
        pathing = false;
        startAttack(0);
        chase = -1;
      } else {
        chaseReplan -= dt;
        if (chaseReplan <= 0) {
          chaseReplan = 0.3;
          planTo(e.x, e.y, e.z);
        }
      }
    }
    if (want === 0 && pathing) {
      heroPt.x = hero.x;
      heroPt.y = hero.y;
      heroPt.z = hero.z;
      if (followPath3(path, heroPt, RUN_SPEED, ARRIVE, vel3) === 'arrived') pathing = false;
      else {
        const v = Math.hypot(vel3.x, vel3.z);
        if (v > 1e-4) {
          heading.x = vel3.x / v;
          heading.z = vel3.z / v;
          want = RUN_SPEED;
        }
      }
    }
    if (hero.graph.state === 'attack' || hero.graph.get('attack') === true) want = 0;
    let diff = 0;
    if (want > 0) diff = turnToward(hero, Math.atan2(heading.x, -heading.z), TURN_RATE, dt);
    const goal = want * Math.max(0.2, Math.cos(diff));
    heroSpeed += (goal - heroSpeed) * Math.min(1, ACCEL * dt);
    if (want === 0 && heroSpeed < 0.05) heroSpeed = 0;
    let mx = heading.x * heroSpeed * dt;
    let mz = heading.z * heroSpeed * dt;
    if (dashT > 0) {
      dashT -= dt;
      mx += dashDir.x * 26 * dt;
      mz += dashDir.z * 26 * dt;
    }
    if (mx !== 0 || mz !== 0) walkTo(hero, hero.x + mx, hero.z + mz);
    if (hero.graph.state === 'attack' && swingKind === 1) hero.yaw += 14 * dt;
  };

  const animateHero = (dt: number) => {
    const g = hero.graph;
    g.set('speed', heroSpeed);
    hero.t.setPosition(hero.x, hero.y, hero.z);
    hero.t.setAxisAngle(0, 1, 0, hero.yaw);
    const swinging = g.state === 'attack' || g.get('attack') === true;
    const steps = swinging ? SWING_SUBSTEPS : 1;
    const parked = STILL && !swinging && heroSpeed === 0;
    const sub = parked ? 0 : dt / steps;
    const s = sets[gear]!;
    for (let i = 0; i < steps; i++) {
      g.update(sub);
      if (g.state === 'attack') {
        g.set('attack', false);
        const ph = g.phase('attack');
        if (hero.lastPhase < HIT_PHASE && ph >= HIT_PHASE) land();
        hero.lastPhase = ph;
        poseToWorld(skeleton, hero.mixer.pose, hero.world);
        attachTransform(handSocket, hero.world, hero.t.world, weaponT);
        const m = weaponT.world;
        const y = -s.reach;
        tip[0] = m[1]! * y + m[3]!;
        tip[1] = m[5]! * y + m[7]!;
        tip[2] = m[9]! * y + m[11]!;
        trail.push(tip[0]!, tip[1]!, tip[2]!);
      }
    }
    if (g.state === 'move' && queued) {
      queued = false;
      startAttack(0);
    }
    poseToWorld(skeleton, hero.mixer.pose, hero.world);
    updateSpringChain(hero.mixer.pose, skeleton, hero.world, cape, hero.t.world, STILL ? 0 : dt);
    poseToWorld(skeleton, hero.mixer.pose, hero.world);
    skinMatrices(skeleton, hero.world, hero.joints);
    attachTransform(headSocket, hero.world, hero.t.world, helmT);
    attachTransform(shoulderL, hero.world, hero.t.world, shLT);
    attachTransform(shoulderR, hero.world, hero.t.world, shRT);
    attachTransform(handSocket, hero.world, hero.t.world, weaponT);
  };

  const updateEnemies = (dt: number) => {
    let alive = 0;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      if (!e.alive) {
        e.dead += dt;
        if (e.dead >= RESPAWN_AFTER) {
          const p = spawnPoint(SPAWN_RING);
          e.x = p.x;
          e.y = p.y;
          e.z = p.z;
          e.alive = true;
          e.hp = ENEMY_HP;
          e.dead = -1;
          e.scale = 1;
          e.bar.set(1);
          e.replan = 0;
          e.path.length = 0;
          crowd.setPosition(e.agent, e.x, e.z);
        } else {
          crowd.setPrefVelocity(e.agent, 0, 0);
          crowd.setPosition(e.agent, 500 + i * 4, 500);
          e.scale = Math.max(0, 1 - e.dead / SHRINK_TIME);
        }
        continue;
      }
      alive++;
      const dx = hero.x - e.x;
      const dz = hero.z - e.z;
      const d = Math.hypot(dx, dz);
      e.attackCd -= dt;
      if (STILL || e.held) {
        crowd.setPrefVelocity(e.agent, 0, 0);
      } else if (d < ENEMY_REACH) {
        crowd.setPrefVelocity(e.agent, 0, 0);
        turnToward(e, Math.atan2(dx, -dz), 8, dt);
        if (e.attackCd <= 0 && e.graph.state === 'move') {
          e.graph.set('attack', true);
          e.lastPhase = 0;
          e.attackCd = 1.6 + rng() * 0.8;
        }
      } else {
        e.replan -= dt;
        if (e.replan <= 0 || e.path.length === 0) {
          e.replan = ENEMY_REPLAN;
          enemyPt.x = e.x;
          enemyPt.y = e.y;
          enemyPt.z = e.z;
          heroPt.x = hero.x;
          heroPt.y = hero.y;
          heroPt.z = hero.z;
          findMeshPath(nav, enemyPt, heroPt, e.path, { snapRadius: 3 });
        }
        enemyPt.x = e.x;
        enemyPt.y = e.y;
        enemyPt.z = e.z;
        followPath3(e.path, enemyPt, ENEMY_SPEED, 0.4, vel3);
        crowd.setPrefVelocity(e.agent, vel3.x, vel3.z);
      }
    }
    state.enemiesAlive = alive;
    crowd.setPosition(heroAgent, hero.x, hero.z);
    crowd.setPrefVelocity(heroAgent, 0, 0);
    crowd.update(dt);
    for (const e of enemies) {
      if (e.alive && !e.held && !STILL) {
        const ag = crowd.agents[e.agent]!;
        const ox = e.x;
        const oz = e.z;
        walkTo(e, ag.x, ag.z);
        if (e.x !== ag.x || e.z !== ag.z) crowd.setPosition(e.agent, e.x, e.z);
        const vx = (e.x - ox) / dt;
        const vz = (e.z - oz) / dt;
        const sp = Math.hypot(vx, vz);
        if (sp > 0.3 && e.graph.state === 'move') turnToward(e, Math.atan2(vx, -vz), 7, dt);
        e.graph.set('speed', sp * (RUN_SPEED / ENEMY_SPEED) * 0.8);
      } else if (e.held) {
        crowd.setPosition(e.agent, e.x, e.z);
        e.graph.set('speed', 0);
      }
      // Animate: a parked or held ghoul only advances while it swings.
      const g = e.graph;
      const swinging = g.state === 'attack' || g.get('attack') === true;
      g.update(STILL && !swinging ? 0 : dt);
      if (g.state === 'attack') {
        g.set('attack', false);
        const ph = g.phase('attack');
        if (e.lastPhase < 0.5 && ph >= 0.5 && e.alive) {
          if (Math.hypot(hero.x - e.x, hero.z - e.z) < ENEMY_REACH + 0.5) {
            health -= ENEMY_DAMAGE;
            if (health <= 0) {
              health = HERO_MAX;
              ui.toasts.show('You fell, and rose again', { tone: 'warn', duration: 1500 });
            }
          }
        }
        e.lastPhase = ph;
      }
      poseToWorld(skeleton, e.mixer.pose, e.world);
      skinMatrices(skeleton, e.world, e.joints);
      if (e.flash > 0) e.flash -= dt;
      e.params.tint = e.flash > 0 ? FLASH : TINT;
      e.t.setPosition(e.x, e.y, e.z);
      e.t.setAxisAngle(0, 1, 0, e.yaw);
      const s = e.scale;
      e.t.setScale(s, s, s);
      barAt[0] = e.x;
      barAt[1] = e.y + 2.15;
      barAt[2] = e.z;
      e.bar.handle.set(barAt);
      e.bar.show(e.alive);
    }
  };

  hooks.update = (dt) => {
    state.simTime += dt;
    // Gear swaps: the skeleton, mixers and palette stay; only the drawn meshes change.
    if (input.pressed('gear1')) wear(0);
    if (input.pressed('gear2')) wear(1);
    if (input.pressed('gear3')) wear(2);
    if (input.pressed('attack')) tryAbility(0);
    if (input.pressed('whirl')) tryAbility(1);
    if (input.pressed('dash')) tryAbility(2);
    if (input.pressed('nova')) tryAbility(3);

    if (pointer.pending) {
      pointer.pending = false;
      pick(true);
    } else if (pointer.held) {
      pointer.holdT += dt;
      if (pointer.holdT >= HOLD_REPICK) {
        pointer.holdT = 0;
        pick(false);
      }
    }

    updateHero(dt);
    animateHero(dt);
    updateEnemies(dt);
    trail.update(dt, camera);
    numbers.update(dt);

    for (let i = 0; i < cooldowns.length; i++) {
      cooldowns[i] = Math.max(0, cooldowns[i]! - dt);
      const cd = ABILITIES[i]!.cooldown;
      let f = cd > 0 ? 1 - cooldowns[i]! / cd : 1;
      if (i === 0 && hero.graph.state === 'attack') f = hero.graph.phase('attack');
      if (mana < ABILITIES[i]!.mana) f = Math.min(f, 0.999);
      abilityUi[i]!.set(f);
    }
    mana = Math.min(MANA_MAX, mana + MANA_REGEN * dt);
    health = Math.min(HERO_MAX, health + 1.5 * dt);
    healthOrb.set(health, HERO_MAX);
    manaOrb.set(mana, MANA_MAX);

    // Braziers: flicker the light and the flame core, feed the flames.
    const t = state.simTime;
    for (let i = 0; i < fires.length; i++) {
      const f = fires[i]!;
      const k = STILL
        ? 1
        : 0.82 + 0.1 * Math.sin(t * 13 + f.phase) + 0.08 * Math.sin(t * 29 + f.phase * 2);
      f.color[0] = FIRE[0] * k;
      f.color[1] = FIRE[1] * k;
      f.color[2] = FIRE[2] * k;
      const b = yard.braziers[i]!;
      flameT.setPosition(b.x, b.y, b.z);
      flameT.setScale(0.9 + 0.2 * k, 1 + 0.5 * k, 0.9 + 0.2 * k);
      yard.flames.set(i, flameT, flameP);
    }
    if (!STILL) flameCarry += dt * 26;
    const n = Math.floor(flameCarry);
    if (n > 0) {
      flameCarry -= n;
      for (const b of yard.braziers) {
        flameEmit.x = b.x;
        flameEmit.y = b.y + 0.05;
        flameEmit.z = b.z;
        fire.emit(flameEmit, n);
      }
    }

    // Camera: pitched PITCH below the horizon, CAM_DIST back along +z, easing after the hero.
    camGoal[0] = hero.x;
    camGoal[1] = hero.y + 0.8;
    camGoal[2] = hero.z;
    const k = camInit ? Math.min(1, CAM_SMOOTH * dt) : 1;
    camInit = true;
    for (let i = 0; i < 3; i++) camAt[i] = camAt[i]! + (camGoal[i]! - camAt[i]!) * k;
    camEye[0] = camAt[0]!;
    camEye[1] = camAt[1]! + Math.sin(PITCH) * CAM_DIST;
    camEye[2] = camAt[2]! + Math.cos(PITCH) * CAM_DIST;
    camera.lookAt(camEye, camAt);

    state.heroPos[0] = hero.x;
    state.heroPos[1] = hero.y;
    state.heroPos[2] = hero.z;
    state.heroState = hero.graph.state;
    state.heroSpeed = heroSpeed;
    state.heroHealth = health;
    state.heroMana = mana;
    state.pathing = pathing;
  };
  const flameT = new Transform({});
  const flameP: InstanceParams = { castShadow: false };

  // ── Render ──────────────────────────────────────────────────────────────
  let staticTris = 0;
  for (const l of yard.lists) staticTris += (l.mesh.indexCount / 3) * l.count;
  staticTris += (yard.flames.mesh.indexCount / 3) * yard.flames.count;
  let triangles = 0;
  const scene: Scene<unknown, Frame, Camera> = {
    render(frame) {
      frame.clear(0.16, 0.1, 0.2);
      frame.lights = lights;
      palette.set(0, hero.joints);
      for (const e of enemies) palette.set(e.slot, e.joints);
      palette.flush();
      for (const l of yard.lists) frame.list(l);
      frame.list(yard.flames);
      for (let i = 0; i < enemies.length; i++) enemyList.set(i, enemies[i]!.t, enemies[i]!.params);
      frame.list(enemyList);
      frame.mesh(heroMesh, heroMat, hero.t, heroP);
      const s = sets[gear]!;
      frame.mesh(s.helmet, s.armour, helmT, gearP);
      frame.mesh(s.shoulder, s.armour, shLT, gearP);
      frame.mesh(s.shoulder, s.armour, shRT, gearP);
      frame.mesh(s.weapon, s.blade, weaponT, gearP);
      triangles =
        staticTris +
        (ghoulMesh.indexCount / 3) * ENEMY_COUNT +
        heroMesh.indexCount / 3 +
        (s.helmet.indexCount + s.shoulder.indexCount * 2 + s.weapon.indexCount) / 3;
      trail.draw(frame);
      frame.drawable(fire);
      frame.drawable(particles);
    },
  };
  ctx.stack.push(scene);

  // ── Test hooks ──────────────────────────────────────────────────────────
  const screenPt = { x: 0, y: 0, z: 0 };
  demoWindow.__arpgApi = {
    screenOf(x, y, z) {
      camera.worldToScreen(x, y, z, screenPt);
      const c = surface.logicalToClient(screenPt.x, screenPt.y);
      return { x: c.x, y: c.y };
    },
    summon() {
      const i = nearestEnemy(Number.POSITIVE_INFINITY);
      if (i < 0) return -1;
      const e = enemies[i]!;
      const fx = Math.sin(hero.yaw);
      const fz = -Math.cos(hero.yaw);
      e.x = hero.x + fx * 1.2;
      e.z = hero.z + fz * 1.2;
      e.y = hero.y;
      e.yaw = hero.yaw + Math.PI;
      e.held = true;
      crowd.setPosition(e.agent, e.x, e.z);
      return i;
    },
  };

  let fps = 0;
  hooks.afterRender = (time) => {
    state.frame++;
    const dt = time.frameDt;
    if (dt > 0 && dt < 1) {
      const inst = 1 / dt;
      fps = fps === 0 ? inst : fps + (inst - fps) * 0.08;
    }
    state.fps = fps;
    state.drawCalls = renderer.stats.drawCalls;
    state.triangles = triangles;
    state.gpuErrors = gpuDiagnostics.errorCount;
  };

  ui.toasts.show('Click / tap to move · Space strike · Q E R abilities · 1–3 gear', {
    tone: 'info',
    duration: 5000,
  });
  ctx.loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[arpg]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
