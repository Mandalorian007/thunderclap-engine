/**
 * ARPG demo (ws/demo-arpg): a Diablo-Immortal-class isometric slice. A hero in a ruined
 * courtyard at dusk clicks (or taps, or holds, or sticks) to move over a baked navmesh, cuts
 * down ghouls that path in with crowd separation, and swaps between three gear sets on sockets.
 *
 * - Scene: `courtyard.ts`, prop kinds as `InstanceList`s of `geom` meshes on PBR stone (walls,
 *   pillars and drums as lists on `MeshLod` chains, ws/render-6),
 *   six braziers with emissive cores, additive flame particles and a flickering point light
 *   each, a low warm sun with a shadow map, bloom, AO, vignette and a saturated grade.
 * - Hero: the skinned rig on `createStandardMaterial({ skin })`, an anim graph (a 1D idle/run
 *   blend on `speed` plus an `attack` state), a cape on a spring chain, gear on head, shoulder
 *   and hand sockets. Ground picks through `screenRay` → navmesh height → `findMeshPath` →
 *   `followPath3`, steered with a turn rate; a held pointer re-picks every 0.2 s.
 * - Enemies: twelve ghouls on the same skeleton (one `InstanceList`, one `SkinPalette`), each
 *   with its own mixer and graph, replanning a `NavPath3` toward the hero and stepping through
 *   `createCrowd`, the live ones one `InstanceList` on a two-level `MeshLod`. Three hits kill; a death burns away on a
 *   pooled `dissolve` material (shadow included), bursts and respawns at the edge after 3 s.
 * - HUD: health and mana orbs (`ui.meter({ shape: 'orb', trail: true })`), a four-slot ability
 *   row with cooldown sweeps, gear buttons, anchored health bars, floating damage numbers
 *   (`ui.floats(camera)`, the third hit on a ghoul a crit) and a north-up minimap of the whole
 *   courtyard (`ui.minimap`) with ghouls (arrows on their `heading`) and braziers as marker
 *   kinds: a tap on it walks the hero there over the same navmesh path as a ground click.
 *   The orbs and slots size a content `bottom` bar, the gear row a content `top` bar (ws/ui-8).
 *   The orbs move to the phone-landscape side rails through `MeterOptions.place` maps and size
 *   per form factor through a `FormSize` (ws/ui-10, ws/ui-11): built once, never remade.
 * - Watch replay (P or the top button): the run so far, recorded by `input: { record: true }`,
 *   replays from a rewound boot state through `ctx.replay(rec, { onEnd })`; clicks reach the
 *   demo through a `PointerConsumer` on the input's dispatcher, so the replay re-picks them, and
 *   the gear buttons and minimap taps (overlay, not input) ride a side lane keyed by tick.
 *
 * `?still` parks the idle bob, the flame flicker and the enemy AI; `?seed=N` fixes the spawns;
 * `?blur` turns object motion blur on (camera motion only for now: see the README).
 */

