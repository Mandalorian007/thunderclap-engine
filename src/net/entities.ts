/**
 * The entity stream: many things' state, sent as only what changed since the frame before. A game
 * names a struct in its schema as the view of one thing (`Ghost { x: i32, y: i32, color: u8 }`);
 * each field is sent only when its encoding changed.
 *
 * A frame (the bytes of `ServerMsg::EntityStream`):
 *
 * - `u8` flags: bit 0 is a key frame (drop what is held first, then every thing comes whole).
 * - `u64` tick, then a count, then that many entries.
 * - An entry is the thing's `u64` id and a varint of bits: bit 0 gone (nothing follows), bit 1 new
 *   (every field follows), else bit `2 + i` says field `i` follows. Fields follow in order, each in
 *   its schema encoding.
 *
 * Decoding is strict: anything that doesn't fit throws `EntityStreamError`, after which what is held
 * is no longer what the server thinks. The session then asks for a key frame
 * (`ClientMsg::EntityResync`) and skips frames until one comes.
 */

import type { Codec, NetSchema } from './schema';
import { DecodeError, Reader, Writer } from './wire';

/** Frame flag: a key frame. */
const KEY = 1;
const GONE = 1;
const NEW = 2;
/** The most fields a view may have (the field bits fit a 31-bit varint). */
export const MAX_VIEW_FIELDS = 29;

/** A frame that doesn't decode. */
export class EntityStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityStreamError';
  }
}

/** What one frame changed. Reused between frames: copy what you keep. */
export interface EntityChanges {
  /** The frame's tick. */
  tick: number;
  /** Whether it was a key frame. */
  key: boolean;
  /** Things that came or changed. */
  readonly changed: number[];
  /** Things that went (or, on a key frame, weren't in it). */
  readonly gone: number[];
}

interface ViewField {
  readonly prop: string;
  readonly codec: Codec;
}

function viewFields(schema: NetSchema, view: string): ViewField[] {
  const fields = schema.fields(view);
  if (fields.length > MAX_VIEW_FIELDS) {
    throw new EntityStreamError(`${view} has ${fields.length} fields; at most ${MAX_VIEW_FIELDS}`);
  }
  return fields.map((f) => ({ prop: f.prop, codec: schema.codec(f.ty) }));
}

/** Holds every thing the stream has sent, as the game's view struct `V`. */
export class EntityStream<V extends object = Record<string, unknown>> {
  readonly #fields: ViewField[];
  readonly #held = new Map<number, V>();
  readonly #changes: EntityChanges = { tick: 0, key: false, changed: [], gone: [] };
  #tick = 0;
  #waiting = false;

  /** `view` names a struct in `schema`. */
  constructor(schema: NetSchema, view: string) {
    this.#fields = viewFields(schema, view);
  }

  /** What is held, by id. */
  get entities(): ReadonlyMap<number, V> {
    return this.#held;
  }

  /** The last frame's tick. */
  get tick(): number {
    return this.#tick;
  }

  /** Whether it is waiting for a key frame after an error (frames until then are skipped). */
  get waiting(): boolean {
    return this.#waiting;
  }

  /** One thing's view, if held. */
  get(id: number): V | undefined {
    return this.#held.get(id);
  }

  /**
   * Applies one frame. Returns what changed, or null when skipped while waiting for a key frame.
   * Throws `EntityStreamError` on a frame that doesn't fit; it then waits for a key frame.
   */
  apply(bytes: Uint8Array): EntityChanges | null {
    try {
      return this.#apply(bytes);
    } catch (e) {
      this.#waiting = true;
      if (e instanceof EntityStreamError) throw e;
      if (e instanceof DecodeError) throw new EntityStreamError(e.message);
      throw e;
    }
  }

  /** Forgets everything (a new connection). */
  clear(): void {
    this.#held.clear();
    this.#waiting = false;
    this.#tick = 0;
  }

