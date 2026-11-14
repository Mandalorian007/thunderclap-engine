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
  type FieldSpecs,
  NetSchema,
  netType,
  type QuerySpec,
  SchemaError,
  type TypeDefSpec,
  type TypeSpec,
  type VariantSpec,
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

/** `ClientMsg`'s engine variants, in the engine's own wire order (`EnvelopeSpec.client`'s default). */
export const ENVELOPE_CLIENT = [
  'Hello',
  'Command',
  'Subscribe',
  'Unsubscribe',
  'Ping',
  'SetInterest',
  'Input',
  'TakeControl',
  'EntityResync',
  'Ack',
  'Game',
] as const;

/** `ServerMsg`'s engine variants, in the engine's own wire order (`EnvelopeSpec.server`'s default). */
export const ENVELOPE_SERVER = [
  'Welcome',
  'Rejected',
  'CommandResult',
  'Update',
  'Resync',
  'QueryFailed',
  'Clock',
  'Pong',
  'InterestRejected',
  'EntityStream',
  'PlayerState',
  'Control',
  'Closed',
  'Bulk',
  'Game',
] as const;

/** An engine `ClientMsg` variant. */
export type EnvelopeClientVariant = (typeof ENVELOPE_CLIENT)[number];
/** An engine `ServerMsg` variant. */
export type EnvelopeServerVariant = (typeof ENVELOPE_SERVER)[number];

/**
 * How a game lays its envelope out on the wire, for a game with a protocol of its own. Every part is
 * optional; the default is the engine's wire, byte for byte. The Rust side names the same layout
 * with `Protocol::ENVELOPE` (`tc_net::Envelope`); the schema's text, and so its hash, follows it, so
 * a client and a server laid out differently refuse each other at `Hello`.
 */
