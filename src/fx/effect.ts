/**
 * Effects (ws/fx-3): a data-driven bundle of particle systems and emitters, played as
 * instances at a point or attached to a moving one. A descriptor is plain JSON (textures by
 * name), so an effect loads through the asset manifest as `{ kind: 'json', uri }` and is
 * validated with `validateEffectDesc` before `createEffect`.
 */
import type { Random } from '../core/random';
import type { Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import type { TextureLike } from '../render/texture';
import {
  type EmitParams,
  MAX_CURVE_STOPS,
  ParticleSystem,
  type ParticleSystemOptions,
} from './particles';
import { defaultFxRandom } from './random';

/** One emitter of an effect system: continuous at `rate`, a `burst` at `delay`, or both. */
export interface EffectEmitterDesc {
  params: EmitParams;
  /** Particles per second while active. Default 0. */
  rate?: number;
  /** Seconds after `delay` the emitter stays active. Default: until the effect ends. */
  duration?: number;
  /** Seconds after the instance starts before this emitter begins. Default 0. */
  delay?: number;
  /** Particles emitted once at `delay`. Default 0. */
  burst?: number;
}

/** A system's options in a descriptor: textures by name, no scene-target references. */
export type EffectSystemOptions = Omit<
  ParticleSystemOptions,
  'texture' | 'depthTarget' | 'random'
> & {
  /** A key of the `textures` map given to `createEffect`. */
  texture?: string;
};

export interface EffectSystemDesc {
  name: string;
  options?: EffectSystemOptions;
  emitters: EffectEmitterDesc[];
}

export interface EffectDesc {
  systems: EffectSystemDesc[];
  /** Seconds an instance lives. Default: when the last emitter ends (forever if none ends). */
  duration?: number;
  /** Restart each instance at `duration` instead of finishing it. Default false. */
  loop?: boolean;
}

/** Where an instance plays: a point, moved by `attach`. */
export interface EffectPoint {
  x: number;
  y: number;
  z?: number;
}

/** Fills `out` (xyz) with where an attached instance should be this frame. */
export type EffectFollow = (out: Float32Array) => void;

const NUMBER_FIELDS = ['rate', 'duration', 'delay', 'burst'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isColor(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    v.length <= 4 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function isPair(v: unknown): boolean {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number');
}

function validateParams(
  p: unknown,
  at: string,
  textures: string[] | null,
  out: string[],
  depth: number,
): void {
  if (!isRecord(p)) {
    out.push(`${at}: params must be an object`);
    return;
  }
  if (typeof p.x !== 'number' || typeof p.y !== 'number')
    out.push(`${at}: x and y must be numbers`);
  if (!isColor(p.colorStart)) out.push(`${at}: colorStart must be [r, g, b] or [r, g, b, a]`);
  if (p.colorEnd !== undefined && !isColor(p.colorEnd))
    out.push(`${at}: colorEnd must be a colour`);
  for (const k of ['speed', 'life', 'size', 'rotation', 'spin'] as const) {
    if (p[k] !== undefined && !isPair(p[k])) out.push(`${at}: ${k} must be [min, max]`);
  }
  if (p.sizeCurve !== undefined) {
    const c = p.sizeCurve;
    if (!Array.isArray(c) || c.length < 2 || c.length > MAX_CURVE_STOPS) {
      out.push(`${at}: sizeCurve needs 2..${MAX_CURVE_STOPS} stops`);
    } else if (!c.every((n) => typeof n === 'number'))
      out.push(`${at}: sizeCurve stops must be numbers`);
  }
  if (p.colorCurve !== undefined) {
    const c = p.colorCurve;
    if (!Array.isArray(c) || c.length < 2 || c.length > MAX_CURVE_STOPS) {
      out.push(`${at}: colorCurve needs 2..${MAX_CURVE_STOPS} stops`);
    } else if (!c.every(isColor)) out.push(`${at}: colorCurve stops must be colours`);
  }
  if (p.tile !== undefined && typeof p.tile !== 'number' && !isPair(p.tile)) {
    out.push(`${at}: tile must be a number or [from, to]`);
  }
  if (p.shape !== undefined) {
    const s = p.shape;
    if (!isRecord(s) || typeof s.kind !== 'string') out.push(`${at}: shape needs a kind`);
    else if (s.kind === 'mesh' && !Array.isArray(s.positions)) {
      out.push(`${at}: a mesh shape needs positions`);
    }
  }
  for (const k of ['onDeath', 'onLife'] as const) {
    const sub = p[k];
    if (sub === undefined) continue;
    if (!isRecord(sub)) {
      out.push(`${at}.${k}: must be { params, ${k === 'onDeath' ? 'count' : 'rate'} }`);
      continue;
    }
    const amount = k === 'onDeath' ? sub.count : sub.rate;
    if (typeof amount !== 'number' || amount < 0) {
      out.push(`${at}.${k}: ${k === 'onDeath' ? 'count' : 'rate'} must be a number ≥ 0`);
    }
    if (depth > 0) out.push(`${at}.${k}: sub-emitters go one level deep`);
    else validateParams(sub.params, `${at}.${k}`, textures, out, depth + 1);
  }
}

/**
 * Check a parsed effect JSON. Returns the problems found, each with its path (empty = valid).
 * With `textures` (names, or the map `createEffect` will get) unknown texture names are errors.
 */
export function validateEffectDesc(
  json: unknown,
  opts: { textures?: readonly string[] | Record<string, TextureLike> } = {},
): string[] {
  const out: string[] = [];
  const textures = opts.textures
    ? Array.isArray(opts.textures)
      ? (opts.textures as string[])
      : Object.keys(opts.textures)
    : null;
  if (!isRecord(json)) return ['effect: must be an object'];
  if (json.duration !== undefined && !(typeof json.duration === 'number' && json.duration > 0)) {
    out.push('effect: duration must be a number > 0');
  }
  if (json.loop !== undefined && typeof json.loop !== 'boolean')
    out.push('effect: loop must be a boolean');
  if (!Array.isArray(json.systems) || json.systems.length === 0) {
    out.push('effect: systems must be a non-empty array');
    return out;
  }
  const names = new Set<string>();
  json.systems.forEach((sys: unknown, i: number) => {
    const at = `systems[${i}]`;
    if (!isRecord(sys)) {
      out.push(`${at}: must be an object`);
      return;
    }
    if (typeof sys.name !== 'string' || sys.name === '') out.push(`${at}: name must be a string`);
    else if (names.has(sys.name)) out.push(`${at}: duplicate name "${sys.name}"`);
    else names.add(sys.name);
    if (sys.options !== undefined) {
      const o = sys.options;
      if (!isRecord(o)) out.push(`${at}.options: must be an object`);
      else {
        if (o.space !== undefined && o.space !== '2d' && o.space !== 'world') {
          out.push(`${at}.options: space must be '2d' or 'world'`);
        }
        if (o.blend !== undefined && o.blend !== 'additive' && o.blend !== 'alpha') {
          out.push(`${at}.options: blend must be 'additive' or 'alpha'`);
        }
        if (o.texture !== undefined) {
          if (typeof o.texture !== 'string') out.push(`${at}.options: texture must be a name`);
          else if (textures && !textures.includes(o.texture)) {
            out.push(`${at}.options: unknown texture "${o.texture}"`);
          }
        }
        if (o.atlas !== undefined) {
          const a = o.atlas;
          if (!isRecord(a) || typeof a.columns !== 'number' || typeof a.rows !== 'number') {
            out.push(`${at}.options: atlas must be { columns, rows }`);
          }
        }
        if (o.depthTarget !== undefined) out.push(`${at}.options: depthTarget is not serialisable`);
      }
    }
    if (!Array.isArray(sys.emitters) || sys.emitters.length === 0) {
      out.push(`${at}: emitters must be a non-empty array`);
      return;
    }
    sys.emitters.forEach((em: unknown, j: number) => {
      const ea = `${at}.emitters[${j}]`;
      if (!isRecord(em)) {
        out.push(`${ea}: must be an object`);
        return;
      }
      for (const k of NUMBER_FIELDS) {
        const v = em[k];
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
          out.push(`${ea}: ${k} must be a number ≥ 0`);
        }
      }
      if (!em.rate && !em.burst) out.push(`${ea}: needs a rate or a burst`);
      validateParams(em.params, ea, textures, out, 0);
    });
  });
  return out;
}

/** An emitter's per-instance state. */
interface EmitterState {
  /** This instance's copy of the params (position overwritten each frame). */
  params: EmitParams;
  carry: number;
  fired: boolean;
}

/** One playing of an effect: at a point, or following `attach`. */
export class EffectInstance {
  /** World (or logical) position, xyz. */
  readonly position = new Float32Array(3);
  /** Seconds since it started (wraps when the effect loops). */
  time = 0;
  /** Set once it has finished emitting (or `stop()` was called); the effect drops it then. */
  done = false;
  /** @internal */
  follow: EffectFollow | null = null;
  /** @internal per system, per emitter. */
  readonly states: EmitterState[][] = [];

  /** Keep the instance at wherever `getPosition` says each update. */
  attach(getPosition: EffectFollow): this {
    this.follow = getPosition;
    return this;
  }

  /** Stop emitting; the particles already born die on their own. */
  stop(): void {
    this.done = true;
  }
}

/**
 * A playable effect built from an `EffectDesc`: its systems are created once; each `play` or
 * `attach` adds an instance that drives the emitters. Call `update(dt)` once a frame, then
 * `draw(frame)` to queue every system.
 */
export class Effect {
  readonly systems: ParticleSystem[] = [];
  /** The instances now playing. */
  readonly instances: EffectInstance[] = [];
  /** Seconds an instance lives (Infinity: until stopped). */
  readonly duration: number;
  readonly loop: boolean;
  /**
   * The effect's stream (ws/fx-4): system `name` draws from `random.fork(name)`, so the same
   * seed plays the same particles whatever else the game draws.
   */
  readonly random: Random;
  private readonly desc: EffectDesc;
  private readonly pool: EffectInstance[] = [];

  constructor(
    renderer: Renderer,
    desc: EffectDesc,
    textures: Record<string, TextureLike> = {},
    random?: Random,
  ) {
    const problems = validateEffectDesc(desc, { textures });
    if (problems.length) throw new Error(`createEffect: ${problems.join('; ')}`);
    this.desc = desc;
    this.loop = desc.loop ?? false;
    this.random = random ?? defaultFxRandom('effect');
    let end = 0;
    for (const sys of desc.systems) {
      const { texture, ...rest } = sys.options ?? {};
      const options: ParticleSystemOptions = {
        ...rest,
        extended: true,
        random: this.random.fork(sys.name),
      };
      if (texture) options.texture = textures[texture];
      this.systems.push(new ParticleSystem(renderer, options));
      for (const em of sys.emitters) {
        const emEnd = em.duration === undefined ? Infinity : (em.delay ?? 0) + em.duration;
        if (emEnd > end) end = emEnd;
      }
    }
    this.duration = desc.duration ?? (end > 0 ? end : Infinity);
  }

  /** Start an instance at `at` (default the origin). */
  play(at?: EffectPoint): EffectInstance {
    const inst = this.pool.pop() ?? this.makeInstance();
    inst.time = 0;
    inst.done = false;
    inst.follow = null;
    inst.position[0] = at?.x ?? 0;
    inst.position[1] = at?.y ?? 0;
    inst.position[2] = at?.z ?? 0;
    for (const states of inst.states) {
      for (const s of states) {
        s.carry = 0;
        s.fired = false;
      }
    }
    this.instances.push(inst);
    return inst;
  }

  /** Start an instance that follows `getPosition`. */
  attach(getPosition: EffectFollow): EffectInstance {
    const inst = this.play();
    inst.follow = getPosition;
    getPosition(inst.position);
    return inst;
  }

  /** Stop every instance (particles already born die on their own). */
  stop(): void {
    for (const inst of this.instances) inst.done = true;
  }

  /** Drive the instances' emitters and the systems. Call once per frame. */
  update(dt: number): void {
    const instances = this.instances;
    for (let i = instances.length - 1; i >= 0; i--) {
      const inst = instances[i]!;
      if (inst.done) {
        instances[i] = instances[instances.length - 1]!;
        instances.pop();
        this.pool.push(inst);
        continue;
      }
      if (inst.follow) inst.follow(inst.position);
      const t0 = inst.time;
      inst.time += dt;
      this.emitFor(inst, t0, inst.time);
      if (inst.time >= this.duration) {
        if (this.loop) {
          inst.time -= this.duration;
          for (const states of inst.states) for (const s of states) s.fired = false;
        } else {
          inst.done = true;
        }
      }
    }
    for (const sys of this.systems) sys.update(dt);
  }

  private emitFor(inst: EffectInstance, t0: number, t1: number): void {
    const x = inst.position[0]!;
    const y = inst.position[1]!;
    const z = inst.position[2]!;
    const descs = this.desc.systems;
    for (let si = 0; si < descs.length; si++) {
      const sys = descs[si]!;
      const system = this.systems[si]!;
      const states = inst.states[si]!;
      for (let ei = 0; ei < sys.emitters.length; ei++) {
        const em = sys.emitters[ei]!;
        const st = states[ei]!;
        const delay = em.delay ?? 0;
        const end = em.duration === undefined ? Infinity : delay + em.duration;
        const p = st.params;
        p.x = x + (em.params.x ?? 0);
        p.y = y + (em.params.y ?? 0);
        p.z = z + (em.params.z ?? 0);
        if (!st.fired && t1 >= delay) {
          st.fired = true;
          if (em.burst) system.emit(p, em.burst);
        }
        if (em.rate && t1 > delay && t0 < end) {
          const active = Math.min(t1, end) - Math.max(t0, delay);
          st.carry += em.rate * active;
          const n = Math.floor(st.carry);
          if (n > 0) {
            st.carry -= n;
            system.emit(p, n);
          }
        }
      }
    }
  }

  /** Queue every system for drawing (`frame.drawable`). */
  draw(frame: Frame, order = 0): void {
    for (const sys of this.systems) frame.drawable(sys, order);
  }

  destroy(): void {
    for (const sys of this.systems) sys.destroy();
    this.instances.length = 0;
  }

  private makeInstance(): EffectInstance {
    const inst = new EffectInstance();
    for (const sys of this.desc.systems) {
      inst.states.push(
        sys.emitters.map((em) => ({ params: { ...em.params }, carry: 0, fired: false })),
      );
    }
    return inst;
  }
}

/** `createEffect` options. */
export interface CreateEffectOptions {
  /** Texture names the descriptor's systems refer to. */
  textures?: Record<string, TextureLike>;
  /**
   * The effect's random stream (ws/fx-4; each system forks it by name). Default: a fork of the
   * fx module default (`FX_DEFAULT_SEED`), named by creation order.
   */
  random?: Random;
}

/**
 * Build an `Effect` from a descriptor, resolving texture names through `textures`. Throws a
 * readable `Error` listing every problem `validateEffectDesc` finds.
 */
export function createEffect(
  renderer: Renderer,
  desc: EffectDesc,
  opts: CreateEffectOptions = {},
): Effect {
  return new Effect(renderer, desc, opts.textures ?? {}, opts.random);
}