import { createGame } from '@thunderclap-engine/engine';
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
} from '@thunderclap-engine/engine/anim';
import { createRandom, type Scene } from '@thunderclap-engine/engine/core';
import { type EmitParams, ParticleSystem, Trail } from '@thunderclap-engine/engine/fx';
import {
  createInputRecorder,
  createRay,
  createTouchZones,
  type InputRecording,
  type InputTick,
  type PointerConsumer,
  type PointerRecord,
  parseRecording,
  recordingLength,
  screenRay,
  shapeStick,
} from '@thunderclap-engine/engine/input';
import {
  bakeNavMesh,
  createCrowd,
  createNavPath3,
  findMeshPath,
  followPath3,
  type NavPath3,
  type NavPoint3,
  pathDistance3,
} from '@thunderclap-engine/engine/nav';
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
  type MeshLod,
  type PointLight,
  SkinPalette,
  STANDARD_DISSOLVE_OFFSET,
  Transform,
  VERTEX_LAYOUT_SKINNED,
} from '@thunderclap-engine/engine/render';
import type { Meter, MinimapMarker } from '@thunderclap-engine/engine/ui';
import { buildCourtyard, DAIS, HALF } from './courtyard';
import { createGearSets, GEAR_NAMES } from './gear';
import { runePixels, tilePixels, whitePixels } from './geom';
import {
  ability,
  gearButtons,
  type HealthBar,
  healthBar,
  injectCss,
  paintCourtyard,
  replayButton,
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
/** `?blur`: object motion blur on, so the ghoul list keeps per-instance velocity history. */
const BLUR = params.has('blur');

const state: ArpgDemoState = {
  ready: false,
  gpu: 'pending',
  frame: 0,
  fps: 0,
  simTime: 0,
  drawCalls: 0,
  triangles: 0,
  lodCounts: [],
  dissolving: 0,
  dissolvePeak: 0,
  cameraDistance: 24,
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
  crits: 0,
  mapMarkers: 0,
  mapPicks: 0,
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
  centreSeam: null,
  formFactor: '',
  overflows: [],
  bottomBar: 0,
  worldView: 1,
  worldArea: 1,
  orbRegions: ['bottom', 'bottom'],
  orbPx: 0,
  ghoulLevels: [],
  deathFlushes: 0,
  deathLodShifts: 0,
  ghoulVelocity: false,
  replaying: false,
  replays: 0,
  replayEnds: 0,
  takeTicks: 0,
  replayLength: 0,
  replayFrom: null,
  replayTo: null,
};
demoWindow.__demo = state;

// ── Tuning ────────────────────────────────────────────────────────────────
const FOV = (34 * Math.PI) / 180;
const PITCH = (50 * Math.PI) / 180;
const CAM_DIST = 24;
/** The wheel and `__arpgApi.zoom` clamp the camera distance to this range, metres. */
const CAM_DIST_MIN = 14;
const CAM_DIST_MAX = 64;
const CAM_SMOOTH = 6;
/** The content `bottom` bar's ceiling, CSS px: a 112-design-px orb plus pad fits on every row. */
const BAR_MAX = 160;
/** Phone-portrait's ceiling: 21% of a 568 px-tall view (iPhone SE), so the world keeps 70%. */
const BAR_MAX_PORTRAIT = 120;
/** The content `top` bar's ceiling, CSS px: the gear buttons plus pad. */
const TOP_MAX = 96;
/**
 * Phone-landscape's content side rails' ceiling, CSS px (ws/ui-9): the 100 px map plus pad
 * on the right, a 56 px orb plus pad on the left.
 */
const RAIL_MAX = 128;
/**
 * Where the health and mana orbs sit per form factor (`MeterOptions.place`, ws/ui-11):
 * phone-landscape's height is scarce, so they go to the side rails (the health orb at the foot
 * of the left one, the mana orb under the map on the right); elsewhere at the two ends of the
 * bottom bar.
 */
const HEALTH_PLACE = { 'phone-landscape': 'left', default: 'bottom' } as const;
const MANA_PLACE = { 'phone-landscape': 'right', default: 'bottom' } as const;
/**
 * The orbs' diameter, theme px (`MeterOptions.size` as a `FormSize`, ws/ui-10): 112 (75 CSS px
 * on desktop-1280, 56 on a phone). Phone-landscape's left rail holds the health orb alone, so
 * there it is 96 (48 CSS px), which lets that rail drop to the form's 56 px track.
 */
const ORB_SIZE = { 'phone-landscape': 96, default: 112 };
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
/** Seconds a death takes to burn away (`dissolve.amount` 0 → 1). */
const DISSOLVE_TIME = 0.8;
/** Dissolve materials shared by the dying (a whirl or nova rarely fells more at once). */
const DISSOLVE_POOL = 4;
/** On-screen sphere height (target px) at which a ghoul keeps its hands, feet and hair. */
const GHOUL_LOD_PX = [80];
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
  | 'gear3'
  | 'replay';

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
  /** The dissolve pool slot while burning away, else -1. */
  burn: number;
}

