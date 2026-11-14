/**
 * The envelope: the handshake and transport messages every networked game needs, owned by the
 * engine. A game supplies the types that fill its roles (what `Hello` carries, its commands and
 * their results, its interest shape, its input and predicted state, and its own client and server
 * messages); `defineSchema` wraps them in `ClientMsg` and `ServerMsg` and hashes the whole.
 *
 * Variant order is the wire order and part of the contract with the server's `ClientMsg<G>` and
 * `ServerMsg<G>`: append, never reorder.
 */

import type { PatchOp } from './patch';
import {
  type QuerySpec,
  Schema,
  SchemaError,
  type TypeDefSpec,
  type TypeSpec,
  t,
  WIRE_HEADER,
} from './schema';

/** The game's types for each envelope role. A role left out carries `Empty` (no bytes). */
export interface Roles {
  /** Extra fields of `Hello` (`ext`). */
  readonly hello?: TypeSpec;
  /** Extra fields of `Welcome` (`ext`). */
  readonly welcome?: TypeSpec;
  /** What `net.command()` sends. */
  readonly command?: TypeSpec;
  /** What a `CommandResult` carries back. */
  readonly result?: TypeSpec;
  /** The interest shape `net.setInterest()` sends. */
  readonly interest?: TypeSpec;
  /** One predicted input (`Input`). */
  readonly input?: TypeSpec;
  /** The authoritative predicted state (`PlayerState`). */
  readonly state?: TypeSpec;
  /** The game's own client messages (`ClientMsg::Game`). */
  readonly client?: TypeSpec;
  /** The game's own server messages (`ServerMsg::Game`). */
  readonly server?: TypeSpec;
}

/** A game's schema description. */
export interface SchemaDesc {
  /** The game's named types. */
  readonly types?: Readonly<Record<string, TypeDefSpec>>;
  /** The game's types for each envelope role. */
  readonly roles?: Roles;
  /** Live queries, by snake_case wire name. */
  readonly queries?: Readonly<Record<string, QuerySpec>>;
  /** More root types after the envelope's, such as an entity stream's view type. */
  readonly roots?: readonly string[];
}

/** Names the envelope defines; a game type may not take them. */
export const ENVELOPE_TYPES = [
  'ClientMsg',
  'ServerMsg',
  'Resume',
  'PatchOp',
  'PathStep',
  'Empty',
] as const;

const role = (r: TypeSpec | undefined): TypeSpec => r ?? 'Empty';

/**
 * Builds a game's schema: its types inside the engine envelope, rooted at `ClientMsg` and
 * `ServerMsg` (then `roots`), plus its live queries. The hash is what `Hello` carries.
 */
