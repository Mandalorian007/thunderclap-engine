/**
 * Four roaming enemies: capsules that wander between random points on the heightfield, bump the
 * player for damage, take hits in the attack arc, shrink away when they die and come back after a
 * pause. Each carries a name plate and a health bar pinned to its head through `ui.anchors`. The
 * movement rule is pure (`stepEnemy`) so it can be tested; the DOM and GPU glue live in
 * `createEnemies`. Nothing is allocated per frame.
 */
import { capsule } from '@thunderclap/engine/geom';
import {
  createStandardMaterial,
  type Frame,
  type Material,
  type Mesh,
  type Renderer,
  Transform,
} from '@thunderclap/engine/render';
import { type AnchorHandle, type Anchors, h } from '@thunderclap/engine/ui';
import { type Ground, groundHeight, HALF, resolveXZ } from '../world/ground';

export const ENEMY_COUNT = 4;
export const ENEMY_RADIUS = 0.35;
export const ENEMY_HEIGHT = 1.1;
export const ENEMY_HEALTH = 3;
export const ENEMY_SPEED = 1.6;
/** Seconds between death and respawn. */
export const RESPAWN_DELAY = 2.5;
/** Seconds the death shrink takes. */
export const DEATH_TIME = 0.6;
/** Contact damage reach and cooldown. */
export const TOUCH_REACH = 0.95;
export const TOUCH_COOLDOWN = 1.2;

export const ENEMY_NAMES = ['Grum', 'Ashna', 'Pike', 'Vell'] as const;

export type EnemyState = 'alive' | 'dying' | 'dead';

export interface Enemy {
  readonly name: string;
  readonly position: Float32Array;
  readonly goal: Float32Array;
  health: number;
  state: EnemyState;
  /** Time in the current state, seconds. */
  timer: number;
  /** Seconds until the enemy may touch the player again. */
  touch: number;
  /** 1 alive, shrinking to 0 while dying. */
  scale: number;
}

export interface Enemies {
  readonly list: readonly Enemy[];
  /**
   * Walk, chase and touch. `onTouch` fires when a live enemy reaches the player (contact damage).
   * Returns nothing; read `list` for the state.
   */
  update(dt: number, player: Float32Array, onTouch: (e: Enemy) => void): void;
  render(frame: Frame): void;
  /** Damage one enemy; true when the blow killed it. */
  damage(e: Enemy, amount: number): boolean;
  /** The nearest live enemy's position, or null. */
  nearest(from: Float32Array): Enemy | null;
  remove(): void;
}

/** Deterministic enough for tests, free of `Math.random` so a seed can replace it later. */
export type Rng = () => number;

export function pickGoal(rng: Rng, out: Float32Array): void {
  const r = HALF - 3;
  out[0] = (rng() * 2 - 1) * r;
  out[1] = 0;
  out[2] = (rng() * 2 - 1) * r;
}

/** One movement step: head for the goal, or for the player when close; re-pick when arrived. */
export function stepEnemy(
  e: Enemy,
  dt: number,
  player: Float32Array,
  g: Ground,
  rng: Rng,
  out: Float32Array,
): void {
  if (e.state !== 'alive') return;
  const px = player[0]! - e.position[0]!;
  const pz = player[2]! - e.position[2]!;
  const toPlayer = Math.hypot(px, pz);
  let tx: number;
  let tz: number;
  if (toPlayer < 6) {
    tx = px;
    tz = pz;
  } else {
    tx = e.goal[0]! - e.position[0]!;
    tz = e.goal[2]! - e.position[2]!;
    if (Math.hypot(tx, tz) < 0.5) {
      pickGoal(rng, e.goal);
      return;
    }
  }
  const len = Math.hypot(tx, tz) || 1;
  const step = ENEMY_SPEED * dt;
  resolveXZ(
    g,
    e.position[0]! + (tx / len) * step,
    e.position[2]! + (tz / len) * step,
    ENEMY_RADIUS,
    out,
  );
  e.position[0] = out[0]!;
  e.position[2] = out[1]!;
  e.position[1] = groundHeight(g, out[0]!, out[1]!);
}

export function createEnemy(name: string, x: number, z: number, g: Ground, rng: Rng): Enemy {
  const e: Enemy = {
    name,
    position: new Float32Array([x, groundHeight(g, x, z), z]),
    goal: new Float32Array(3),
    health: ENEMY_HEALTH,
    state: 'alive',
    timer: 0,
    touch: 0,
    scale: 1,
  };
  pickGoal(rng, e.goal);
  return e;
}

const SPAWNS: readonly [number, number][] = [
  [-12, -12],
  [12, -11],
  [-11, 13],
  [13, 12],
];

