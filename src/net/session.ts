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
import type { ClientMsg, ServerMsg } from './envelope';
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
  /** A connection was lost; it reconnects. */
  down: [code: number, reason: string];
  /** Closed for good. */
  closed: [code: number, reason: string];
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
  constructor(message: string) {
    super(message);
    this.name = 'NetError';
  }
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
    this.#bulk = options.inflate ? (options.bulk ?? 1) : null;
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
      return Promise.reject(new NetError(`not connected (${this.#status})`));
    this.#seq = (this.#seq + 1) >>> 0;
    const seq = this.#seq;
    let frame: Uint8Array;
    try {
      frame = this.#encode({ type: 'Command', seq, command });
    } catch (e) {
      return Promise.reject(new NetError(`command can't be sent: ${(e as Error).message}`));
    }
    return new Promise<R>((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        if (this.#waiting.delete(seq)) reject(new NetError(`command ${seq} timed out`));
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

  /** Sends a game client message (`ClientMsg::Game`); false if not open. */
  send(value: unknown): boolean {
    if (this.#status !== 'open') return false;
    this.#send({ type: 'Game', value });
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

  /** Drops the connection and reconnects (keeping queries and interest). */
  reconnect(): void {
    if (this.#status === 'closed') return;
    this.#lost(1000, 'reconnect', 0);
  }

  /** Closes for good. */
  close(): void {
    this.#end(1000, 'closed');
  }

  // ------------------------------------------------------------------ connection

  #emit<E extends keyof NetEvents>(event: E, ...args: NetEvents[E]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as unknown as (...a: NetEvents[E]) => void)(...args);
      } catch (e) {
        // One throwing listener doesn't stop the others.
        if (event !== 'error') this.#emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  #open(): void {
    const gen = ++this.#generation;
    this.#status = this.#downSince >= 0 ? 'down' : 'connecting';
    const live = () => gen === this.#generation;
    this.#handshakeTimer = this.#timers.setTimeout(() => {
      if (live()) this.#lost(1006, 'handshake timed out');
    }, this.#handshakeMs);
    this.#transport = this.#connect({
      open: () => {
        if (!live()) return;
        const h = typeof this.#hello === 'function' ? this.#hello() : this.#hello;
        this.#lastHeard = this.#timers.now();
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
        if (live()) this.#lost(code, reason || 'connection closed');
      },
    });
  }

  /** The connection ended (not by `close()`): reconnect or, if that's over, close for good. */
  #lost(code: number, reason: string, delay?: number): void {
    if (this.#status === 'closed') return;
    this.#teardown(new NetError(`connection lost: ${reason}`));
    const r = this.#reconnect;
    const now = this.#timers.now();
    if (this.#downSince < 0) this.#downSince = now;
    if (!r || now - this.#downSince >= r.giveUpAfter) {
      this.#end(code, r ? `could not reconnect within ${r.giveUpAfter} ms: ${reason}` : reason);
      return;
    }
    if (this.#status !== 'down') {
      this.#status = 'down';
      this.#emit('down', code, reason);
    }
    const wait =
      delay ??
      Math.min(r.maxDelay, r.initialDelay * 2 ** this.#attempt) *
        (1 - Math.min(1, Math.max(0, r.jitter)) * this.#random());
    this.#attempt++;
    this.#retryTimer = this.#timers.setTimeout(() => {
      this.#retryTimer = null;
      if (this.#status === 'down') this.#open();
    }, wait);
  }

  /** Closes for good. */
  #end(code: number, reason: string): void {
    if (this.#status === 'closed') return;
    const error = new NetError(`closed: ${reason}`);
    this.#teardown(error);
    if (this.#retryTimer !== null) this.#timers.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#status = 'closed';
    this.#readyReject(error);
    this.#emit('closed', code, reason);
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
    const heard = now - this.#lastHeard;
    if (heard >= this.#deadMs) {
      this.#lost(1006, `nothing heard for ${Math.round(heard)} ms`);
      return;
    }
    if (this.#wakeAt >= 0 && now - this.#wakeAt >= this.#wakeMs) {
      this.#lost(1006, 'no answer after waking');
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
    this.#lastHeard = this.#timers.now();
    this.#wakeAt = -1;
    if (this.#held) {
      this.#held.push(frame);
      return;
    }
    this.#handleFrame(frame);
  }

  #handleFrame(frame: Uint8Array): void {
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
      this.#protocolError((e as Error).message);
    }
  }

  #protocolError(message: string): void {
    this.#emit('error', new NetError(`protocol: ${message}`));
    this.#lost(1002, message);
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
        this.#emit('rejected', msg.reason, msg.staleSchema);
        this.#end(4000, `rejected: ${msg.reason}`);
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
        this.#resync(msg.sub, msg.version, msg.result);
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
      case 'Closed':
        if (msg.code >= 4000 && msg.code < 5000) this.#end(msg.code, msg.reason);
        else this.#lost(msg.code, msg.reason);
        return;
      case 'Bulk':
        this.#bulkLane(msg.codec, msg.data);
        return;
      case 'Game':
        this.#emit('game', msg.value);
        return;
    }
  }

  #welcomed(msg: Welcome): void {
    if (this.#welcome) throw new NetError('a second Welcome');
    if (this.#handshakeTimer !== null) this.#timers.clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
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

  #resync(id: number, version: number, bytes: Uint8Array): void {
    const sub = this.#subs.get(id);
    if (!sub) return; // Unsubscribed while it was on its way.
    const value = this.schema.decode(sub.result, bytes);
    sub.bytes = bytes;
    sub.value = value;
    sub.version = version;
    sub.hash = resultHash(bytes);
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

  /** A bulk lane: inflate, then handle its frames in order, holding later frames meanwhile. */
  #bulkLane(codec: number, data: Uint8Array): void {
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
          this.#protocolError(`bad bulk lane: ${(e as Error).message}`);
          return;
        }
        this.#send({ type: 'Ack', bytes: data.length });
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