export function defineSchema(desc: SchemaDesc = {}): Schema {
  const game = desc.types ?? {};
  for (const name of ENVELOPE_TYPES) {
    if (Object.hasOwn(game, name)) throw new SchemaError(`${name} is an envelope type`);
  }
  const r = desc.roles ?? {};
  const env: Record<string, TypeDefSpec> = {
    ClientMsg: {
      enum: {
        Hello: {
          token: 'String',
          schema_hash: 'String',
          bulk: t.option('u8'),
          ext: role(r.hello),
        },
        Command: { seq: 'u32', command: role(r.command) },
        Subscribe: { sub: 'u32', query: 'String', args: 'Bytes', resume: t.option('Resume') },
        Unsubscribe: { sub: 'u32' },
        Ping: { client_time: 'u64' },
        SetInterest: { interest: role(r.interest) },
        Input: { seq: 'u32', input: role(r.input) },
        TakeControl: null,
        EntityResync: null,
        Ack: { bytes: 'u64' },
        Game: [role(r.client)],
      },
    },
    Resume: { struct: { version: 'u64', hash: 'String' } },
    Empty: { struct: {} },
    ServerMsg: {
      enum: {
        Welcome: {
          player: 'u64',
          time: 'u64',
          paused: 'bool',
          step_us: 'u32',
          ext: role(r.welcome),
        },
        Rejected: { reason: 'String', stale_schema: 'bool' },
        CommandResult: { seq: 'u32', result: role(r.result) },
        Update: { sub: 'u32', version: 'u64', hash: 'String', patch: t.vec('PatchOp') },
        Resync: { sub: 'u32', version: 'u64', result: 'Bytes' },
        QueryFailed: { sub: 'u32', reason: 'String' },
        Clock: { time: 'u64', paused: 'bool' },
        Pong: { client_time: 'u64', time: 'u64', paused: 'bool' },
        InterestRejected: { reason: 'String' },
        EntityStream: { data: 'Bytes' },
        PlayerState: { seq: 'u32', state: role(r.state), tick_us: 'u32' },
        Control: { driving: 'bool' },
        Closed: { code: 'u16', reason: 'String' },
        Bulk: { codec: 'u8', data: 'Bytes' },
        Game: [role(r.server)],
      },
    },
    PatchOp: {
      enum: {
        Set: { path: t.vec('PathStep'), value: 'Bytes' },
        MapPut: { path: t.vec('PathStep'), key: 'Bytes', value: 'Bytes' },
        MapRemove: { path: t.vec('PathStep'), key: 'Bytes' },
      },
    },
    PathStep: {
      enum: {
        Field: { index: 'u32' },
        Variant: { variant: 'u32', field: 'u32' },
        Entry: { key: 'Bytes' },
        Present: null,
      },
    },
  };
  const types: Record<string, TypeDefSpec> = { ...env, ...game };
  // `Empty` only when a role uses it, so a game that fills every role has no stray type.
  const usesEmpty = Object.values({
    hello: r.hello,
    welcome: r.welcome,
    command: r.command,
    result: r.result,
    interest: r.interest,
    input: r.input,
    state: r.state,
    client: r.client,
    server: r.server,
  }).some((v) => v === undefined || v === 'Empty');
  if (!usesEmpty) delete types.Empty;
  return new Schema(WIRE_HEADER, {
    roots: ['ClientMsg', 'ServerMsg', ...(desc.roots ?? [])],
    types,
    queries: desc.queries,
  });
}

/** The empty value: what a role left out carries. */
export const EMPTY: Readonly<Record<string, never>> = Object.freeze({});

/** A `ClientMsg` value. `G*` are the game's role value types. */
export type ClientMsg<
  GHello = unknown,
  GCommand = unknown,
  GInterest = unknown,
  GInput = unknown,
  GClient = unknown,
> =
  | { type: 'Hello'; token: string; schemaHash: string; bulk: number | null; ext: GHello }
  | { type: 'Command'; seq: number; command: GCommand }
  | {
      type: 'Subscribe';
      sub: number;
      query: string;
      args: Uint8Array;
      resume: { version: number; hash: string } | null;
    }
  | { type: 'Unsubscribe'; sub: number }
  | { type: 'Ping'; clientTime: number }
  | { type: 'SetInterest'; interest: GInterest }
  | { type: 'Input'; seq: number; input: GInput }
  | { type: 'TakeControl' }
  | { type: 'EntityResync' }
  | { type: 'Ack'; bytes: number }
  | { type: 'Game'; value: GClient };

/** A `ServerMsg` value. */
export type ServerMsg<GWelcome = unknown, GResult = unknown, GState = unknown, GServer = unknown> =
  | {
      type: 'Welcome';
      player: number;
      time: number;
      paused: boolean;
      stepUs: number;
      ext: GWelcome;
    }
  | { type: 'Rejected'; reason: string; staleSchema: boolean }
  | { type: 'CommandResult'; seq: number; result: GResult }
  | { type: 'Update'; sub: number; version: number; hash: string; patch: PatchOp[] }
  | { type: 'Resync'; sub: number; version: number; result: Uint8Array }
  | { type: 'QueryFailed'; sub: number; reason: string }
  | { type: 'Clock'; time: number; paused: boolean }
  | { type: 'Pong'; clientTime: number; time: number; paused: boolean }
  | { type: 'InterestRejected'; reason: string }
  | { type: 'EntityStream'; data: Uint8Array }
  | { type: 'PlayerState'; seq: number; state: GState; tickUs: number }
  | { type: 'Control'; driving: boolean }
  | { type: 'Closed'; code: number; reason: string }
  | { type: 'Bulk'; codec: number; data: Uint8Array }
  | { type: 'Game'; value: GServer };
