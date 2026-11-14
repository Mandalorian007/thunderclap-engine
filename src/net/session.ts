/**
 * A network session: one client's connection to an authoritative server, over a transport the game
 * hands in. It does the handshake (the schema hash in `Hello`), keeps the link alive (quiet pings, a
 * dead link reconnects with backoff), follows the server's clock, matches command results, keeps
 * live queries current from patches (resuming them after a reconnect), decodes the entity stream,
 * and wires a predictor to `Input` and `PlayerState`.
 *
 * Closing for good: a `Rejected` handshake, a server `Closed` with a code of 4000 to 4999 (the
 * game's own: kicked, banned), `close()`, or reconnecting failing for `giveUpAfter`. Anything else
 * that ends a connection (a lost link, a server restart's `Closed` 1001 or 1012, a protocol error)
 * is `down`: it reconnects.
 */

import { NetClock } from './clock';
import { type EntityChanges, EntityStream } from './entities';
import { type ClientMsg, type EnvelopeInfo, envelopeOf, type ServerMsg } from './envelope';
import { resultHash } from './hash';
import { Optimistic, type OptimisticStore } from './optimistic';
import { applyPatch, type PatchOp } from './patch';
import { Predictor, type PredictorOptions } from './predict';
import type { NetSchema, TypeRef } from './schema';
import { SnapshotBuffer, type SnapshotBufferOptions } from './snapshots';
import { type Connect, pageTimers, type Timers, type Transport } from './transport';
import { Reader, Writer } from './wire';

/** How a session reconnects. */
export interface ReconnectOptions {
  /** Ms before the first attempt (default 100). */
  readonly initialDelay?: number;
  /** The longest wait between attempts; each failure doubles it up to this (default 5000). */
  readonly maxDelay?: number;
  /** How much of each wait is random, 0..1 (default 0.5), so clients don't retry in step. */
  readonly jitter?: number;
  /** Give up (closed for good) after this many ms of failures (default 60000). */
  readonly giveUpAfter?: number;
}

/** How a session notices a dead link. */
export interface LivenessOptions {
  /** Ping after this long without a ping (default 2000); a ping also measures latency. */
  readonly pingMs?: number;
  /** Reconnect after this long hearing nothing (default 15000). */
  readonly deadMs?: number;
  /** After `wake()`, reconnect unless something arrives within this (default 2000). */
  readonly wakeMs?: number;
  /**
   * When hearing counts: `'message'` (default) reads the clock for each message received; `'tick'`
   * only notes that something arrived, and the liveness tick (every quarter of the shortest of
   * `pingMs`, `deadMs` and `wakeMs`) reads the clock once for all of them. For a busy link.
   */
  readonly heardBy?: 'message' | 'tick';
}

/** Why a session went down or closed, or a command failed: `NetReason.kind`. */
export type NetReasonKind =
  /** `close()` was called. */
  | 'closed'
  /** The server refused the handshake (`Rejected`). */
  | 'rejected'
  /** The server sent `Closed` (final for codes 4000 to 4999, else it reconnects). */
  | 'serverClosed'
  /** Reconnecting failed for `giveUpAfter` (`last` says why the last attempt ended). */
  | 'gaveUp'
  /** The transport closed (the code is its own). */
  | 'lost'
  /** A handshake took longer than `handshakeMs`. */
  | 'handshakeTimeout'
  /** Nothing was heard for `deadMs`. */
  | 'dead'
  /** Nothing arrived within `wakeMs` of `wake()`. */
  | 'wakeTimeout'
  /** The server sent something the session could not take. */
  | 'protocol'
  /** `reconnect()` was called. */
  | 'reconnect'
  /** A command had no result within `commandMs`. */
  | 'commandTimeout'
  /** A command was sent while the session was not open. */
  | 'notOpen'
  /** A command could not be encoded. */
  | 'unencodable';

/** A typed reason: what happened (`kind`) and its human detail (the `reason` string of old). */
export interface NetReason {
  readonly kind: NetReasonKind;
  readonly detail: string;
  /** For `gaveUp`: why the last connection ended. */
  readonly last?: NetReason;
}

/** What `Hello` carries besides the schema hash. */
export interface Hello {
  readonly token?: string;
  readonly ext?: unknown;
}

