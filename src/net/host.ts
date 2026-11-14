/**
 * The server side of the envelope, in TypeScript: for tests, demos and in-page authorities. A real
 * game server speaks the same envelope from Rust (`tc-net`); this is the small part a TypeScript
 * authority needs: decode what a client sends, encode what it answers, and feed live queries.
 */

import type { ClientMsg, ServerMsg } from './envelope';
import { resultHash } from './hash';
import { diffValues } from './patch';
import type { NetSchema, TypeRef } from './schema';
import type { Connect, Transport } from './transport';

/** What a `ServerEnd` reports. */
export interface ServerEndEvents {
  /** The link opened. */
  open?(): void;
  /** A client message arrived (undecodable frames close the link). */
  message(msg: ClientMsg): void;
  /** The link closed. */
  close?(code: number, reason: string): void;
}

/** One client's connection, seen from the server: decoded `ClientMsg`s in, `ServerMsg`s out. */
export class ServerEnd {
  readonly #schema: NetSchema;
  readonly #transport: Transport;
  #open = false;
  #closed = false;

  /** Connects the server end of a link (`inPageHub`'s `accept` hands one over). */
  constructor(schema: NetSchema, connect: Connect, events: ServerEndEvents) {
    this.#schema = schema;
    this.#transport = connect({
      open: () => {
        this.#open = true;
        events.open?.();
      },
      message: (frame) => {
        let msg: ClientMsg;
        try {
          msg = schema.decode<ClientMsg>('ClientMsg', frame);
        } catch {
          this.close();
          return;
        }
        events.message(msg);
      },
      close: (code, reason) => {
        this.#open = false;
        this.#closed = true;
        events.close?.(code, reason);
      },
    });
  }

  /** Whether it is open. */
  get open(): boolean {
    return this.#open && !this.#closed;
  }

  /** Sends one message; dropped once closed. */
  send(msg: ServerMsg): void {
    if (!this.open) return;
    this.#transport.send(this.#schema.encode('ServerMsg', msg));
  }

  /** Sends bytes as they are (a test's broken frame). */
  sendRaw(frame: Uint8Array): void {
    if (this.open) this.#transport.send(frame);
  }

  /** Closes the link. */
  close(): void {
    this.#transport.close();
  }
}

/**
 * One subscriber's feed of a live query: the first result whole (`Resync`), then patches
 * (`Update`) carrying the new result's hash, as the server foundation's diff does.
 */
export class QueryFeed {
  readonly #schema: NetSchema;
  readonly #ty: TypeRef;
  /** The subscription it answers (a resumed feed takes the new one). */
  sub: number;
  #last: Uint8Array | null = null;
  #version = 0;

  constructor(schema: NetSchema, query: string, sub: number) {
    const q = schema.queries.get(query);
    if (!q) throw new Error(`no query named ${query}`);
    this.#schema = schema;
    this.#ty = q.result;
    this.sub = sub;
  }

  /** The result's version. */
  get version(): number {
    return this.#version;
  }

  /**
   * The message that brings the subscriber to `value`: a `Resync` the first time, an `Update` after,
   * null when nothing changed.
   */
  next(value: unknown): ServerMsg | null {
    const bytes = this.#schema.encode(this.#ty, value);
    const last = this.#last;
    this.#last = bytes;
    if (!last) {
      this.#version++;
      return { type: 'Resync', sub: this.sub, version: this.#version, result: bytes };
    }
    const patch = diffValues(this.#schema.types, this.#ty, last, bytes);
    if (patch.length === 0) return null;
    this.#version++;
    return {
      type: 'Update',
      sub: this.sub,
      version: this.#version,
      hash: resultHash(bytes),
      patch,
    };
  }

  /**
   * A resubscribe as `sub`: with a `resume` that matches what was last sent, nothing is resent (null);
   * otherwise the next message is whole.
   */
  resume(sub: number, resume: { version: number; hash: string } | null): boolean {
    this.sub = sub;
    if (
      resume &&
      this.#last &&
      resume.version === this.#version &&
      resume.hash === resultHash(this.#last)
    ) {
      return true;
    }
    this.#last = null;
    return false;
  }
}