export interface EnvelopeSpec {
  /**
   * `ClientMsg`'s variants in wire order (the tag is the position). An entry is an engine variant's
   * name, or `{ Name: fields }`: one of the game's own client messages as a variant of its own
   * (inline), in place of the engine's `Game` wrapper (`roles.client` is then left out). An engine
   * variant left out is not on this wire; `Hello` and `Ping` are required.
   */
  readonly client?: readonly (EnvelopeClientVariant | Readonly<Record<string, VariantSpec>>)[];
  /** `ServerMsg`'s variants the same way; `Welcome`, `Rejected`, `Pong` and `Closed` are required. */
  readonly server?: readonly (EnvelopeServerVariant | Readonly<Record<string, VariantSpec>>)[];
  /** `Hello`'s fields in wire order; `bulk` may be left out (no bulk lane). */
  readonly hello?: readonly ('token' | 'schema_hash' | 'bulk' | 'ext')[];
  /** `Welcome`'s fields in wire order; `step_us` may be left out (read as 0). */
  readonly welcome?: readonly ('player' | 'time' | 'paused' | 'step_us' | 'ext')[];
  /**
   * What an `Ack` counts: `'each'` (default), one `Bulk`'s data bytes (`Ack { bytes }`); `'total'`,
   * every `Bulk`'s data bytes taken since `Hello`, cumulative (`Ack { total }`).
   */
  readonly ack?: 'each' | 'total';
  /**
   * `Closed`'s code as the game's own enum of unit variants (`type`, one of `types`), variant `i`
   * standing for close code `codes[i]` (4000 to 4999 final, others reconnect). Default: a `u16`.
   */
  readonly close?: { readonly type: string; readonly codes: readonly number[] };
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
  /** The envelope's wire layout, for a game with a protocol of its own (default: the engine's). */
  readonly envelope?: EnvelopeSpec;
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

/** What a session reads off a schema's envelope (`envelopeOf`). */
export interface EnvelopeInfo {
  /** What an `Ack` counts. */
  readonly ack: 'each' | 'total';
  /** The game's inline client messages, by name (none: they go in `Game`). */
  readonly clientGame: ReadonlySet<string>;
  /** The game's inline server messages, by name (none: they come in `Game`). */
  readonly serverGame: ReadonlySet<string>;
  /** Close codes by the close enum's variant name, when `Closed` carries one. */
  readonly closeCodes: ReadonlyMap<string, number> | null;
}

const DEFAULT_INFO: EnvelopeInfo = {
  ack: 'each',
  clientGame: new Set(),
  serverGame: new Set(),
  closeCodes: null,
};
const infos = new WeakMap<NetSchema, EnvelopeInfo>();

/** @internal The envelope layout a session follows for `schema` (the engine's for `defineTypes`). */
export function envelopeOf(schema: NetSchema): EnvelopeInfo {
  return infos.get(schema) ?? DEFAULT_INFO;
}

/** Lays out one envelope enum: engine variants by name, the game's inline ones as given. */
function layout(
  what: 'ClientMsg' | 'ServerMsg',
  order: readonly (string | Readonly<Record<string, VariantSpec>>)[],
  engine: Readonly<Record<string, VariantSpec>>,
  required: readonly string[],
  gameRole: TypeSpec | undefined,
): { variants: Record<string, VariantSpec>; game: string[] } {
  const variants: Record<string, VariantSpec> = {};
  const game: string[] = [];
  const add = (name: string, spec: VariantSpec) => {
    if (Object.hasOwn(variants, name)) throw new SchemaError(`${what}: ${name} is listed twice`);
    variants[name] = spec;
  };
  for (const entry of order) {
    if (typeof entry === 'string') {
      if (!Object.hasOwn(engine, entry)) {
        throw new SchemaError(`${what}: ${entry} is not an engine variant`);
      }
      add(entry, engine[entry] as VariantSpec);
      continue;
    }
    const names = Object.keys(entry);
    if (names.length !== 1) {
      throw new SchemaError(`${what}: an inline game message is one { Name: fields }`);
    }
    const name = names[0] as string;
    if (Object.hasOwn(engine, name)) {
      throw new SchemaError(`${what}: the game message ${name} takes an engine variant's name`);
    }
    add(name, entry[name] as VariantSpec);
    game.push(name);
  }
  for (const name of required) {
    if (!Object.hasOwn(variants, name)) throw new SchemaError(`${what}: ${name} is required`);
  }
  if (game.length > 0 && Object.hasOwn(variants, 'Game')) {
    throw new SchemaError(`${what}: inline game messages and the Game wrapper both`);
  }
  if (game.length > 0 && gameRole !== undefined) {
    throw new SchemaError(`${what}: inline game messages replace its role; leave the role out`);
  }
  return { variants, game };
}

/** One message's fields in the order a layout gives, each from `fields` by wire name. */
function fieldsIn(
  what: string,
  order: readonly string[],
  fields: Readonly<Record<string, TypeSpec>>,
  required: readonly string[],
): Record<string, TypeSpec> {
  const out: Record<string, TypeSpec> = {};
  for (const name of order) {
    if (!Object.hasOwn(fields, name)) throw new SchemaError(`${what}: no field ${name}`);
    if (Object.hasOwn(out, name)) throw new SchemaError(`${what}: ${name} is listed twice`);
    out[name] = fields[name] as TypeSpec;
  }
  for (const name of required) {
    if (!Object.hasOwn(out, name)) throw new SchemaError(`${what}: ${name} is required`);
  }
  return out;
}

/**
 * Builds a game's schema: its types inside the engine envelope, rooted at `ClientMsg` and
 * `ServerMsg` (then `roots`), plus its live queries. The hash is what `Hello` carries.
 */
export function defineSchema(desc: SchemaDesc = {}): NetSchema {
  const game = desc.types ?? {};
  for (const name of ENVELOPE_TYPES) {
    if (Object.hasOwn(game, name)) throw new SchemaError(`${name} is an envelope type`);
  }
  const r = desc.roles ?? {};
  const e = desc.envelope ?? {};
  const ack = e.ack ?? 'each';
  if (ack !== 'each' && ack !== 'total') throw new SchemaError(`envelope.ack: ${String(ack)}`);
  let closeCode: TypeSpec = 'u16';
  let closeCodes: Map<string, number> | null = null;
  if (e.close) {
    const def = game[e.close.type];
    if (!def || !('enum' in def)) {
      throw new SchemaError(`envelope.close: ${e.close.type} is not one of the game's enums`);
    }
    const names = Object.keys(def.enum);
    if (names.some((n) => def.enum[n] !== null)) {
      throw new SchemaError(`envelope.close: ${e.close.type}'s variants carry nothing`);
    }
    if (names.length !== e.close.codes.length) {
      throw new SchemaError(`envelope.close: one code for each of ${e.close.type}'s variants`);
    }
    closeCodes = new Map();
    for (const [i, name] of names.entries()) {
      const code = e.close.codes[i] as number;
      if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
        throw new SchemaError(`envelope.close: ${code} is not a close code`);
      }
      closeCodes.set(name, code);
    }
    closeCode = e.close.type;
  }
  const hello = fieldsIn(
    'Hello',
    e.hello ?? ['token', 'schema_hash', 'bulk', 'ext'],
    { token: 'String', schema_hash: 'String', bulk: netType.option('u8'), ext: role(r.hello) },
    ['token', 'schema_hash', 'ext'],
  );
  const welcome = fieldsIn(
    'Welcome',
    e.welcome ?? ['player', 'time', 'paused', 'step_us', 'ext'],
    { player: 'u64', time: 'u64', paused: 'bool', step_us: 'u32', ext: role(r.welcome) },
    ['player', 'time', 'paused', 'ext'],
  );
  const client = layout(
    'ClientMsg',
    e.client ?? ENVELOPE_CLIENT,
    {
      Hello: hello,
      Command: { seq: 'u32', command: role(r.command) },
      Subscribe: { sub: 'u32', query: 'String', args: 'Bytes', resume: netType.option('Resume') },
      Unsubscribe: { sub: 'u32' },
      Ping: { client_time: 'u64' },
      SetInterest: { interest: role(r.interest) },
      Input: { seq: 'u32', input: role(r.input) },
      TakeControl: null,
      EntityResync: null,
      Ack: ack === 'each' ? { bytes: 'u64' } : { total: 'u64' },
      Game: [role(r.client)],
    },
    ['Hello', 'Ping'],
    e.client ? r.client : undefined,
  );
  const server = layout(
    'ServerMsg',
    e.server ?? ENVELOPE_SERVER,
    {
      Welcome: welcome,
      Rejected: { reason: 'String', stale_schema: 'bool' },
      CommandResult: { seq: 'u32', result: role(r.result) },
      Update: { sub: 'u32', version: 'u64', hash: 'String', patch: netType.vec('PatchOp') },
      Resync: { sub: 'u32', version: 'u64', hash: 'String', result: 'Bytes' },
      QueryFailed: { sub: 'u32', reason: 'String' },
      Clock: { time: 'u64', paused: 'bool' },
      Pong: { client_time: 'u64', time: 'u64', paused: 'bool' },
      InterestRejected: { reason: 'String' },
      EntityStream: { data: 'Bytes' },
      PlayerState: { seq: 'u32', state: role(r.state), tick_us: 'u32' },
      Control: { driving: 'bool' },
      Closed: { code: closeCode, reason: 'String' },
      Bulk: { codec: 'u8', data: 'Bytes' },
      Game: [role(r.server)],
    },
    ['Welcome', 'Rejected', 'Pong', 'Closed'],
    e.server ? r.server : undefined,
  );
  const env: Record<string, TypeDefSpec> = {
    ClientMsg: { enum: client.variants },
    Resume: { struct: { version: 'u64', hash: 'String' } },
    Empty: { struct: {} },
    ServerMsg: { enum: server.variants },
    PatchOp: {
      enum: {
        Set: { path: netType.vec('PathStep'), value: 'Bytes' },
        MapPut: { path: netType.vec('PathStep'), key: 'Bytes', value: 'Bytes' },
        MapRemove: { path: netType.vec('PathStep'), key: 'Bytes' },
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
  // The envelope's own types only when something reaches them, so no stray type is listed.
  for (const name of ['Empty', 'Resume', 'PatchOp', 'PathStep']) {
    if (!reached(types, desc, name)) delete types[name];
  }
  const schema = new NetSchema(WIRE_HEADER, {
    roots: ['ClientMsg', 'ServerMsg', ...(desc.roots ?? [])],
    types,
    queries: desc.queries,
  });
  if (e.client || e.server || e.ack || e.close) {
    infos.set(schema, {
      ack,
      clientGame: new Set(client.game),
      serverGame: new Set(server.game),
      closeCodes,
    });
  }
  return schema;
}

/** Whether a type spec names `name`, at any depth. */
function mentions(spec: TypeSpec, name: string): boolean {
  if (typeof spec === 'string') return spec === name;
  if ('vec' in spec) return mentions(spec.vec, name);
  if ('option' in spec) return mentions(spec.option, name);
  if ('map' in spec) return mentions(spec.map[0], name) || mentions(spec.map[1], name);
  return spec.named === name;
}

/** Whether any type, root or query other than `name` itself names `name`. */
function reached(
  types: Readonly<Record<string, TypeDefSpec>>,
  desc: SchemaDesc,
  name: string,
): boolean {
  const inVariant = (v: VariantSpec): boolean =>
    v !== null && (Array.isArray(v) ? mentions(v[0] as TypeSpec, name) : inFields(v as FieldSpecs));
  const inFields = (f: FieldSpecs): boolean => Object.values(f).some((t) => mentions(t, name));
  for (const [n, def] of Object.entries(types)) {
    if (n === name) continue;
    if ('struct' in def && inFields(def.struct)) return true;
    if ('newtype' in def && mentions(def.newtype, name)) return true;
    if ('enum' in def && Object.values(def.enum).some(inVariant)) return true;
  }
  if ((desc.roots ?? []).includes(name)) return true;
  for (const q of Object.values(desc.queries ?? {})) {
    if (mentions(q.result, name) || (q.args && inFields(q.args))) return true;
  }
  return false;
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
  | { type: 'Resync'; sub: number; version: number; hash: string; result: Uint8Array }
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