/** Options for `createNet`. */
export interface NetOptions {
  /** The game's schema (`defineSchema`). */
  readonly schema: NetSchema;
  /** Opens one connection; called again for each reconnect. */
  readonly connect: Connect;
  /** What `Hello` carries, or a function for a fresh one each connection (a new token). */
  readonly hello?: Hello | (() => Hello);
  /** Reconnect options, or false to close for good when a connection is lost. */
  readonly reconnect?: ReconnectOptions | false;
  /** Liveness options. */
  readonly liveness?: LivenessOptions;
  /** How long a handshake may take before the attempt counts as failed, ms (default 10000). */
  readonly handshakeMs?: number;
  /** How long a command may wait for its result, ms (default 30000). */
  readonly commandMs?: number;
  /**
   * Inflates a `Bulk` lane's data (the game's codec, maybe in a worker). Without it no bulk lane is
   * offered. `bulk` is the codec number offered in `Hello`.
   */
  readonly inflate?: (codec: number, data: Uint8Array) => Promise<Uint8Array>;
  readonly bulk?: number;
  /**
   * Take uncompressed bulk lanes (codec 0) at once, in the same call that received them, instead of
   * through `inflate` (default false). Without `inflate`, `Hello` then offers codec 0.
   */
  readonly plainBulk?: boolean;
  /**
   * `command()` resolves with the result's encoded bytes (a `Uint8Array`, the `result` role's
   * wire form), not decoded, so a game's own outcome type is read by the game (default false).
   */
  readonly rawResults?: boolean;
  /**
   * What a throwing listener does: `'report'` (default) keeps the other listeners going and reports
   * it as an `error` event; `'throw'` runs the others and then throws the first error out of the
   * call that emitted the event (a transport's message callback, `close()`, ...), as it is.
   */
  readonly listenerErrors?: 'report' | 'throw';
  /** The struct the entity stream carries, if the game uses one (`net.entities`). */
  readonly entities?: string;
  /** The snapshot buffer's options (`net.snapshots`). */
  readonly snapshots?: SnapshotBufferOptions;
  /** Timers (default the page's) and randomness (default `Math.random`). */
  readonly timers?: Timers;
  readonly random?: () => number;
}

/** The server's `Welcome`. */
export type Welcome = Extract<ServerMsg, { type: 'Welcome' }>;

/** Events a session reports, with their arguments. */
export interface NetEvents {
  /** A handshake succeeded (each connection). */
  welcome: [welcome: Welcome];
  /** The server refused the handshake (closed for good). `stale`: the client's schema is old. */
  rejected: [reason: string, stale: boolean];
  /** A connection was lost; it reconnects. `why` is the reason, typed. */
  down: [code: number, reason: string, why: NetReason];
  /** Closed for good. `why` is the reason, typed. */
  closed: [code: number, reason: string, why: NetReason];
  /** A game server message (`ServerMsg::Game`). */
  game: [value: unknown];
  /** An entity-stream frame was applied (`net.entities`); the changes are reused next frame. */
  entities: [changes: EntityChanges];
  /** The server refused an interest shape. */
  interestRejected: [reason: string];
  /** This connection now drives (or watches) the predicted thing. */
  control: [driving: boolean];
  /** The server's state after input `seq` (`PlayerState`). */
  state: [seq: number, state: unknown];
  /** A protocol error (the connection is dropped and reconnects) or an entity-stream error. */
  error: [error: Error];
}

/** A session's state. */
export type NetStatus = 'connecting' | 'open' | 'down' | 'closed';

/** A failed command or a session that can't carry one. */
export class NetError extends Error {
  /** Why, typed, when the session knows (a lost or closed session, a timed-out command). */
  readonly reason: NetReason | undefined;
  constructor(message: string, reason?: NetReason) {
    super(message);
    this.name = 'NetError';
    this.reason = reason;
  }
}

/** Options for `Net.reconnect`. */
export interface ReconnectNowOptions {
  /** Wait the reconnect backoff before the next attempt instead of reopening at once (default false). */
  readonly backoff?: boolean;
}

/** A live query's handle. */
export interface LiveQuery<T> {
  /** The latest result (undefined until the first). */
  readonly value: T | undefined;
  /** The latest result's version. */
  readonly version: number;
  /** Stops it. */
  close(): void;
}

/** Options for one live query. */
export interface QueryOptions {
  /** The server refused it (it stays subscribed and is asked again after a reconnect). */
  readonly onFailed?: (reason: string) => void;
  /** Check each patched result's hash (default true); a mismatch asks for the whole result. */
  readonly checkHash?: boolean;
}

