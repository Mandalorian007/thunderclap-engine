/**
 * The arena scene: the one screen of this client.
 *
 * - `enter` turns `ctx.camera` into a perspective camera, builds the heightfield and stone
 *   meshes from `geom`, the character (generated glb, skinned mesh, graph, IK, sockets), the four
 *   enemies with their name plates, a world-space particle pool for hits, and the HUD.
 * - `update(dt)` runs once per rendered frame (`sim: false`): the controller walks in the camera
 *   frame (`Look.move` against `Follow.yaw`), the attack action starts the attack clip (root motion
 *   carries the lunge), the swing frame checks the arc, the head looks at the nearest enemy, the
 *   enemies roam and bump, the `Follow` orbits from `Look.look` and zooms from `Look.zoom`.
 * - `render(frame)` sets the lights (sun with a shadow map, fog), draws the ground, the stones,
 *   the character with its cosmetics, the enemies and the particles. Nothing is allocated per frame.
 */
import type { Scene } from '@thunderclap/engine/core';
import { type EmitParams, ParticleSystem } from '@thunderclap/engine/fx';
import {
  createHit,
  heightfieldGeometry,
  raycastReg,
  type StaticCollider,
} from '@thunderclap/engine/geom';
import {
  createStandardMaterial,
  type Frame,
  Lights,
  type Material,
  type Mesh,
  Transform,
} from '@thunderclap/engine/render';
import {
  ATTACK_HALF_ANGLE,
  ATTACK_REACH,
  type Character,
  createCharacter,
} from '../character/character';
import { angleDelta, type MoveInput, stepController } from '../character/controller';
import { COSMETICS } from '../character/cosmetics';
import type { GameCtx } from '../ctx';
import { createEnemies, type Enemies, type Enemy } from '../enemies/enemies';
import { createHud } from '../ui/hud';
import { createGround, type Ground } from '../world/ground';
import { createStoneCollider, loadStoneCollider, stoneGeometry } from '../world/stones';

const FOV = (60 * Math.PI) / 180;
const NEAR = 0.1;
const FAR = 140;
/** Sky and fog colour (linear RGB), the fog's range and the sun's shadow box. */
const SKY = [0.46, 0.56, 0.72] as const;
const FOG_NEAR = 20;
const FOG_FAR = 90;
const SHADOW_EXTENT = 24;
/** Enemy contact damage and the seconds the player is immune after it. */
const TOUCH_DAMAGE = 1;
const HURT_TIME = 1.0;