  #apply(bytes: Uint8Array): EntityChanges | null {
    const r = new Reader(bytes);
    const flags = r.u8();
    if (flags & ~KEY) throw new EntityStreamError(`unknown frame flags ${flags}`);
    const key = (flags & KEY) !== 0;
    if (this.#waiting && !key) return null;
    const out = this.#changes;
    out.changed.length = 0;
    out.gone.length = 0;
    out.key = key;
    out.tick = r.u64();
    const n = r.count();
    const fields = this.#fields;
    const all = (1 << (2 + fields.length)) - 1;
    const seen = key ? new Set<number>() : null;
    for (let e = 0; e < n; e++) {
      const id = r.u64();
      const bits = r.u32();
      if (bits & ~all) throw new EntityStreamError(`entity ${id}: unknown bits ${bits}`);
      if (bits & GONE) {
        if (bits !== GONE) throw new EntityStreamError(`entity ${id}: gone with fields`);
        if (key) throw new EntityStreamError(`entity ${id}: gone in a key frame`);
        if (!this.#held.delete(id)) throw new EntityStreamError(`entity ${id}: gone but not held`);
        out.gone.push(id);
        continue;
      }
      let view: Record<string, unknown>;
      if (bits & NEW) {
        if (bits !== NEW) throw new EntityStreamError(`entity ${id}: new with field bits`);
        view = {};
        for (const f of fields) view[f.prop] = f.codec.decode(r);
      } else {
        if (key) throw new EntityStreamError(`entity ${id}: not whole in a key frame`);
        const held = this.#held.get(id);
        if (!held) throw new EntityStreamError(`entity ${id}: changed but not held`);
        view = { ...(held as Record<string, unknown>) };
        for (let i = 0; i < fields.length; i++) {
          if (bits & (4 << i)) view[fields[i]!.prop] = fields[i]!.codec.decode(r);
        }
      }
      if (seen) seen.add(id);
      this.#held.set(id, view as V);
      out.changed.push(id);
    }
    r.finish();
    if (seen) {
      for (const id of this.#held.keys()) {
        if (!seen.has(id)) {
          this.#held.delete(id);
          out.gone.push(id);
        }
      }
      this.#waiting = false;
    }
    this.#tick = out.tick;
    return out;
  }
}

/**
 * Writes the entity stream for one client, for an authority written in TypeScript (tests, the
 * in-page demo host). Keeps what it last sent of each thing and sends each field whose encoding
 * changed.
 */
export class EntityEncoder<V extends object = Record<string, unknown>> {
  readonly #fields: ViewField[];
  readonly #sent = new Map<number, Uint8Array[]>();
  #key = true;

  constructor(schema: NetSchema, view: string) {
    this.#fields = viewFields(schema, view);
  }

  /** The next frame is a key frame (the client asked, after an error). */
  resync(): void {
    this.#key = true;
  }

  /** The frame that brings the client from what it was last sent to `things`; null if nothing changed. */
  frame(tick: number, things: ReadonlyMap<number, V>): Uint8Array | null {
    const key = this.#key;
    this.#key = false;
    if (key) this.#sent.clear();
    const body = new Writer();
    let n = 0;
    const fw = new Writer();
    for (const [id, view] of things) {
      const enc = this.#fields.map((f) => {
        fw.reset();
        f.codec.encode(fw, (view as Record<string, unknown>)[f.prop]);
        return fw.finish();
      });
      const last = this.#sent.get(id);
      this.#sent.set(id, enc);
      if (!last) {
        body.u64(id);
        body.u32(NEW);
        for (const b of enc) body.raw(b);
        n++;
        continue;
      }
      let bits = 0;
      for (let i = 0; i < enc.length; i++) if (!sameBytes(enc[i]!, last[i]!)) bits |= 4 << i;
      if (bits === 0) continue;
      body.u64(id);
      body.u32(bits);
      for (let i = 0; i < enc.length; i++) if (bits & (4 << i)) body.raw(enc[i]!);
      n++;
    }
    for (const id of [...this.#sent.keys()]) {
      if (things.has(id)) continue;
      this.#sent.delete(id);
      body.u64(id);
      body.u32(GONE);
      n++;
    }
    if (n === 0 && !key) return null;
    const w = new Writer();
    w.u8(key ? KEY : 0);
    w.u64(tick);
    w.u32(n);
    w.raw(body.finish());
    return w.finish();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
