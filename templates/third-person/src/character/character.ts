/**
 * The character at runtime: the generated glb parsed into a skinned mesh, a skeleton and clips;
 * a mixer and the animation graph; root motion split off the attack; two foot IK chains; a head
 * look-at; three cosmetic sockets. `update(dt)` composes one pose and hands it to one
 * `skinPose` call, which writes the joint palette; `render(frame)` draws the body and the chosen
 * cosmetics. Nothing is allocated per frame.
 */
import {
  type AnimationClip,
  AnimationMixer,
  type AnimGraph,
  applyRootMotionDelta,
  attachTransform,
  createIkChain,
  createSocket,
  extractRootMotion,
  type IkChain,
  lookAt,
  POSE_NODE_FLOATS,
  type Pose,
  poseToWorld,
  type Skeleton,
  type Socket,
  skinPose,
  twoBoneIk,
  WORLD_NODE_FLOATS,
} from '@thunderclap/engine/anim';
import { interleaveSkinned, parseGltf, skeletonFromSkin } from '@thunderclap/engine/assets';
import {
  createStandardMaterial,
  type Frame,
  type InstanceParams,
  type Material,
  type Mesh,
  type Renderer,
  SkinPalette,
  Transform,
  VERTEX_LAYOUT_SKINNED,
} from '@thunderclap/engine/render';
import type { Ground } from '../world/ground';
import { groundHeight } from '../world/ground';
import { type Controller, createController, moveController, RUN_SPEED } from './controller';
import { COSMETICS, type CosmeticSlot, nextOption } from './cosmetics';
import { type Clips, createCharacterGraph } from './graph';
import { buildCharacterGlb, J, JOINT_COUNT, JOINT_NAMES } from './rig';

/** Normalised attack time at which the swing connects. */
export const ATTACK_HIT_PHASE = 0.45;
/** Reach and half-angle (radians) of the attack arc, from the feet. */
export const ATTACK_REACH = 1.9;
export const ATTACK_HALF_ANGLE = 1.05;
/** How far the feet may leave the animated height to meet the ground. */
const FOOT_REACH = 0.35;

interface CosmeticSet {
  readonly slot: CosmeticSlot;
  readonly socket: Socket;
  readonly transform: Transform;
  readonly meshes: readonly [Mesh, Mesh];
  readonly materials: readonly [Material, Material];
  current: number;
}

export interface Character {
  readonly controller: Controller;
  readonly graph: AnimGraph;
  readonly skeleton: Skeleton;
  /** The body transform (feet at the origin, facing by yaw). */
  readonly body: Transform;
  /** Joint world matrices (skeleton space) of the latest pose, 12 floats per node. */
  readonly world: Float32Array;
  readonly cosmetics: readonly CosmeticSet[];
  /** World point the head looks at while `lookWeight` > 0; the scene writes it. */
  readonly lookTarget: Float32Array;
  lookWeight: number;
  /** True while the attack or hit clip holds the character in place. */
  readonly locked: boolean;
  /** True on the one update where the attack swing connects. */
  readonly swung: boolean;
  /** Set `speed` and the one-shot flags, advance the graph, solve IK, write the palette. */
  update(dt: number, ground: Ground): void;
  render(frame: Frame): void;
  attack(): boolean;
  hit(): void;
  cycle(slot: number): string;
  teleport(x: number, z: number, ground: Ground): void;
}

