/**
 * The actor record: one slot's row in the slot table, `u32` words. The engine's header comes
 * first (`ACTOR_RECORD`), then the game's fields (`ActorRecordLayout`) in declaration order; the
 * stride is rounded up to four words.
 *
 * Position moves on its own: the pose pass places an actor at `position + velocity × (time −
 * since)`, so an actor walking a straight line costs no write until it turns.
 */

/** Word offsets of the engine's header in a record. */
export const ACTOR_RECORD = {
  /** Position at `since`, f32 × 3. */
  x: 0,
  y: 1,
  z: 2,
  /** Turn about +y, radians. */
  yaw: 3,
  /** Velocity, units per second, f32 × 3. */
  vx: 4,
  vy: 5,
  vz: 6,
  /** The time `position` holds at (the system's clock). */
  since: 7,
  /** Uniform scale. */
  scale: 8,
  /** Model id (`ActorSystem.addModel`), `ACTOR_NONE` for an empty slot. */
  model: 9,
  /** First clip layer: clip index, start time, rate. */
  clip: 10,
  clipStart: 11,
  clipRate: 12,
  /** Second clip layer, mixed over the first by `blend`. */
  clip2: 13,
  clip2Start: 14,
  clip2Rate: 15,
  blend: 16,
  /** RGBA8 tint for tinted vertices. */
  tint: 17,
  /** RGBA8 light the default lighting multiplies by (white without `sampleLight`). */
  light: 18,
  /** Reserved. */
  flags: 19,
} as const;

/** Header words before the game's fields. */
export const ACTOR_HEADER_WORDS = 20;
/** An empty model or clip. */
export const ACTOR_NONE = 0xffffffff;

/** A game field's type: one word. */
export type ActorFieldType = 'f32' | 'u32' | 'i32';
/** The game's own record fields, by name, in order after the header. */
export type ActorRecordLayout = Readonly<Record<string, ActorFieldType>>;

/** What `setRecord` writes. Every field is optional; what is left out keeps its value. */
export interface ActorRecordInput {
  /** Position at `since` (default now: the last `prepare`'s time). */
  position?: ArrayLike<number>;
  velocity?: ArrayLike<number>;
  /** When `position` held; default the system's current time when a position is given. */
  since?: number;
  yaw?: number;
  scale?: number;
  /** A model id from `addModel`, or -1 to hide the slot. */
  model?: number;
  /** Clip index in the model's rig (`rig.clip(name)`), -1 for the rest pose. */
  clip?: number;
  /** The time the clip's frame 0 played (default the system's current time when `clip` changes). */
  clipStart?: number;
  /** Playback rate (default 1). */
  clipRate?: number;
  clip2?: number;
  clip2Start?: number;
  clip2Rate?: number;
  /** Weight of the second clip over the first, 0..1. */
  blend?: number;
  /** RGBA8 (`0xAABBGGRR`), applied to tinted vertices. */
  tint?: number;
  /** The game's fields by name. */
  fields?: Readonly<Record<string, number>>;
}

/** Field name → word offset, and the stride in words. */
export interface ActorRecordShape {
  readonly stride: number;
  readonly fields: ReadonlyMap<string, { word: number; type: ActorFieldType }>;
}

/** The record shape of a layout. Throws on a bad name or type. */
export function recordShape(layout: ActorRecordLayout = {}): ActorRecordShape {
  const fields = new Map<string, { word: number; type: ActorFieldType }>();
  let word = ACTOR_HEADER_WORDS;
  for (const [name, type] of Object.entries(layout)) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`actor field '${name}' is not a name`);
    if (type !== 'f32' && type !== 'u32' && type !== 'i32') {
      throw new Error(`actor field '${name}': type ${String(type)}`);
    }
    fields.set(name, { word: word++, type });
  }
  return { stride: (word + 3) & ~3, fields };
}