async function main(): Promise<void> {
  const root = document.getElementById('app') as HTMLElement;
  const ctx = await createGame<Action>({
    root,
    title: 'ThunderClap demo: arpg',
    design: { width: 1920, height: 1080 },
    // Content bars (ws/ui-8): the orbs and ability slots size the bottom bar, the gear buttons
    // the top one. Each grows from the form's fixed track to its tallest widget plus pad, up to
    // its max (phone-portrait's bottom bar: BAR_MAX_PORTRAIT, so the world keeps at least 70%
    // of the height), and the grid re-flows around them.
    layout: {
      bars: {
        top: { size: 'content', max: TOP_MAX },
        bottom: { size: 'content', max: BAR_MAX },
      },
      forms: {
        'phone-portrait': { bars: { bottom: { size: 'content', max: BAR_MAX_PORTRAIT } } },
        // ws/ui-9: the map and orbs widen content rails; the corner rule gives each corner
        // to the side that needs the larger track, so the rails run the full height.
        'phone-landscape': {
          bars: {
            left: { size: 'content', max: RAIL_MAX },
            right: { size: 'content', max: RAIL_MAX },
          },
        },
      },
    },
    // No `aux: { velocity: true }` yet, so `?blur` reads camera motion only: with a velocity
    // attachment the particle pipelines (built on `renderer.sceneFormats`, two targets) fail
    // validation against the three-target scene pass. See the README's known limits.
    post: {
      bloom: { enabled: true, intensity: 0.85, threshold: 1.0, knee: 0.5, scatter: 0.72 },
      mist: { enabled: false, density: 0 },
      motionBlur: { enabled: BLUR, mode: 'object', intensity: 0.6 },
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
      // Every tick the input is fed, from boot (`ctx.input.recorder`): "watch replay" plays it.
      record: true,
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
        replay: [{ key: 'KeyP' }],
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
  const ghoulDesc = {
    skin: palette,
    baseColorFactor: [0.5, 0.82, 0.48, 1] as [number, number, number, number],
    roughness: 0.92,
  };
  const ghoulMat = createStandardMaterial(renderer, { label: 'ghoul-skin', ...ghoulDesc });
  // Deaths burn away: a small pool of the ghoul material with a dissolve (its shadow pass
  // discards the same texels), each animated by one float at STANDARD_DISSOLVE_OFFSET.
  const burns = Array.from({ length: DISSOLVE_POOL }, (_, i) => ({
    mat: createStandardMaterial(renderer, {
      label: `ghoul-dissolve-${i}`,
      ...ghoulDesc,
      dissolve: { amount: 0, edgeColor: [3.2, 1.2, 0.3], edgeWidth: 0.08, noise: 5 },
    }),
    amount: new Float32Array(1),
    busy: false,
  }));
  const setBurn = (slot: number, amount: number) => {
    const b = burns[slot]!;
    b.amount[0] = amount;
    b.mat.setUniforms(b.amount, STANDARD_DISSOLVE_OFFSET * 4);
  };

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
  lights.sun.direction = [0.55, -0.62, 0.55];
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
  const ghoulLod: MeshLod = {
    meshes: [
      ghoulMesh,
      renderer.createMesh({
        ...createBodyMesh(skeleton, GHOUL_LOOK, true),
        layout: VERTEX_LAYOUT_SKINNED,
        label: 'ghoul-lod1',
      }),
    ],
    thresholdsPx: GHOUL_LOD_PX,
  };
  /**
   * The live ghouls as one LOD `InstanceList` (ws/render-6), refilled each frame and keyed by
   * ghoul index (ws/render-7), so LOD memory and velocity history follow the ghoul, not the
   * slot. Previous matrices are kept only while the post stack blurs motion.
   */
  const ghoulVelocity = ctx.post.settings.motionBlur.enabled;
  const ghouls = renderer.createInstanceList(ghoulLod, ghoulMat, ENEMY_COUNT, {
    velocity: ghoulVelocity,
  });
  state.ghoulVelocity = ghoulVelocity;
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
  /**
   * A gear button's pick, taken on the next update (like a key) so the take's side lane can log
   * it on its tick: an overlay click is not something the input records. Ignored mid-replay.
   */
  let gearPick = -1;
  const gearUi = gearButtons(GEAR_NAMES, (i) => {
    if (!state.replaying) gearPick = i;
  });
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
  const floats = ui.floats(() => camera, { max: 24 });
  const floatAt = new Float32Array(3);
  const crowd = createCrowd({ maxAgents: ENEMY_COUNT + 1, maxNeighbors: 8, neighborDist: 3 });
  const heroAgent = crowd.add({ x: hero.x, z: hero.z, radius: 0.45, maxSpeed: RUN_SPEED });
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
      burn: -1,
    };
    enemies.push(e);
    e.t.setPosition(e.x, e.y, e.z);
  }

  // ── HUD ─────────────────────────────────────────────────────────────────
  // Each orb's region and diameter are per-form-factor maps (ws/ui-11 `place`, ws/ui-10
  // `size`): the layout moves and resizes the live meters in the re-layout that changes the
  // form factor, so the value, tone and damage trail carry over and nothing is rebuilt.
  const makeOrb = (health: boolean): Meter => {
    const orb = ui.meter({
      shape: 'orb',
      trail: true,
      label: health ? 'Health' : 'Mana',
      max: health ? HERO_MAX : MANA_MAX,
      tone: health ? 'danger' : 'info',
      size: ORB_SIZE,
      place: health ? HEALTH_PLACE : MANA_PLACE,
      // Bottom bar: the health orb before the slots, the mana orb after. Right rail: under the map.
      order: health ? -1 : 1,
    });
    orb.el.id = health ? 'arpg-health' : 'arpg-mana';
    return orb;
  };
  const healthOrb = makeOrb(true);
  const manaOrb = makeOrb(false);
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
  const inStick = (p: PointerRecord) => {
    if (p.device !== 'touch') return false;
    const r = canvas.getBoundingClientRect();
    const x = p.clientX - r.left;
    const y = p.clientY - r.top;
    return x < r.width * 0.38 && y > r.height * 0.45;
  };
  // A consumer on the input's pointer dispatcher rather than canvas listeners, so the
  // recording's pointer lane reaches it too and a replayed click picks what the live one did.
  // The dispatcher is rebuilt on every attach (a replay detaches the input, then reattaches it).
  const release = (p: PointerRecord) => {
    if (p.id === pointer.id) pointer.held = false;
  };
  const clicks: PointerConsumer = {
    pointerDown(p) {
      if (p.button !== 0 || inStick(p)) return;
      pointer.held = true;
      pointer.id = p.id;
      pointer.cx = p.clientX;
      pointer.cy = p.clientY;
      pointer.pending = true;
      pointer.holdT = 0;
    },
    pointerMove(p) {
      if (!pointer.held || p.id !== pointer.id) return;
      pointer.cx = p.clientX;
      pointer.cy = p.clientY;
    },
    pointerUp: release,
    pointerCancel: release,
    cancelAll() {
      pointer.held = false;
    },
  };
  /** After the engine's own consumers (feed 0 .. screen 40), seeing only unclaimed pointers. */
  const CLICK_PRIORITY = 50;
  input.dispatcher?.add(clicks, CLICK_PRIORITY);
  input.on('attach', (d) => d.add(clicks, CLICK_PRIORITY));

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
    walkHeroTo(groundPt.x, groundPt.y, groundPt.z);
  };
  /** Path the hero to a snapped ground point (a ground click or a minimap tap). */
  const walkHeroTo = (gx: number, gy: number, gz: number) => {
    chase = -1;
    if (planTo(gx, gy, gz)) {
      state.pathLength = pathDistance3(path);
      if (!state.moveTarget) state.moveTarget = [0, 0, 0];
      state.moveTarget[0] = gx;
      state.moveTarget[1] = gy;
      state.moveTarget[2] = gz;
    } else state.pathLength = 0;
  };

  // ── Minimap: the whole courtyard north-up; a tap walks the hero there ──
  const mapPick = { pending: false, x: 0, z: 0 };
  const map = ui.minimap({
    size: 200,
    world: { minX: -HALF, minZ: -HALF, maxX: HALF, maxZ: HALF },
    center: 'world',
    shape: 'round',
    background: paintCourtyard(document, HALF, DAIS, yard.braziers),
    kinds: {
      // ws/ui-7: an arrow turned to each ghoul's facing (`heading`, as the hero's yaw).
      ghoul: { shape: 'arrow', color: 'var(--tc-color-danger)', size: 12 },
      brazier: { shape: 'diamond', color: '#ffb14a', size: 9 },
    },
    // Phone-landscape: the content right rail widens to hold it (ws/ui-9). Phone-portrait's
    // rails would take the width the world needs, so there it keeps the card lane under it.
    place: { default: 'right', 'phone-portrait': 'cardLane' },
    label: 'Courtyard map',
    // Taken on the next update, like a ground click (and logged on the take's side lane).
    onPick: (x, z) => {
      if (state.replaying) return;
      mapPick.pending = true;
      mapPick.x = x;
      mapPick.z = z;
    },
  });
  map.el.id = 'arpg-map';
  // In a content rail the map holds its own size and the rail grows to it (ws/ui-11).
  // The orbs at the bar's two ends, the ability slots between them (as `ui5?orb`).
  ui.layout.region('bottom').style.justifyContent = 'space-between';
  // Phone-landscape's rails: the map at the top of the right one and the mana orb at its foot,
  // the health orb at the foot of the left one. (On the wide forms the right rail holds the
  // map alone, where `space-between` is the default start.)
  ui.layout.region('right').style.justifyContent = 'space-between';
  ui.layout.region('left').style.justifyContent = 'flex-end';
  /** Publish the form factor, overflow ids and the bars' share after every re-layout. */
  const publishLayout = () => {
    const l = ui.layout;
    state.formFactor = l.formFactor;
    state.overflows = l.overflows().map((o) => o.id);
    const top = l.state.regions.top?.height ?? 0;
    state.bottomBar = l.state.regions.bottom?.height ?? 0;
    const h = l.state.height;
    state.worldView = h > 0 ? 1 - (top + state.bottomBar) / h : 1;
    const fill = l.state.regions.fill;
    state.worldArea = fill && h > 0 ? (fill.width * fill.height) / (l.state.width * h) : 1;
    // Where the layout put the live orbs (`meter.region`, ws/ui-11) and their diameters.
    state.orbRegions[0] = healthOrb.region;
    state.orbRegions[1] = manaOrb.region;
    state.orbPx = healthOrb.el.getBoundingClientRect().width;
  };
  ui.layout.onChange(publishLayout);
  ui.layout.refresh();
  const ghoulMarkers: MinimapMarker[] = enemies.map((_, i) => ({
    id: `ghoul-${i}`,
    x: 0,
    z: 0,
    kind: 'ghoul',
  }));
  const brazierMarkers: MinimapMarker[] = yard.braziers.map((b, i) => ({
    id: `brazier-${i}`,
    x: b.x,
    z: b.z,
    kind: 'brazier',
  }));
  /** The live markers: braziers then the live ghouls, rebuilt in place each update. */
  const mapMarkers: MinimapMarker[] = [];
  const updateMap = () => {
    mapMarkers.length = 0;
    for (const m of brazierMarkers) mapMarkers.push(m);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      if (!e.alive) continue;
      const m = ghoulMarkers[i]!;
      m.x = e.x;
      m.z = e.z;
      m.heading = e.yaw;
      mapMarkers.push(m);
    }
    map.setMarkers(mapMarkers);
    map.setPlayer(hero.x, hero.z, hero.yaw);
    state.mapMarkers = map.markers;
  };
  /** A pending minimap tap: snap it to the navmesh and walk there. */
  const takeMapPick = () => {
    if (!mapPick.pending) return;
    mapPick.pending = false;
    const h = nav.height(mapPick.x, mapPick.z);
    if (nav.findNearestPoly(mapPick.x, Number.isNaN(h) ? 0 : h, mapPick.z, groundPt, 3) < 0) return;
    state.mapPicks++;
    walkHeroTo(groundPt.x, groundPt.y, groundPt.z);
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
    floatAt[0] = e.x;
    floatAt[1] = e.y + 2.0;
    floatAt[2] = e.z;
    // The third blow on a ghoul (the killing one) lands as a crit.
    const crit = ENEMY_HP - e.hp === 3;
    floats.spawn(String(n * 37 + ((state.hits * 7) % 11) + (crit ? 60 : 0)), floatAt, {
      crit,
      color: crit ? '#ffe27a' : '#ffd35a',
    });
    if (crit) state.crits++;
    e.bar.set(Math.max(0, e.hp) / ENEMY_HP);
    if (e.hp <= 0) {
      e.alive = false;
      e.dead = 0;
      e.held = false;
      e.graph.set('speed', 0);
      // Burn away on a free pool material; with none free the body just drops out.
      e.burn = burns.findIndex((b) => !b.busy);
      if (e.burn >= 0) {
        burns[e.burn]!.busy = true;
        setBurn(e.burn, 0);
      }
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
  let camDist = CAM_DIST;
  // The wheel pulls the camera back (the far LOD levels show) or in: read per tick from the
  // input (`pointer.wheelY`, which a replay feeds), the listener only keeps the page still.
  canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  const zoomByWheel = () => {
    const wy = input.pointer.wheelY;
    if (wy !== 0)
      camDist = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, camDist * Math.exp(wy * 0.001)));
  };

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
          e.bar.set(1);
          e.replan = 0;
          e.path.length = 0;
          crowd.setPosition(e.agent, e.x, e.z);
        } else {
          crowd.setPrefVelocity(e.agent, 0, 0);
          crowd.setPosition(e.agent, 500 + i * 4, 500);
          if (e.burn >= 0) {
            if (e.dead >= DISSOLVE_TIME) {
              burns[e.burn]!.busy = false;
              e.burn = -1;
            } else setBurn(e.burn, e.dead / DISSOLVE_TIME);
          }
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
    let burning = 0;
    for (const e of enemies) if (e.burn >= 0) burning++;
    state.dissolving = burning;
    if (burning > state.dissolvePeak) state.dissolvePeak = burning;
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
      barAt[0] = e.x;
      barAt[1] = e.y + 2.15;
      barAt[2] = e.z;
      e.bar.handle.set(barAt);
      e.bar.show(e.alive);
    }
  };

  // ── Watch replay: the run since boot, played back through `ctx.replay` ──
  // The sim is a function of its fixed steps and their input, so a replay rewinds to the boot
  // snapshot and feeds the recording back: the run plays again tick for tick and ends where the
  // player stood. The input records from boot (`input: { record: true }`); overlay clicks (gear
  // buttons, minimap taps) are not input, so they go on a side lane logged by tick. A replay
  // ends in a fresh take whose ticks are appended to the history, so the next one is from boot too.
  type SideEvent = { t: number; gear?: number; map?: [number, number] };
  const history: InputRecording = { version: 3, ticks: [] };
  const side: SideEvent[] = [];
  /** Ticks in the history plus the current take (the next live tick's index). */
  let histTicks = 0;
  /** Where the current take starts in the history. */
  let takeStart = 0;
  /** The replay's tick (it counts as the recorder does) and its next side-lane event. */
  let replayTick = 0;
  let sideAt = 0;
  let replayWanted = false;
  const boot = {
    rng: random.state,
    hero: { x: hero.x, y: hero.y, z: hero.z, yaw: hero.yaw },
    enemies: enemies.map((e) => ({
      x: e.x,
      y: e.y,
      z: e.z,
      yaw: e.yaw,
      replan: e.replan,
      attackCd: e.attackCd,
    })),
  };
  const resetActor = (a: Actor, x: number, y: number, z: number, yaw: number) => {
    a.x = x;
    a.y = y;
    a.z = z;
    a.yaw = yaw;
    a.lastPhase = 0;
    a.graph.set('speed', 0);
    a.graph.set('attack', false);
    a.graph.go('move', 0);
  };
  /** Back to the boot snapshot: everything the fixed step reads (not counters or effects). */
  const rewind = () => {
    random.state = boot.rng;
    const h0 = boot.hero;
    resetActor(hero, h0.x, h0.y, h0.z, h0.yaw);
    heroSpeed = 0;
    heading.x = 0;
    heading.z = 0;
    dashT = 0;
    queued = false;
    swingKind = 0;
    chase = -1;
    chaseReplan = 0;
    pathing = false;
    path.length = 0;
    health = HERO_MAX;
    mana = MANA_MAX;
    cooldowns.fill(0);
    wear(0);
    for (const b of burns) b.busy = false;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      const s = boot.enemies[i]!;
      resetActor(e, s.x, s.y, s.z, s.yaw);
      e.alive = true;
      e.hp = ENEMY_HP;
      e.dead = -1;
      e.burn = -1;
      e.flash = 0;
      e.held = false;
      e.path.length = 0;
      e.replan = s.replan;
      e.attackCd = s.attackCd;
      e.bar.set(1);
    }
    for (const ag of crowd.agents) {
      ag.vx = 0;
      ag.vz = 0;
      ag.prefX = 0;
      ag.prefZ = 0;
    }
    crowd.setPosition(heroAgent, hero.x, hero.z);
    for (const e of enemies) crowd.setPosition(e.agent, e.x, e.z);
    pointer.held = false;
    pointer.pending = false;
    pointer.holdT = 0;
    mapPick.pending = false;
    gearPick = -1;
    camInit = false;
    camDist = CAM_DIST;
    trail.clear();
  };
  /**
   * Append a stopped take to the history: its ticks shifted to the take's start (pointer times
   * by the same span of game time), less its last tick, the one "watch replay" was pressed on
   * (that step ran no sim, so the replay must not either).
   */
  const appendTake = (take: InputRecording) => {
    const ticks = take.ticks;
    const last = ticks[ticks.length - 1];
    if (last && 'n' in last && last.n > 1) last.n--;
    else ticks.pop();
    const tickMs = take.tickMs ?? history.tickMs ?? 1000 / 60;
    history.tickMs ??= tickMs;
    const ms = takeStart * tickMs;
    for (const t of ticks) {
      const out: InputTick = { ...t, t: t.t + takeStart };
      if ('ptr' in out && out.ptr) {
        out.ptr = out.ptr.map((p) => {
          const q = [...p] as typeof p;
          if (q[7] !== undefined) q[7] += ms;
          return q;
        });
      }
      history.ticks.push(out);
    }
  };
  const watchReplay = () => {
    const take = input.recorder?.stop();
    if (take) appendTake(take);
    // Validated as any saved recording would be; it covers every live tick since boot.
    const rec = parseRecording(history);
    state.replayLength = recordingLength(rec);
    state.replaying = true;
    state.replays++;
    state.replayFrom = [hero.x, hero.y, hero.z];
    replayUi.playing(true);
    replayTick = 0;
    sideAt = 0;
    rewind();
    ctx.replay(rec, {
      onEnd: () => {
        state.replaying = false;
        state.replayEnds++;
        state.replayTo = [hero.x, hero.y, hero.z];
        replayUi.playing(false);
        // A fresh take from this step, appended to the history at the next "watch replay".
        takeStart = histTicks;
        createInputRecorder(input);
        ui.toasts.show('Replay over: back to you', { tone: 'info', duration: 1500 });
      },
    });
    ui.toasts.show('Watching the replay from the start', { tone: 'info', duration: 1500 });
  };
  const replayUi = replayButton(() => {
    replayWanted = true;
  });
  ui.layout.add(replayUi.el, { place: { default: 'top' }, id: 'arpg-replay', order: 1 });

  hooks.update = (dt) => {
    // "Watch replay" (P or the button): this step runs no sim; the replay starts on the next.
    if ((input.pressed('replay') || replayWanted) && !state.replaying) {
      replayWanted = false;
      watchReplay();
      return;
    }
    replayWanted = false;
    if (state.replaying) {
      // The side lane: the overlay clicks of the run, on the ticks they were taken.
      const tick = replayTick++;
      for (; sideAt < side.length && side[sideAt]!.t === tick; sideAt++) {
        const ev = side[sideAt]!;
        if (ev.gear !== undefined) gearPick = ev.gear;
        if (ev.map) {
          mapPick.pending = true;
          mapPick.x = ev.map[0];
          mapPick.z = ev.map[1];
        }
      }
    } else {
      const tick = histTicks++;
      state.takeTicks = histTicks;
      if (gearPick >= 0) side.push({ t: tick, gear: gearPick });
      if (mapPick.pending) side.push({ t: tick, map: [mapPick.x, mapPick.z] });
    }
    state.simTime += dt;
    // Gear swaps: the skeleton, mixers and palette stay; only the drawn meshes change.
    if (input.pressed('gear1')) wear(0);
    if (input.pressed('gear2')) wear(1);
    if (input.pressed('gear3')) wear(2);
    if (gearPick >= 0) {
      wear(gearPick);
      gearPick = -1;
    }
    zoomByWheel();
    if (input.pressed('attack')) tryAbility(0);
    if (input.pressed('whirl')) tryAbility(1);
    if (input.pressed('dash')) tryAbility(2);
    if (input.pressed('nova')) tryAbility(3);

    takeMapPick();
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
    floats.update(dt);

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
    // Whole points only: the orbs write nothing while the rounded value holds.
    healthOrb.set(Math.round(health));
    manaOrb.set(Math.round(mana));
    updateMap();

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

    // Camera: pitched PITCH below the horizon, camDist back along +z, easing after the hero.
    camGoal[0] = hero.x;
    camGoal[1] = hero.y + 0.8;
    camGoal[2] = hero.z;
    const k = camInit ? Math.min(1, CAM_SMOOTH * dt) : 1;
    camInit = true;
    for (let i = 0; i < 3; i++) camAt[i] = camAt[i]! + (camGoal[i]! - camAt[i]!) * k;
    camEye[0] = camAt[0]!;
    camEye[1] = camAt[1]! + Math.sin(PITCH) * camDist;
    camEye[2] = camAt[2]! + Math.cos(PITCH) * camDist;
    state.cameraDistance = camDist;
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
  const scene: Scene<unknown, Frame, Camera> = {
    render(frame) {
      frame.clear(0.16, 0.1, 0.2);
      frame.lights = lights;
      palette.set(0, hero.joints);
      for (const e of enemies) palette.set(e.slot, e.joints);
      palette.flush();
      for (const l of yard.lists) frame.list(l);
      frame.list(yard.flames);
      for (const l of yard.lods) frame.list(l);
      // Live ghouls: one LOD list, refilled in place and keyed by ghoul index, so a death
      // (the later ghouls each move up a slot) keeps every other ghoul's LOD level and motion
      // history. A burning one is alone on its pooled dissolve material.
      ghouls.clear();
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i]!;
        if (e.alive) {
          const slot = ghouls.count;
          ghouls.set(slot, e.t, e.params);
          ghouls.setKey(slot, i);
        } else if (e.burn >= 0) frame.mesh(ghoulLod, burns[e.burn]!.mat, e.t, e.params);
      }
      frame.list(ghouls);
      frame.mesh(heroMesh, heroMat, hero.t, heroP);
      const s = sets[gear]!;
      frame.mesh(s.helmet, s.armour, helmT, gearP);
      frame.mesh(s.shoulder, s.armour, shLT, gearP);
      frame.mesh(s.shoulder, s.armour, shRT, gearP);
      frame.mesh(s.weapon, s.blade, weaponT, gearP);
      trail.draw(frame);
      frame.drawable(fire);
      frame.drawable(particles);
    },
  };
  ctx.stack.push(scene);

  // ── Test hooks ──────────────────────────────────────────────────────────
  const screenPt = { x: 0, y: 0, z: 0 };
  const mapPt = { x: 0, y: 0 };
  demoWindow.__arpgApi = {
    mapPointOf(x, z) {
      map.toMap(x, z, mapPt);
      const r = map.canvas.getBoundingClientRect();
      return {
        x: r.left + (mapPt.x / map.size) * r.width,
        y: r.top + (mapPt.y / map.size) * r.height,
      };
    },
    screenOf(x, y, z) {
      camera.worldToScreen(x, y, z, screenPt);
      const c = surface.logicalToClient(screenPt.x, screenPt.y);
      return { x: c.x, y: c.y };
    },
    zoom(distance) {
      camDist = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, distance));
      return camDist;
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

  /**
   * `?still`: once, on frame SEAM_FRAME, read columns c-4..c+4 of the canvas (c its centre, 640
   * on desktop-1280) back in the frame's own task and publish column c's mean brightness less
   * the mean of columns c-4 and c+4 (`centreSeam`). Setup-time scratch: one 9-px-wide canvas.
   */
  const SEAM_FRAME = 60;
  const measureSeam = () => {
    const w = canvas.width;
    const h = canvas.height;
    const c = Math.round(w / 2);
    if (w < 16 || h < 1) return;
    const probe = document.createElement('canvas');
    probe.width = 9;
    probe.height = h;
    const g = probe.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.drawImage(canvas, c - 4, 0, 9, h, 0, 0, 9, h);
    const px = g.getImageData(0, 0, 9, h).data;
    const col = (x: number) => {
      let sum = 0;
      for (let y = 0; y < h; y++) {
        const o = (y * 9 + x) * 4;
        sum += (px[o]! + px[o + 1]! + px[o + 2]!) / 3;
      }
      return sum / h;
    };
    state.centreSeam = col(4) - (col(0) + col(8)) / 2;
  };

  /**
   * Each ghoul's LOD level as drawn this frame (`renderer.lodLevelOf` by slot, mapped to the
   * ghoul through the slot's key). On a flush with fewer slots than the last, count the ghouls
   * drawn both frames whose level changed. Setup-time arrays: nothing allocates per frame.
   */
  const levelsNow = new Int8Array(ENEMY_COUNT).fill(-1);
  const levelsLast = new Int8Array(ENEMY_COUNT).fill(-1);
  state.ghoulLevels = Array.from(levelsNow);
  let slotsLast = 0;
  const readGhoulLevels = () => {
    levelsNow.fill(-1);
    for (let s = 0; s < ghouls.count; s++) {
      const k = ghouls.keyOf(s);
      if (k !== null) levelsNow[k] = renderer.lodLevelOf(ghouls, s);
    }
    if (ghouls.count < slotsLast) {
      state.deathFlushes++;
      for (let i = 0; i < ENEMY_COUNT; i++) {
        if (levelsNow[i]! >= 0 && levelsLast[i]! >= 0 && levelsNow[i] !== levelsLast[i])
          state.deathLodShifts++;
      }
    }
    slotsLast = ghouls.count;
    for (let i = 0; i < ENEMY_COUNT; i++) {
      levelsLast[i] = levelsNow[i]!;
      state.ghoulLevels[i] = levelsNow[i]!;
    }
  };

  let fps = 0;
  hooks.afterRender = (time) => {
    state.frame++;
    if (STILL && state.frame === SEAM_FRAME) measureSeam();
    const dt = time.frameDt;
    if (dt > 0 && dt < 1) {
      const inst = 1 / dt;
      fps = fps === 0 ? inst : fps + (inst - fps) * 0.08;
    }
    state.fps = fps;
    state.drawCalls = renderer.stats.drawCalls;
    state.triangles = renderer.stats.triangles;
    const lc = renderer.stats.lodCounts;
    state.lodCounts.length = lc.length;
    for (let i = 0; i < lc.length; i++) state.lodCounts[i] = lc[i]!;
    state.gpuErrors = gpuDiagnostics.errorCount;
    readGhoulLevels();
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