export function createArenaScene(ctx: GameCtx): Scene<GameCtx, Frame> {
  const { renderer, camera, follow, look, player } = ctx;
  const lights = new Lights();
  lights.ambient.set([0.24, 0.26, 0.32]);
  lights.sun.direction = [-0.45, -1.0, -0.3];
  lights.sun.color = [1.0, 0.94, 0.82];
  lights.sun.shadow = { extent: SHADOW_EXTENT, size: 2048 };
  lights.fog.color = SKY;
  lights.fog.density = 1;
  lights.fog.near = FOG_NEAR;
  lights.fog.far = FOG_FAR;

  let ground: Ground;
  let groundMesh: Mesh;
  let groundMat: Material;
  let stoneMesh: Mesh;
  let stoneMat: Material;
  let stones: StaticCollider;
  const sight = createHit();
  const identity = new Transform();
  let character: Character;
  let enemies: Enemies;
  let hits: ParticleSystem;
  const burst: EmitParams = {
    x: 0,
    y: 0,
    z: 0,
    shape: { kind: 'sphere', radius: 0.15 },
    speed: [1.5, 4],
    life: [0.25, 0.6],
    size: [0.06, 0.16],
    colorStart: [1.0, 0.75, 0.3, 1],
    colorEnd: [0.8, 0.1, 0.05, 0],
    gravity: [0, -6, 0],
    drag: 2,
    emissive: 1.5,
  };
  const move: MoveInput = { x: 0, y: 0, cameraYaw: 0, sprint: false };
  const feet = new Float32Array(3);
  let hurt = 0;
  let dead = false;

  const onTouch = (e: Enemy) => {
    if (hurt > 0 || dead) return;
    hurt = HURT_TIME;
    player.health = Math.max(0, player.health - TOUCH_DAMAGE);
    ctx.hud.setHealth(player.health, player.maxHealth);
    character.hit();
    burst.x = (e.position[0]! + character.controller.position[0]!) / 2;
    burst.y = character.controller.position[1]! + 1.0;
    burst.z = (e.position[2]! + character.controller.position[2]!) / 2;
    hits.emit(burst, 12);
    if (player.health === 0) {
      dead = true;
      ctx.ui.toasts.show('Down. R to respawn', { tone: 'warn', duration: 4000 });
    }
  };

  const respawn = () => {
    player.health = player.maxHealth;
    dead = false;
    hurt = 0;
    ctx.hud.setHealth(player.health, player.maxHealth);
    character.teleport(0, 4, ground);
    character.controller.yaw = 0;
    follow.yaw = 0;
    follow.snap();
  };

  const cycle = (slot: number) => {
    const name = character.cycle(slot);
    ctx.hud.setCosmetic(COSMETICS[slot]!.slot, name);
  };

  const swing = () => {
    const c = character.controller;
    let kills = 0;
    for (const e of enemies.list) {
      if (e.state !== 'alive') continue;
      const dx = e.position[0]! - c.position[0]!;
      const dz = e.position[2]! - c.position[2]!;
      const d = Math.hypot(dx, dz);
      if (d > ATTACK_REACH) continue;
      if (Math.abs(angleDelta(c.yaw, Math.atan2(dx, -dz))) > ATTACK_HALF_ANGLE) continue;
      // A stone between the two blocks the swing (the baked collider, or its runtime twin).
      const x = c.position[0]!;
      const y = c.position[1]! + 1;
      const z = c.position[2]!;
      if (raycastReg(stones, x, y, z, dx / d, 0, dz / d, d, sight)) continue;
      burst.x = e.position[0]!;
      burst.y = e.position[1]! + 1.0;
      burst.z = e.position[2]!;
      hits.emit(burst, 24);
      if (enemies.damage(e, 1)) kills++;
    }
    if (kills > 0) {
      player.kills += kills;
      ctx.hud.setKills(player.kills);
    }
  };

  return {
    name: 'arena',

    enter() {
      camera.setPerspective(FOV, ctx.design.width / ctx.design.height, NEAR, FAR);

      ground = createGround();
      groundMesh = renderer.createMesh({
        ...heightfieldGeometry(ground.field, { color: [0.36, 0.5, 0.27, 1] }),
        label: 'ground',
      });
      groundMat = createStandardMaterial(renderer, {
        label: 'ground',
        baseColorFactor: [1, 1, 1, 1],
        metallic: 0,
        roughness: 0.95,
      });
      stoneMesh = renderer.createMesh({ ...stoneGeometry(ground), label: 'stones' });
      // The runtime collider first, so the scene never waits; the baked one replaces it on arrival.
      stones = createStoneCollider(ground);
      loadStoneCollider(ground, 'baked/stones.coll').then((c) => {
        stones = c;
      });
      stoneMat = createStandardMaterial(renderer, {
        label: 'stones',
        baseColorFactor: [1, 1, 1, 1],
        metallic: 0.05,
        roughness: 0.8,
      });

      character = createCharacter(renderer, ground, 0, 4);
      enemies = createEnemies(
        renderer,
        ground,
        ctx.ui.anchors(() => camera),
      );
      hits = new ParticleSystem(renderer, {
        space: 'world',
        capacity: 512,
        blend: 'additive',
        fade: { near: 0.3, far: 1.2 },
        stretch: 0.6,
      });
      Object.assign(ctx, { hud: createHud(ctx, cycle) });

      follow.target = character.controller;
      follow.setLook(look);
      follow.snap();
    },

    exit() {
      ctx.hud.remove();
      enemies.remove();
      follow.target = null;
      follow.setLook(null);
    },

    update(dt) {
      const { input } = ctx;
      hurt = Math.max(0, hurt - dt);

      if (input.pressed('respawn')) respawn();
      if (input.pressed('cosmeticHead')) cycle(0);
      if (input.pressed('cosmeticBack')) cycle(1);
      if (input.pressed('cosmeticHand')) cycle(2);

      // Movement in the camera frame; an attack or a hit holds the feet.
      move.x = look.move.x;
      move.y = look.move.y;
      move.cameraYaw = follow.yaw;
      move.sprint = input.held('sprint');
      stepController(character.controller, move, dt, ground, character.locked || dead);
      if (!dead && input.pressed('attack')) character.attack();

      // The head follows the nearest live enemy within reach of the eye.
      const target = enemies.nearest(character.controller.position);
      if (target) {
        character.lookTarget[0] = target.position[0]!;
        character.lookTarget[1] = target.position[1]! + 1.2;
        character.lookTarget[2] = target.position[2]!;
        const dx = target.position[0]! - character.controller.position[0]!;
        const dz = target.position[2]! - character.controller.position[2]!;
        character.lookWeight = dx * dx + dz * dz < 81 ? 1 : 0;
      } else {
        character.lookWeight = 0;
      }

      character.update(dt, ground);
      if (character.swung) swing();

      feet.set(character.controller.position);
      enemies.update(dt, feet, onTouch);
      hits.update(dt);

      follow.update(dt);
    },

    render(frame) {
      frame.clear(SKY[0], SKY[1], SKY[2]);
      frame.lights = lights;
      frame.mesh(groundMesh, groundMat, identity, GROUND_PARAMS);
      frame.mesh(stoneMesh, stoneMat, identity);
      character.render(frame);
      enemies.render(frame);
      frame.drawable(hits, 1);
    },
  };
}

const GROUND_PARAMS = { castShadow: false };