interface Sub {
  id: number;
  readonly name: string;
  readonly args: Uint8Array;
  readonly result: TypeRef;
  readonly listener: (value: unknown, patch: readonly PatchOp[] | null) => void;
  readonly options: QueryOptions;
  bytes: Uint8Array | null;
  value: unknown;
  version: number;
  hash: string;
  closed: boolean;
}

interface Waiting {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: unknown;
}

/**
 * The client side of a networked game. See `createNet`.
 */
export class Net {
  /** The game's schema. */
  readonly schema: NetSchema;
  /** The server's game time, in steps. */
  readonly clock: NetClock;
  /** Remote things drawn a little in the past: push into it from the entity stream or game messages. */
  readonly snapshots: SnapshotBuffer;
  /** The entity stream's decoded things, when `entities` named a view struct. */
  readonly entities: EntityStream | null;

  readonly #connect: Connect;
  readonly #hello: Hello | (() => Hello);
  readonly #reconnect: Required<ReconnectOptions> | null;
  readonly #pingMs: number;
  readonly #deadMs: number;
  readonly #wakeMs: number;
  readonly #handshakeMs: number;
  readonly #commandMs: number;
  readonly #inflate: NetOptions['inflate'];
  readonly #bulk: number | null;
  readonly #plainBulk: boolean;
  /** The schema's envelope layout. */
  readonly #env: EnvelopeInfo;
  /** Bulk data bytes taken this connection (an `Ack`'s total, for `ack: 'total'`). */
  #taken = 0;
  /** `CommandResult`'s tag when results are raw, else -1. */
  readonly #rawResult: number;
  readonly #throwListenerErrors: boolean;
  readonly #heardByTick: boolean;
  /** Something arrived since the last liveness tick (`heardBy: 'tick'`). */
  #heard = false;
  /** The error a listener threw, on its way out (`listenerErrors: 'throw'`). */
  #thrown: { readonly error: unknown } | null = null;
  readonly #timers: Timers;
  readonly #random: () => number;
  readonly #listeners = new Map<keyof NetEvents, Set<(...args: never[]) => void>>();

  #status: NetStatus = 'connecting';
  #transport: Transport | null = null;
  #generation = 0;
  #welcome: Welcome | null = null;
  #attempt = 0;
  #downSince = -1;
  #retryTimer: unknown = null;
  #handshakeTimer: unknown = null;
  #tickTimer: unknown = null;
  #lastHeard = 0;
  #lastPing = 0;
  #wakeAt = -1;
  #seq = 0;
  readonly #waiting = new Map<number, Waiting>();
  #nextSub = 1;
  readonly #subs = new Map<number, Sub>();
  #interest: { readonly value: unknown } | null = null;
  #predictor: Predictor<unknown, unknown> | null = null;
  readonly #optimistic = new Set<Optimistic<unknown, unknown>>();
  #driving = true;
  /** Frames held while a bulk lane inflates, so they are handled in order. */
  #held: Uint8Array[] | null = null;
  #ready: Promise<Welcome>;
  #readyResolve!: (w: Welcome) => void;
  #readyReject!: (e: Error) => void;
  readonly #enc = new Writer();

  constructor(options: NetOptions) {
    this.schema = options.schema;
    this.#connect = options.connect;
    this.#hello = options.hello ?? {};
    this.#reconnect =
      options.reconnect === false
        ? null
        : {
            initialDelay: 100,
            maxDelay: 5000,
            jitter: 0.5,
            giveUpAfter: 60_000,
            ...options.reconnect,
          };
    this.#pingMs = options.liveness?.pingMs ?? 2000;
    this.#deadMs = options.liveness?.deadMs ?? 15_000;
    this.#wakeMs = options.liveness?.wakeMs ?? 2000;
    this.#handshakeMs = options.handshakeMs ?? 10_000;
    this.#commandMs = options.commandMs ?? 30_000;
    this.#inflate = options.inflate;
    this.#plainBulk = options.plainBulk === true;
    this.#env = envelopeOf(this.schema);
    this.#bulk = options.inflate ? (options.bulk ?? 1) : this.#plainBulk ? 0 : null;
    this.#rawResult = options.rawResults
      ? this.schema.variants('ServerMsg').indexOf('CommandResult')
      : -1;
    this.#throwListenerErrors = options.listenerErrors === 'throw';
    this.#heardByTick = options.liveness?.heardBy === 'tick';
    this.#timers = options.timers ?? pageTimers;
    this.#random = options.random ?? Math.random;
    const now = () => this.#timers.now();
    this.clock = new NetClock(0, true, 50, now);
    this.snapshots = new SnapshotBuffer(options.snapshots);
    this.entities = options.entities ? new EntityStream(this.schema, options.entities) : null;
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#ready.catch(() => {});
    this.#open();
  }