/** Row-major 3×4: `out = m · [x, y, z, 1]`. */
function apply(m: Float32Array, x: number, y: number, z: number, out: Float32Array): void {
  out[0] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
  out[1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
  out[2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!;
}

export function createCharacter(
  renderer: Renderer,
  ground: Ground,
  x: number,
  z: number,
): Character {
  // ── The asset, generated and parsed like a file ───────────────────────
  const doc = parseGltf(buildCharacterGlb());
  const skeleton: Skeleton = skeletonFromSkin(doc, 0);
  skeleton.names = doc.nodes.map((n, i) => n.name ?? `node${i}`);
  const prim = doc.meshes[0]!.primitives[0]!;
  const skinned = interleaveSkinned(prim);
  const mesh = renderer.createMesh({
    label: 'character',
    layout: VERTEX_LAYOUT_SKINNED,
    vertices: new Float32Array(skinned.vertices),
    indices: prim.indices,
    bounds: { center: [0, 0.95, 0], radius: 2.2 },
  });
  const palette = new SkinPalette(renderer.device, { joints: JOINT_COUNT, label: 'character' });
  // The standard PBR material over the palette: vertex colours as albedo, a rough dielectric;
  // the palette slot rides in params.w.
  const material = createStandardMaterial(renderer, {
    label: 'character-skinned',
    skin: palette,
    metallic: 0,
    roughness: 0.7,
  });
  const bodyParams: InstanceParams = { params: [0, 0, 0, 0] };

  const byName = new Map<string, AnimationClip>(doc.animations.map((a) => [a.name, a]));
  const clip = (name: string): AnimationClip => {
    const c = byName.get(name);
    if (!c) throw new Error(`character glb has no clip '${name}'`);
    return c;
  };
  // The attack lunges forward in the clip; the root motion moves the controller instead.
  const attackSplit = extractRootMotion(clip('attack'), J.hips, { planar: true });
  const clips: Clips = {
    idle: clip('idle'),
    walk: clip('walk'),
    run: clip('run'),
    attack: attackSplit.clip,
    hit: clip('hit'),
  };

  // ── Animation ────────────────────────────────────────────────────────
  const mixer = new AnimationMixer(skeleton, { maxActions: 8 });
  const graph = createCharacterGraph(mixer, clips);
  const pose: Pose = mixer.pose;
  const world = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS);
  const legL: IkChain = createIkChain(skeleton, { root: J.thighL, mid: J.shinL, tip: J.footL });
  const legR: IkChain = createIkChain(skeleton, { root: J.thighR, mid: J.shinR, tip: J.footR });
  const motionDelta = new Float32Array(4);
  const footTarget = new Float32Array(3);
  const poleTarget = new Float32Array(3);
  const tmp = new Float32Array(3);
  let attackTime = 0;
  let swungThisAttack = false;

  // ── Body and cosmetics ───────────────────────────────────────────────
  const controller = createController(x, z, ground);
  const body = new Transform();
  const cosmetics: CosmeticSet[] = COSMETICS.map((slot) => {
    const materials = slot.options.map((o) =>
      createStandardMaterial(renderer, {
        label: `cosmetic-${o.name}`,
        baseColorFactor: o.color,
        metallic: o.metallic,
        roughness: o.roughness,
      }),
    ) as [Material, Material];
    const meshes = slot.options.map((o) =>
      renderer.createMesh({ ...o.build(), label: `cosmetic-${o.name}` }),
    ) as [Mesh, Mesh];
    return {
      slot,
      socket: createSocket(skeleton, JOINT_NAMES[slot.joint]!, slot.local),
      transform: new Transform(),
      meshes,
      materials,
      current: 0,
    };
  });

  const self = {
    controller,
    graph,
    skeleton,
    body,
    world,
    cosmetics,
    lookTarget: new Float32Array(3),
    lookWeight: 0,
    locked: false,
    swung: false,

    update(dt: number, g: Ground): void {
      const state = graph.state;
      self.locked = state === 'attack' || state === 'hit';
      self.swung = false;
      graph.set('speed', Math.min(1, controller.speed / RUN_SPEED));
      graph.update(dt);
      graph.set('attack', false);
      graph.set('hit', false);

      // Root motion: the hips' travel since the last update, turned into the world by the yaw.
      if (graph.state === 'attack') {
        const t = graph.actions('attack')[0]!.time;
        applyRootMotionDelta(attackSplit.motion, attackTime, t, motionDelta);
        const sy = Math.sin(controller.yaw);
        const cy = Math.cos(controller.yaw);
        const dx = motionDelta[0]!;
        const dz = motionDelta[2]!;
        moveController(controller, dx * cy - dz * sy, dx * sy + dz * cy, g);
        const phase = graph.phase('attack');
        if (!swungThisAttack && phase >= ATTACK_HIT_PHASE) {
          swungThisAttack = true;
          self.swung = true;
        }
        attackTime = t;
      }

      // The body: feet on the ground, turned by yaw (+Y rotation turns -Z towards -X).
      const p = controller.position;
      body.setPosition(p[0]!, p[1]!, p[2]!).setAxisAngle(0, 1, 0, -controller.yaw);
      const bodyWorld = body.world;

      // Foot IK: each foot keeps its animated height over the ground under it; the hips drop
      // so the lower foot can reach. Everything in world space through `bodyWorld`.
      poseToWorld(skeleton, pose, world);
      const footLo = J.footL * WORLD_NODE_FLOATS;
      const footRo = J.footR * WORLD_NODE_FLOATS;
      apply(bodyWorld, world[footLo + 3]!, world[footLo + 7]!, world[footLo + 11]!, tmp);
      const offL = clampFoot(groundHeight(g, tmp[0]!, tmp[2]!) - p[1]!);
      const animL = tmp[1]!;
      apply(bodyWorld, world[footRo + 3]!, world[footRo + 7]!, world[footRo + 11]!, tmp);
      const offR = clampFoot(groundHeight(g, tmp[0]!, tmp[2]!) - p[1]!);
      const animR = tmp[1]!;
      const drop = Math.min(0, offL, offR);
      pose[J.hips * POSE_NODE_FLOATS + 1] += drop;
      poseToWorld(skeleton, pose, world);
      solveFoot(legL, footLo, animL + offL);
      solveFoot(legR, footRo, animR + offR);

      // The head turns towards the look target, within its range.
      if (self.lookWeight > 0) {
        poseToWorld(skeleton, pose, world);
        lookAt(pose, skeleton, world, J.head, self.lookTarget, bodyWorld, {
          weight: self.lookWeight,
          forward: HEAD_FORWARD,
          up: UP,
          maxAngle: 1.1,
        });
      }

      // One call from the finished pose to the palette: world matrices into `world` (the
      // sockets read them next), joint matrices straight into slot 0.
      skinPose(skeleton, pose, palette, 0, undefined, world);
      for (const c of cosmetics) attachTransform(c.socket, world, bodyWorld, c.transform);
    },

    render(frame: Frame): void {
      palette.flush();
      frame.mesh(mesh, material, body, bodyParams);
      for (const c of cosmetics) {
        frame.mesh(c.meshes[c.current], c.materials[c.current], c.transform);
      }
    },

    attack(): boolean {
      if (self.locked) return false;
      graph.set('attack', true);
      attackTime = 0;
      swungThisAttack = false;
      return true;
    },

    hit(): void {
      graph.set('hit', true);
    },

    cycle(slot: number): string {
      const c = cosmetics[slot]!;
      c.current = nextOption(c.slot, c.current);
      return c.slot.options[c.current]!.name;
    },

    teleport(tx: number, tz: number, g: Ground): void {
      controller.position[0] = tx;
      controller.position[2] = tz;
      controller.velocity.fill(0);
      controller.speed = 0;
      moveController(controller, 0, 0, g);
    },
  };

  function solveFoot(chain: IkChain, footOffset: number, targetY: number): void {
    // The animated foot in the world, at the height the ground asks for.
    apply(
      body.world,
      world[footOffset + 3]!,
      world[footOffset + 7]!,
      world[footOffset + 11]!,
      footTarget,
    );
    footTarget[1] = targetY;
    // The knee bends forward: the pole sits a stride ahead of the foot at knee height.
    const sy = Math.sin(controller.yaw);
    const cy = Math.cos(controller.yaw);
    poleTarget[0] = footTarget[0]! + sy;
    poleTarget[1] = footTarget[1]! + 0.45;
    poleTarget[2] = footTarget[2]! - cy;
    twoBoneIk(pose, skeleton, world, chain, footTarget, poleTarget, body.world);
  }

  return self;
}

const HEAD_FORWARD = new Float32Array([0, 0, -1]);
const UP = new Float32Array([0, 1, 0]);

function clampFoot(off: number): number {
  return Math.min(FOOT_REACH, Math.max(-FOOT_REACH, off));
}