export function createEnemies(
  renderer: Renderer,
  ground: Ground,
  anchors: Anchors,
  rng: Rng = Math.random,
): Enemies {
  const mesh: Mesh = renderer.createMesh({
    ...capsule({ radius: ENEMY_RADIUS, height: ENEMY_HEIGHT, color: [1, 1, 1, 1] }),
    label: 'enemy',
  });
  const material: Material = createStandardMaterial(renderer, {
    label: 'enemy',
    baseColorFactor: [0.62, 0.16, 0.14, 1],
    metallic: 0.1,
    roughness: 0.55,
  });
  const list: Enemy[] = SPAWNS.map(([x, z], i) => createEnemy(ENEMY_NAMES[i]!, x, z, ground, rng));
  const transforms = list.map(() => new Transform());
  const scratch = new Float32Array(2);
  const head = new Float32Array(3);

  // Name plate and health bar per enemy, pinned above the head.
  const plates = list.map((e) => {
    const bar = h('div', {
      style: {
        width: '100%',
        height: '5px',
        background: 'var(--tc-color-danger, #c33)',
        transformOrigin: 'left',
        borderRadius: '2px',
      },
    });
    const el = h(
      'div',
      {
        class: 'enemy-plate',
        style: {
          width: '64px',
          textAlign: 'center',
          fontFamily: 'var(--tc-font-display)',
          fontSize: 'var(--tc-font-size-s, 12px)',
          color: 'var(--tc-color-text)',
          textShadow: '0 1px 2px rgba(0, 0, 0, 0.7)',
          pointerEvents: 'none',
        },
      },
      h('div', null, e.name),
      h('div', { style: { background: 'rgba(0,0,0,0.45)', borderRadius: '2px' } }, bar),
    );
    const handle: AnchorHandle = anchors.add(
      el,
      [e.position[0]!, e.position[1]! + 1.6, e.position[2]!],
      {
        align: [0.5, 1],
        scale: 'distance',
        distance: 8,
        hideBehind: true,
      },
    );
    return { el, bar, handle, shownHealth: -1 };
  });

  const respawnAt = (e: Enemy, i: number) => {
    const [x, z] = SPAWNS[i]!;
    e.position[0] = x;
    e.position[2] = z;
    e.position[1] = groundHeight(ground, x, z);
    e.health = ENEMY_HEALTH;
    e.state = 'alive';
    e.timer = 0;
    e.scale = 1;
    pickGoal(rng, e.goal);
  };

  return {
    list,

    update(dt, player, onTouch) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        e.timer += dt;
        e.touch = Math.max(0, e.touch - dt);
        if (e.state === 'alive') {
          stepEnemy(e, dt, player, ground, rng, scratch);
          const dx = player[0]! - e.position[0]!;
          const dz = player[2]! - e.position[2]!;
          if (e.touch === 0 && dx * dx + dz * dz < TOUCH_REACH * TOUCH_REACH) {
            e.touch = TOUCH_COOLDOWN;
            onTouch(e);
          }
        } else if (e.state === 'dying') {
          e.scale = Math.max(0, 1 - e.timer / DEATH_TIME);
          if (e.timer >= DEATH_TIME) {
            e.state = 'dead';
            e.timer = 0;
          }
        } else if (e.timer >= RESPAWN_DELAY) {
          respawnAt(e, i);
        }

        const t = transforms[i]!;
        const s = e.scale;
        t.setPosition(
          e.position[0]!,
          e.position[1]! + (ENEMY_HEIGHT / 2 + ENEMY_RADIUS) * s,
          e.position[2]!,
        );
        t.setScale(s, s, s);

        const plate = plates[i]!;
        head[0] = e.position[0]!;
        head[1] = e.position[1]! + (ENEMY_HEIGHT + 2 * ENEMY_RADIUS) * s + 0.2;
        head[2] = e.position[2]!;
        plate.handle.set(head);
        const shown = e.state === 'alive' ? e.health : 0;
        if (shown !== plate.shownHealth) {
          plate.shownHealth = shown;
          plate.bar.style.transform = `scaleX(${shown / ENEMY_HEALTH})`;
          plate.el.style.opacity = e.state === 'alive' ? '1' : '0';
        }
      }
    },

    render(frame) {
      for (let i = 0; i < list.length; i++) {
        if (list[i]!.state === 'dead') continue;
        frame.mesh(mesh, material, transforms[i]!);
      }
    },

    damage(e, amount) {
      if (e.state !== 'alive') return false;
      e.health -= amount;
      if (e.health > 0) return false;
      e.health = 0;
      e.state = 'dying';
      e.timer = 0;
      return true;
    },

    nearest(from) {
      let best: Enemy | null = null;
      let bestD = Infinity;
      for (const e of list) {
        if (e.state !== 'alive') continue;
        const dx = e.position[0]! - from[0]!;
        const dz = e.position[2]! - from[2]!;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      return best;
    },

    remove() {
      for (const p of plates) p.handle.remove();
    },
  };
}