  /** Where the session is. */
  get status(): NetStatus {
    return this.#status;
  }

  /** The current connection's `Welcome` (null while not open). */
  get welcome(): Welcome | null {
    return this.#welcome;
  }

  /** Resolves on the first `Welcome`; rejects if the session closes before one. */
  get ready(): Promise<Welcome> {
    return this.#ready;
  }

  /** Whether this connection drives the predicted thing (`Control`; true until told otherwise). */
  get driving(): boolean {
    return this.#driving;
  }

  /** Reconnect attempts since the last `Welcome`. */
  get attempts(): number {
    return this.#attempt;
  }

  /** Listens to an event; returns the function that stops listening. */
  on<E extends keyof NetEvents>(event: E, listener: (...args: NetEvents[E]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const fn = listener as unknown as (...args: never[]) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Sends a command; resolves with its `CommandResult`. Rejects with `NetError` if the session isn't
   * open, the command can't be encoded, it times out, or the connection drops first.
   */
  command<R = unknown>(command: unknown): Promise<R> {
    if (this.#status !== 'open')
      return Promise.reject(
        new NetError(`not connected (${this.#status})`, { kind: 'notOpen', detail: this.#status }),
      );
    this.#seq = (this.#seq + 1) >>> 0;
    const seq = this.#seq;
    let frame: Uint8Array;
    try {
      frame = this.#encode({ type: 'Command', seq, command });
    } catch (e) {
      const detail = (e as Error).message;
      return Promise.reject(
        new NetError(`command can't be sent: ${detail}`, { kind: 'unencodable', detail }),
      );
    }
    return new Promise<R>((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        if (this.#waiting.delete(seq)) {
          const detail = `command ${seq} timed out`;
          reject(new NetError(detail, { kind: 'commandTimeout', detail }));
        }
      }, this.#commandMs);
      this.#waiting.set(seq, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#transport!.send(frame);
    });
  }

  /**
   * Subscribes to live query `name` (its args as an object with camelCase names). `listener` gets
   * the whole result each time it changes, with the patch that changed it (null for a whole one).
   */
  query<T = unknown>(
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
    listener: (value: T, patch: readonly PatchOp[] | null) => void,
    options: QueryOptions = {},
  ): LiveQuery<T> {
    const def = this.schema.queries.get(name);
    if (!def) throw new NetError(`no query named ${name}`);
    const sub: Sub = {
      id: this.#nextSub++,
      name,
      args: this.schema.encodeArgs(name, args),
      result: def.result,
      listener: listener as Sub['listener'],
      options,
      bytes: null,
      value: undefined,
      version: 0,
      hash: '',
      closed: false,
    };
    this.#subs.set(sub.id, sub);
    if (this.#status === 'open') this.#subscribe(sub, false);
    return {
      get value() {
        return sub.value as T | undefined;
      },
      get version() {
        return sub.version;
      },
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        this.#subs.delete(sub.id);
        if (this.#status === 'open') this.#send({ type: 'Unsubscribe', sub: sub.id });
      },
    };
  }

  /** Sets what the server streams to this client (sent again after a reconnect). */
  setInterest(interest: unknown): void {
    const frame = this.#encode({ type: 'SetInterest', interest });
    this.#interest = { value: interest };
    if (this.#status === 'open') this.#transport!.send(frame);
  }

  /**
   * Sends a game client message (`ClientMsg::Game`, or with inline game messages, `value` itself:
   * `{ type: Name, ...fields }`); false if not open.
   */
  send(value: unknown): boolean {
    const game = this.#env.clientGame;
    if (game.size > 0) {
      const type = (value as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !game.has(type)) {
        throw new NetError(`send: ${JSON.stringify(type)} is not one of the game's messages`, {
          kind: 'unencodable',
          detail: `not a game message: ${JSON.stringify(type)}`,
        });
      }
    }
    if (this.#status !== 'open') return false;
    this.#send(game.size > 0 ? (value as ClientMsg) : { type: 'Game', value });
    return true;
  }

  /** Asks to drive the predicted thing (`TakeControl`). */
  takeControl(): void {
    if (this.#status === 'open') this.#send({ type: 'TakeControl' });
  }

  /**
   * Predicts the player's thing with the game's `step` (the server's own rules), checked against
   * every `PlayerState`. Send inputs with `input`.
   */
  predict<State, Input>(options: PredictorOptions<State, Input>): Predictor<State, Input> {
    const p = new Predictor<State, Input>({ now: () => this.#timers.now(), ...options });
    this.#predictor = p as Predictor<unknown, unknown>;
    return p;
  }

  /** Applies `input` to the predictor at once and sends it numbered; false if not sent. */
  input(input: unknown): boolean {
    const p = this.#predictor;
    if (!p) throw new NetError('input() needs predict() first');
    if (this.#status !== 'open' || !this.#driving) return false;
    const seq = p.apply(input);
    this.#send({ type: 'Input', seq, input });
    return true;
  }

  /** A keyed shadow-and-rollback for predicted edits over `store`, cleared on each reconnect. */
  optimistic<K, V>(
    store: OptimisticStore<K, V>,
    equal?: (a: V, b: V) => boolean,
  ): Optimistic<K, V> {
    const o = new Optimistic<K, V>(store, equal);
    this.#optimistic.add(o as Optimistic<unknown, unknown>);
    return o;
  }

  /**
   * The page came back (it was hidden, the device slept): ping now, and reconnect unless something
   * arrives within `wakeMs`.
   */
  wake(): void {
    if (this.#status !== 'open') return;
    this.#wakeAt = this.#timers.now();
    this.#ping();
  }

  /**
   * Drops the connection and reconnects (keeping queries and interest): at once, or after the
   * reconnect backoff with `{ backoff: true }`.
   */
  reconnect(options?: ReconnectNowOptions): void {
    if (this.#status === 'closed') return;
    this.#lost(1000, { kind: 'reconnect', detail: 'reconnect' }, options?.backoff ? undefined : 0);
  }

  /** Closes for good. */
  close(): void {
    this.#end(1000, { kind: 'closed', detail: 'closed' });
  }

  // ------------------------------------------------------------------ connection

  #emit<E extends keyof NetEvents>(event: E, ...args: NetEvents[E]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    let thrown: { readonly error: unknown } | null = null;
    for (const fn of [...set]) {
      try {
        (fn as unknown as (...a: NetEvents[E]) => void)(...args);
      } catch (e) {
        // One throwing listener doesn't stop the others.
        if (this.#throwListenerErrors) thrown ??= { error: e };
        else if (event !== 'error')
          this.#emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    }
    if (thrown) {
      this.#thrown = thrown;
      throw thrown.error;
    }
  }

  /** Whether `e` is a listener's error on its way out (`listenerErrors: 'throw'`). */
  #isThrown(e: unknown): boolean {
    return this.#thrown !== null && this.#thrown.error === e;
  }

  #open(): void {
    const gen = ++this.#generation;
    this.#status = this.#downSince >= 0 ? 'down' : 'connecting';
    const live = () => gen === this.#generation;
    this.#handshakeTimer = this.#timers.setTimeout(() => {
      if (live()) this.#lost(1006, { kind: 'handshakeTimeout', detail: 'handshake timed out' });
    }, this.#handshakeMs);
    this.#transport = this.#connect({
      open: () => {
        if (!live()) return;
        const h = typeof this.#hello === 'function' ? this.#hello() : this.#hello;
        this.#lastHeard = this.#timers.now();
        this.#taken = 0;
        this.#send({
          type: 'Hello',
          token: h.token ?? '',
          schemaHash: this.schema.hash,
          bulk: this.#bulk,
          ext: h.ext ?? {},
        });
      },
      message: (frame) => {
        if (live()) this.#receive(frame);
      },
      close: (code, reason) => {
        if (live()) this.#lost(code, { kind: 'lost', detail: reason || 'connection closed' });
      },
    });
  }

  /** The connection ended (not by `close()`): reconnect or, if that's over, close for good. */
  #lost(code: number, why: NetReason, delay?: number): void {
    if (this.#status === 'closed') return;
    this.#teardown(new NetError(`connection lost: ${why.detail}`, why));
    const r = this.#reconnect;
    const now = this.#timers.now();
    if (this.#downSince < 0) this.#downSince = now;
    if (!r || now - this.#downSince >= r.giveUpAfter) {
      this.#end(
        code,
        r
          ? {
              kind: 'gaveUp',
              detail: `could not reconnect within ${r.giveUpAfter} ms: ${why.detail}`,
              last: why,
            }
          : why,
      );
      return;
    }
    const announce = this.#status !== 'down';
    this.#status = 'down';
    const wait =
      delay ??
      Math.min(r.maxDelay, r.initialDelay * 2 ** this.#attempt) *
        (1 - Math.min(1, Math.max(0, r.jitter)) * this.#random());
    this.#attempt++;
    this.#retryTimer = this.#timers.setTimeout(() => {
      this.#retryTimer = null;
      if (this.#status === 'down') this.#open();
    }, wait);
    if (announce) this.#emit('down', code, why.detail, why);
  }

  /** Closes for good. */
  #end(code: number, why: NetReason): void {
    if (this.#status === 'closed') return;
    const error = new NetError(`closed: ${why.detail}`, why);
    this.#teardown(error);
    if (this.#retryTimer !== null) this.#timers.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#status = 'closed';
    this.#readyReject(error);
    this.#emit('closed', code, why.detail, why);
  }

  /** Ends the current connection: commands in flight fail, timers stop. */
  #teardown(error: Error): void {
    this.#generation++;
    const t = this.#transport;
    this.#transport = null;
    t?.close();
    this.#welcome = null;
    this.#held = null;
    for (const timer of [this.#handshakeTimer, this.#tickTimer]) {
      if (timer !== null) this.#timers.clearTimeout(timer);
    }
    this.#handshakeTimer = null;
    this.#tickTimer = null;
    this.#wakeAt = -1;
    for (const [seq, w] of this.#waiting) {
      this.#timers.clearTimeout(w.timer);
      this.#waiting.delete(seq);
      w.reject(error);
    }
    this.#predictor?.clear();
  }

  #encode(msg: ClientMsg): Uint8Array {
    const w = this.#enc;
    w.reset();
    this.schema.codec('ClientMsg').encode(w, msg);
    return w.finish();
  }

  #send(msg: ClientMsg): void {
    this.#transport?.send(this.#encode(msg));
  }

  #ping(): void {
    this.#lastPing = this.#timers.now();
    this.#send({ type: 'Ping', clientTime: Math.max(0, Math.floor(this.#lastPing)) });
  }

  /** Every so often while open: ping when due, and drop a link that has gone quiet. */
  #tick(): void {
    this.#tickTimer = null;
    if (this.#status !== 'open') return;
    const now = this.#timers.now();
    if (this.#heard) {
      this.#heard = false;
      this.#lastHeard = now;
    }
    const heard = now - this.#lastHeard;
    if (heard >= this.#deadMs) {
      this.#lost(1006, { kind: 'dead', detail: `nothing heard for ${Math.round(heard)} ms` });
      return;
    }
    if (this.#wakeAt >= 0 && now - this.#wakeAt >= this.#wakeMs) {
      this.#lost(1006, { kind: 'wakeTimeout', detail: 'no answer after waking' });
      return;
    }
    if (now - this.#lastPing >= this.#pingMs) this.#ping();
    this.#schedule();
  }

  #schedule(): void {
    const ms = Math.max(10, Math.min(this.#pingMs, this.#deadMs, this.#wakeMs) / 4);
    this.#tickTimer = this.#timers.setTimeout(() => this.#tick(), ms);
  }

  // ------------------------------------------------------------------ receiving

  #receive(frame: Uint8Array): void {
    this.#thrown = null;
    if (this.#heardByTick) this.#heard = true;
    else this.#lastHeard = this.#timers.now();
    this.#wakeAt = -1;
    if (this.#held) {
      this.#held.push(frame);
      return;
    }
    this.#handleFrame(frame);
  }

  #handleFrame(frame: Uint8Array): void {
    if (this.#rawResult >= 0 && this.#rawCommandResult(frame)) return;
    let msg: ServerMsg;
    try {
      msg = this.schema.decode<ServerMsg>('ServerMsg', frame);
    } catch (e) {
      this.#protocolError(`undecodable message: ${(e as Error).message}`);
      return;
    }
    try {
      this.#handle(msg);
    } catch (e) {
      if (this.#isThrown(e)) throw e;
      this.#protocolError((e as Error).message);
    }
  }

  /** A `CommandResult` resolved with its result's bytes (`rawResults`); false if `frame` is not one. */
  #rawCommandResult(frame: Uint8Array): boolean {
    let seq: number;
    const r = new Reader(frame);
    try {
      if (r.variant() !== this.#rawResult) return false;
      seq = r.u32();
    } catch {
      return false; // Not a well-formed result: the decoder says why.
    }
    if (!this.#welcome) {
      this.#protocolError('CommandResult before Welcome');
      return true;
    }
    const w = this.#waiting.get(seq);
    if (!w) {
      this.#protocolError(`result for unknown command ${seq}`);
      return true;
    }
    this.#waiting.delete(seq);
    this.#timers.clearTimeout(w.timer);
    w.resolve(frame.subarray(r.position));
    return true;
  }

  #protocolError(message: string): void {
    const why: NetReason = { kind: 'protocol', detail: message };
    try {
      this.#emit('error', new NetError(`protocol: ${message}`, why));
    } finally {
      this.#lost(1002, why);
    }
  }

  #handle(msg: ServerMsg): void {
    if (
      !this.#welcome &&
      msg.type !== 'Welcome' &&
      msg.type !== 'Rejected' &&
      msg.type !== 'Closed'
    ) {
      throw new NetError(`${msg.type} before Welcome`);
    }
    switch (msg.type) {
      case 'Welcome':
        this.#welcomed(msg);
        return;
      case 'Rejected':
        try {
          this.#emit('rejected', msg.reason, msg.staleSchema);
        } finally {
          this.#end(4000, { kind: 'rejected', detail: `rejected: ${msg.reason}` });
        }
        return;
      case 'CommandResult': {
        const w = this.#waiting.get(msg.seq);
        if (!w) throw new NetError(`result for unknown command ${msg.seq}`);
        this.#waiting.delete(msg.seq);
        this.#timers.clearTimeout(w.timer);
        w.resolve(msg.result);
        return;
      }
      case 'Update':
        this.#update(msg.sub, msg.version, msg.hash, msg.patch);
        return;
      case 'Resync':
        this.#resync(msg.sub, msg.version, msg.hash, msg.result);
        return;
      case 'QueryFailed': {
        const sub = this.#subs.get(msg.sub);
        sub?.options.onFailed?.(msg.reason);
        return;
      }
      case 'Clock':
        this.clock.observe(msg.time, msg.paused);
        return;
      case 'Pong': {
        const latency = Math.max(0, (this.#timers.now() - msg.clientTime) / 2);
        this.clock.observe(msg.time, msg.paused, latency);
        return;
      }
      case 'InterestRejected':
        this.#emit('interestRejected', msg.reason);
        return;
      case 'EntityStream':
        if (!this.entities) throw new NetError('EntityStream without an entities view');
        try {
          const changes = this.entities.apply(msg.data);
          if (changes) this.#emit('entities', changes);
        } catch (e) {
          if (this.#isThrown(e)) throw e;
          this.#send({ type: 'EntityResync' });
          this.#emit('error', e as Error);
        }
        return;
      case 'PlayerState': {
        const p = this.#predictor;
        if (p) {
          if (this.#driving) p.acknowledge(msg.seq, msg.state);
          else p.follow(msg.seq, msg.state);
        }
        this.#emit('state', msg.seq, msg.state);
        return;
      }
      case 'Control':
        this.#driving = msg.driving;
        if (!msg.driving) this.#predictor?.clear();
        this.#emit('control', msg.driving);
        return;
      case 'Closed': {
        const codes = this.#env.closeCodes;
        const code = codes
          ? (codes.get((msg.code as unknown as { type: string }).type) ?? 1002)
          : msg.code;
        if (code >= 4000 && code < 5000) {
          this.#end(code, { kind: 'serverClosed', detail: msg.reason });
        } else this.#lost(code, { kind: 'serverClosed', detail: msg.reason });
        return;
      }
      case 'Bulk':
        this.#bulkLane(msg.codec, msg.data);
        return;
      case 'Game':
        this.#emit('game', msg.value);
        return;
      default: {
        // One of the game's own messages, inline (`EnvelopeSpec`).
        const type = (msg as { type: string }).type;
        if (!this.#env.serverGame.has(type)) throw new NetError(`unexpected ${type}`);
        this.#emit('game', msg);
      }
    }
  }

  #welcomed(msg: Welcome): void {
    if (this.#welcome) throw new NetError('a second Welcome');
    if (this.#handshakeTimer !== null) this.#timers.clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
    // A layout without `step_us` (`EnvelopeSpec.welcome`) reads it as 0.
    if (msg.stepUs === undefined) msg = { ...msg, stepUs: 0 };
    this.#welcome = msg;
    this.#status = 'open';
    this.#attempt = 0;
    this.#downSince = -1;
    this.clock.reset(msg.time, msg.paused, msg.stepUs > 0 ? msg.stepUs / 1000 : 50);
    this.entities?.clear();
    this.snapshots.clear();
    this.#driving = true;
    for (const o of this.#optimistic) o.clear();
    for (const sub of this.#subs.values()) this.#subscribe(sub, true);
    if (this.#interest) this.#send({ type: 'SetInterest', interest: this.#interest.value });
    this.#lastPing = this.#timers.now();
    this.#schedule();
    this.#readyResolve(msg);
    this.#emit('welcome', msg);
  }

  #subscribe(sub: Sub, resume: boolean): void {
    this.#send({
      type: 'Subscribe',
      sub: sub.id,
      query: sub.name,
      args: sub.args,
      resume: resume && sub.bytes ? { version: sub.version, hash: sub.hash } : null,
    });
  }

  #resync(id: number, version: number, hash: string, bytes: Uint8Array): void {
    const sub = this.#subs.get(id);
    if (!sub) return; // Unsubscribed while it was on its way.
    const h = resultHash(bytes);
    if (sub.options.checkHash !== false && hash !== '' && h !== hash) {
      throw new NetError(`${sub.name}: a whole result that does not match its hash`);
    }
    const value = this.schema.decode(sub.result, bytes);
    sub.bytes = bytes;
    sub.value = value;
    sub.version = version;
    sub.hash = h;
    sub.listener(value, null);
  }

  #update(id: number, version: number, hash: string, patch: readonly PatchOp[]): void {
    const sub = this.#subs.get(id);
    if (!sub) return;
    if (!sub.bytes) throw new NetError(`update to ${sub.name} before its result`);
    let next: Uint8Array;
    try {
      next = applyPatch(this.schema.types, sub.result, sub.bytes, patch);
    } catch {
      this.#refetch(sub);
      return;
    }
    const h = resultHash(next);
    if (sub.options.checkHash !== false && hash !== '' && h !== hash) {
      this.#refetch(sub);
      return;
    }
    sub.bytes = next;
    sub.hash = h;
    sub.version = version;
    sub.value = this.schema.decode(sub.result, next);
    sub.listener(sub.value, patch);
  }

  /** What is held doesn't match the server's: ask for the whole result again (a fresh `sub`). */
  #refetch(sub: Sub): void {
    sub.bytes = null;
    this.#send({ type: 'Unsubscribe', sub: sub.id });
    this.#subs.delete(sub.id);
    sub.id = this.#nextSub++;
    this.#subs.set(sub.id, sub);
    this.#subscribe(sub, false);
  }

  /** Acknowledges one `Bulk`'s `bytes` of data, as the layout counts them. */
  #ack(bytes: number): void {
    this.#taken += bytes;
    this.#send(
      this.#env.ack === 'total'
        ? ({ type: 'Ack', total: this.#taken } as unknown as ClientMsg)
        : { type: 'Ack', bytes },
    );
  }

  /** A bulk lane: inflate, then handle its frames in order, holding later frames meanwhile. */
  #bulkLane(codec: number, data: Uint8Array): void {
    if (codec === 0 && this.#plainBulk) {
      // Uncompressed: its frames now, in order (nothing is held: held frames come in order too).
      const gen = this.#generation;
      const r = new Reader(data);
      while (r.remaining > 0) {
        this.#handleFrame(r.bytes());
        if (gen !== this.#generation) return;
      }
      this.#ack(data.length);
      return;
    }
    const inflate = this.#inflate;
    if (!inflate) throw new NetError('Bulk without an inflate hook');
    const gen = this.#generation;
    this.#held = [];
    inflate(codec, data).then(
      (bytes) => {
        if (gen !== this.#generation) return;
        const held = this.#held ?? [];
        this.#held = null;
        try {
          const r = new Reader(bytes);
          while (r.remaining > 0) {
            this.#handleFrame(r.bytes());
            if (gen !== this.#generation) return;
          }
        } catch (e) {
          if (this.#isThrown(e)) throw e;
          this.#protocolError(`bad bulk lane: ${(e as Error).message}`);
          return;
        }
        this.#ack(data.length);
        for (const f of held) {
          if (gen !== this.#generation) return;
          const waiting = this.#held as Uint8Array[] | null;
          if (waiting) waiting.push(f);
          else this.#handleFrame(f);
        }
      },
      (e: unknown) => {
        if (gen === this.#generation) this.#protocolError(`inflate failed: ${String(e)}`);
      },
    );
  }
}

/**
 * Starts a session: connects at once through `connect`, and keeps connected until `close()`. See
 * `Net` for the API.
 */
export function createNet(options: NetOptions): Net {
  return new Net(options);
}
