/**
 * Game-declared message schemas: the TypeScript side of the wire contract.
 *
 * A schema is a set of named types (structs, newtypes, enums) reached from its roots and live
 * queries. It has a canonical text (every name, field and variant in discovery order) and a hash of
 * that text; the client sends the hash in `Hello` and the server refuses a mismatch, so both sides
 * always speak the same layout. The text and hash are exactly what a server deriving the same types
 * computes (see `docs/design/2.0/server.md` §3), so the schema is the contract, not either language.
 *
 * Values are plain JavaScript, as generated code would use: integers are numbers, `Fixed` is the
 * `Fixed` class, `String` a string, `Bytes` a Uint8Array, `Vec` an array, `Option` the value or
 * `null`, `Map` a Map, a struct an object with camelCase field names, a newtype its inner value, and
 * an enum `{ type: 'Variant', ...fields }` (a one-value variant is `{ type, value }`).
 */

import { stableHash } from './hash';
import { DecodeError, type Fixed, type MapKey, Reader, Writer } from './wire';

/** The encoding rules' own version; part of the hashed text. */
export const WIRE_FORMAT = 2;
/** The first line of the canonical text. */
export const WIRE_HEADER = `thunderclap-wire ${WIRE_FORMAT}`;

/** A scalar type. */
export type Scalar =
  | 'bool'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'i32'
  | 'i64'
  | 'Fixed'
  | 'String'
  | 'Bytes';

/** A type reference, as data (the same shape a generated `TYPES` table uses). */
export type TypeRef =
  | Scalar
  | { readonly vec: TypeRef }
  | { readonly option: TypeRef }
  | { readonly map: readonly [TypeRef, TypeRef] }
  | { readonly named: string };

/** A type as written in a schema: a `TypeRef`, or a bare name for a named type. */
export type TypeSpec =
  | Scalar
  | string
  | { readonly vec: TypeSpec }
  | { readonly option: TypeSpec }
  | { readonly map: readonly [TypeSpec, TypeSpec] }
  | { readonly named: string };

/** Named fields, in wire order (object key order). Names are the wire names (snake_case). */
export type FieldSpecs = Readonly<Record<string, TypeSpec>>;

/** One enum variant: `null` (no payload), named fields, or `[T]` (one unnamed value). */
export type VariantSpec = null | FieldSpecs | readonly [TypeSpec];

/** A named type's definition. */
export type TypeDefSpec =
  | { readonly struct: FieldSpecs }
  | { readonly newtype: TypeSpec }
  | { readonly enum: Readonly<Record<string, VariantSpec>> };

/** A live query: its arguments (in order) and result. */
export interface QuerySpec {
  readonly args?: FieldSpecs;
  readonly result: TypeSpec;
}

/** A named type's shape, as data: what `applyPatch` and `diffValues` walk. */
export type TypeShape =
  | { readonly struct: readonly TypeRef[] }
  | { readonly newtype: TypeRef }
  | { readonly enum: readonly (readonly TypeRef[])[] };

/** Every named type's shape, by name. */
export type Types = Readonly<Record<string, TypeShape>>;

/** Builders for composite type references. */
export const netType = {
  vec: (inner: TypeSpec): TypeSpec => ({ vec: inner }),
  option: (inner: TypeSpec): TypeSpec => ({ option: inner }),
  map: (key: TypeSpec, value: TypeSpec): TypeSpec => ({ map: [key, value] }),
  named: (name: string): TypeSpec => ({ named: name }),
} as const;

/** A plain schema description: named types, roots and live queries. */
export interface TypesDesc {
  /** Every named type the roots and queries reach. Order does not matter; discovery decides it. */
  readonly types: Readonly<Record<string, TypeDefSpec>>;
  /** Root type names, in order. */
  readonly roots: readonly string[];
  /** Live queries, by snake_case wire name, in registration order. */
  readonly queries?: Readonly<Record<string, QuerySpec>>;
}

/** A value encoder and decoder for one type. */
export interface Codec<T = unknown> {
  encode(w: Writer, value: T): void;
  decode(r: Reader): T;
}

interface Field {
  readonly wire: string;
  readonly prop: string;
  readonly ty: TypeRef;
}

type Kind =
  | { readonly kind: 'struct'; readonly fields: readonly Field[] }
  | { readonly kind: 'newtype'; readonly inner: TypeRef }
  | {
      readonly kind: 'enum';
      readonly variants: readonly {
        readonly name: string;
        readonly shape: 'unit' | 'named' | 'newtype';
        readonly fields: readonly Field[];
      }[];
    };

interface Def {
  readonly name: string;
  readonly kind: Kind;
}

/** A query as built: arguments and result. */
export interface QueryDef {
  readonly name: string;
  readonly args: readonly { readonly name: string; readonly ty: TypeRef }[];
  readonly result: TypeRef;
}

const SCALARS: ReadonlySet<string> = new Set([
  'bool',
  'u8',
  'u16',
  'u32',
  'u64',
  'i32',
  'i64',
  'Fixed',
  'String',
  'Bytes',
]);
const KEY_SCALARS: ReadonlySet<string> = new Set([
  'u8',
  'u16',
  'u32',
  'u64',
  'i32',
  'i64',
  'String',
]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Thrown for a schema description that cannot be built. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** A field's JavaScript property name: snake_case to camelCase, as generated code names it. */
export function propName(wire: string): string {
  let out = '';
  let upper = false;
  for (const c of wire) {
    if (c === '_' && out.length > 0) upper = true;
    else if (upper) {
      out += c.toUpperCase();
      upper = false;
    } else out += c;
  }
  return out;
}

/** Normalizes a written type to a `TypeRef`. */
export function typeRef(spec: TypeSpec): TypeRef {
  if (typeof spec === 'string') return SCALARS.has(spec) ? (spec as Scalar) : { named: spec };
  if ('vec' in spec) return { vec: typeRef(spec.vec) };
  if ('option' in spec) return { option: typeRef(spec.option) };
  if ('map' in spec) return { map: [typeRef(spec.map[0]), typeRef(spec.map[1])] };
  if ('named' in spec) return { named: spec.named };
  throw new SchemaError(`not a type: ${JSON.stringify(spec)}`);
}

/** A type reference as the canonical text writes it. */
export function displayType(ty: TypeRef): string {
  if (typeof ty === 'string') return ty;
  if ('vec' in ty) return `Vec<${displayType(ty.vec)}>`;
  if ('option' in ty) return `Option<${displayType(ty.option)}>`;
  if ('map' in ty) return `Map<${displayType(ty.map[0])}, ${displayType(ty.map[1])}>`;
  return ty.named;
}

/** A built, checked schema: its canonical text, hash, shapes and value codecs. */
export class NetSchema {
  /** The canonical text the hash is computed from. */
  readonly text: string;
  /** 16 lowercase hex digits: the stable hash of `text`. */
  readonly hash: string;
  /** Root type names, in order. */
  readonly roots: readonly string[];
  /** Every named type's shape, by name. */
  readonly types: Types;
  /** Live queries by wire name. */
  readonly queries: ReadonlyMap<string, QueryDef>;
  readonly #defs: ReadonlyMap<string, Def>;
  readonly #codecs = new Map<string, Codec>();

  /** @internal Use `defineSchema` or `defineTypes`. */
  constructor(header: string, desc: TypesDesc) {
    const built = build(desc);
    this.roots = desc.roots.slice();
    this.#defs = built.defs;
    this.queries = built.queries;
    this.text = canonicalText(
      header,
      this.roots,
      [...built.defs.values()],
      [...built.queries.values()],
    );
    this.hash = stableHash(new TextEncoder().encode(this.text)).toString(16).padStart(16, '0');
    const types: Record<string, TypeShape> = {};
    for (const def of built.defs.values()) types[def.name] = shapeOf(def.kind);
    this.types = types;
  }

  /** The variant names of enum `name`, in index order. */
  variants(name: string): readonly string[] {
    const def = this.#defs.get(name);
    if (def?.kind.kind !== 'enum') throw new SchemaError(`${name} is not an enum`);
    return def.kind.variants.map((v) => v.name);
  }

  /** The fields of struct `name` in wire order: wire name, camelCase prop and type. */
  fields(
    name: string,
  ): readonly { readonly wire: string; readonly prop: string; readonly ty: TypeRef }[] {
    const def = this.#defs.get(name);
    if (def?.kind.kind !== 'struct') throw new SchemaError(`${name} is not a struct`);
    return def.kind.fields;
  }

  /** The codec for `ty` (compiled once per named type). */
  codec<T = unknown>(ty: TypeSpec): Codec<T> {
    return this.#codec(typeRef(ty)) as Codec<T>;
  }

  /** Encodes one value of `ty`. */
  encode(ty: TypeSpec, value: unknown): Uint8Array {
    const w = new Writer();
    this.codec(ty).encode(w, value);
    return w.finish();
  }

  /** Decodes exactly one value of `ty` from `bytes` (trailing bytes are an error). */
  decode<T = unknown>(ty: TypeSpec, bytes: Uint8Array): T {
    const r = new Reader(bytes);
    const value = this.codec<T>(ty).decode(r);
    r.finish();
    return value;
  }

  /** Encodes a query's arguments (an object with camelCase names) for `Subscribe`. */
  encodeArgs(query: string, args: Readonly<Record<string, unknown>> | undefined): Uint8Array {
    const q = this.queries.get(query);
    if (!q) throw new SchemaError(`no query named ${query}`);
    const w = new Writer();
    for (const a of q.args) this.#codec(a.ty).encode(w, args?.[propName(a.name)]);
    return w.finish();
  }

  #codec(ty: TypeRef): Codec {
    if (typeof ty === 'string') return SCALAR_CODECS[ty];
    if ('vec' in ty) {
      const inner = this.#codec(ty.vec);
      return {
        encode: (w, v) => w.vec(v as unknown[], (x) => inner.encode(w, x)),
        decode: (r) => r.vec(() => inner.decode(r)),
      };
    }
    if ('option' in ty) {
      const inner = this.#codec(ty.option);
      return {
        encode: (w, v) => w.option(v, (x) => inner.encode(w, x)),
        decode: (r) => r.option(() => inner.decode(r)),
      };
    }
    if ('map' in ty) {
      const key = this.#codec(ty.map[0]) as Codec<MapKey>;
      const value = this.#codec(ty.map[1]);
      return {
        encode: (w, v) =>
          w.map(
            v as Map<MapKey, unknown>,
            (k) => key.encode(w, k),
            (x) => value.encode(w, x),
          ),
        decode: (r) =>
          r.map(
            () => key.decode(r),
            () => value.decode(r),
          ),
      };
    }
    const name = ty.named;
    const cached = this.#codecs.get(name);
    if (cached) return cached;
    // An indirection first, so recursive types compile.
    let real: Codec | undefined;
    const lazy: Codec = {
      encode: (w, v) => real!.encode(w, v),
      decode: (r) => real!.decode(r),
    };
    this.#codecs.set(name, lazy);
    const def = this.#defs.get(name);
    if (!def) throw new SchemaError(`unknown type ${name}`);
    real = this.#compile(def);
    this.#codecs.set(name, real);
    return real;
  }

  #compile(def: Def): Codec {
    const kind = def.kind;
    if (kind.kind === 'newtype') return this.#codec(kind.inner);
    if (kind.kind === 'struct') return this.#fields(def.name, kind.fields, null);
    const name = def.name;
    const byName = new Map<string, { index: number; codec: Codec | null }>();
    const decoders: (Codec | null)[] = [];
    kind.variants.forEach((v, index) => {
      const codec =
        v.shape === 'unit'
          ? null
          : v.shape === 'newtype'
            ? this.#newtypeVariant(v.name, v.fields[0]!.ty)
            : this.#fields(`${name}::${v.name}`, v.fields, v.name);
      byName.set(v.name, { index, codec });
      decoders.push(codec);
    });
    const names = kind.variants.map((v) => v.name);
    return {
      encode: (w, value) => {
        const tag = (value as { type?: unknown } | null)?.type;
        const entry = typeof tag === 'string' ? byName.get(tag) : undefined;
        if (!entry) throw new TypeError(`${name}: unknown variant type ${JSON.stringify(tag)}`);
        w.variant(entry.index);
        entry.codec?.encode(w, value);
      },
      decode: (r) => {
        const at = r.position;
        const index = r.variant();
        if (index >= names.length)
          throw new DecodeError(at, `unknown variant ${index} for ${name}`);
        const codec = decoders[index];
        return codec ? codec.decode(r) : { type: names[index] };
      },
    };
  }

  #newtypeVariant(tag: string, ty: TypeRef): Codec {
    const inner = this.#codec(ty);
    return {
      encode: (w, v) => inner.encode(w, (v as { value: unknown }).value),
      decode: (r) => ({ type: tag, value: inner.decode(r) }),
    };
  }

  #fields(context: string, fields: readonly Field[], tag: string | null): Codec {
    const codecs = fields.map((f) => this.#codec(f.ty));
    const props = fields.map((f) => f.prop);
    const n = fields.length;
    return {
      encode: (w, v) => {
        if (v === null || typeof v !== 'object') {
          throw new TypeError(`${context}: expected an object, got ${String(v)}`);
        }
        const o = v as Record<string, unknown>;
        for (let i = 0; i < n; i++) codecs[i]!.encode(w, o[props[i]!]);
      },
      decode: (r) => {
        const o: Record<string, unknown> = tag === null ? {} : { type: tag };
        for (let i = 0; i < n; i++) o[props[i]!] = codecs[i]!.decode(r);
        return o;
      },
    };
  }
}

const SCALAR_CODECS: Record<Scalar, Codec> = {
  bool: { encode: (w, v) => w.bool(v as boolean), decode: (r) => r.bool() },
  u8: { encode: (w, v) => w.u8(v as number), decode: (r) => r.u8() },
  u16: { encode: (w, v) => w.u16(v as number), decode: (r) => r.u16() },
  u32: { encode: (w, v) => w.u32(v as number), decode: (r) => r.u32() },
  u64: { encode: (w, v) => w.u64(v as number), decode: (r) => r.u64() },
  i32: { encode: (w, v) => w.i32(v as number), decode: (r) => r.i32() },
  i64: { encode: (w, v) => w.i64(v as number), decode: (r) => r.i64() },
  Fixed: { encode: (w, v) => w.fixed(v as Fixed), decode: (r) => r.fixed() },
  String: { encode: (w, v) => w.string(v as string), decode: (r) => r.string() },
  Bytes: { encode: (w, v) => w.bytes(v as Uint8Array), decode: (r) => r.bytes() },
};

/**
 * Builds a plain schema: named types reached from `roots` and `queries`, with the engine's header.
 * Most games want `defineSchema` (in `envelope`), which wraps their types in the engine envelope.
 */
export function defineTypes(desc: TypesDesc): NetSchema {
  return new NetSchema(WIRE_HEADER, desc);
}

/** @internal Builds with another header line: the parity test checks the text against the original. */
export function defineTypesWithHeader(header: string, desc: TypesDesc): NetSchema {
  return new NetSchema(header, desc);
}

function build(desc: TypesDesc): {
  defs: Map<string, Def>;
  queries: Map<string, QueryDef>;
} {
  const defs = new Map<string, Def | null>();
  const discover = (ty: TypeRef, context: string): void => {
    if (typeof ty === 'string') return;
    if ('vec' in ty) {
      discover(ty.vec, context);
      return;
    }
    if ('option' in ty) {
      discover(ty.option, context);
      return;
    }
    if ('map' in ty) {
      discover(ty.map[0], context);
      discover(ty.map[1], context);
      return;
    }
    define(ty.named, context);
  };
  const fieldsOf = (context: string, specs: FieldSpecs): Field[] => {
    const fields: Field[] = [];
    for (const [wire, spec] of Object.entries(specs)) {
      if (!IDENT.test(wire))
        throw new SchemaError(`${context}: field name ${JSON.stringify(wire)}`);
      fields.push({ wire, prop: propName(wire), ty: typeRef(spec) });
    }
    const props = new Set(fields.map((f) => f.prop));
    if (props.size !== fields.length) {
      throw new SchemaError(`${context}: two fields share a name (after camelCase)`);
    }
    return fields;
  };
  const define = (name: string, context: string): void => {
    if (defs.has(name)) return;
    const spec = desc.types[name];
    if (!spec || !Object.hasOwn(desc.types, name)) {
      throw new SchemaError(`${context}: unknown type ${name}`);
    }
    if (!IDENT.test(name) || SCALARS.has(name)) throw new SchemaError(`bad type name ${name}`);
    // Reserve the slot first: discovery order is depth-first, the parent before its parts.
    defs.set(name, null);
    let kind: Kind;
    if ('struct' in spec) {
      const fields = fieldsOf(name, spec.struct);
      kind = { kind: 'struct', fields };
      for (const f of fields) discover(f.ty, `${name}.${f.wire}`);
    } else if ('newtype' in spec) {
      const inner = typeRef(spec.newtype);
      kind = { kind: 'newtype', inner };
      discover(inner, name);
    } else if ('enum' in spec) {
      const variants: Extract<Kind, { kind: 'enum' }>['variants'][number][] = [];
      for (const [vname, v] of Object.entries(spec.enum)) {
        if (!IDENT.test(vname)) throw new SchemaError(`${name}: variant name ${vname}`);
        if (v === null) variants.push({ name: vname, shape: 'unit', fields: [] });
        else if (Array.isArray(v)) {
          const ty = typeRef((v as readonly [TypeSpec])[0]);
          variants.push({
            name: vname,
            shape: 'newtype',
            fields: [{ wire: '0', prop: 'value', ty }],
          });
          discover(ty, `${name}::${vname}`);
        } else {
          const fields = fieldsOf(`${name}::${vname}`, v as FieldSpecs);
          variants.push({ name: vname, shape: 'named', fields });
          for (const f of fields) discover(f.ty, `${name}::${vname}.${f.wire}`);
        }
      }
      kind = { kind: 'enum', variants };
    } else {
      throw new SchemaError(`${name}: a definition is { struct }, { newtype } or { enum }`);
    }
    defs.set(name, { name, kind });
  };
  for (const root of desc.roots) define(root, 'root');
  const queries = new Map<string, QueryDef>();
  for (const [qname, q] of Object.entries(desc.queries ?? {})) {
    if (!/^[a-z_][a-z0-9_]*$/.test(qname)) {
      throw new SchemaError(`query \`${qname}\`: names are snake_case identifiers`);
    }
    const args = Object.entries(q.args ?? {}).map(([name, spec]) => ({ name, ty: typeRef(spec) }));
    for (const a of args) discover(a.ty, `query ${qname}(${a.name})`);
    const result = typeRef(q.result);
    discover(result, `query ${qname} result`);
    queries.set(qname, { name: qname, args, result });
  }
  const unused = Object.keys(desc.types).filter((n) => !defs.has(n));
  if (unused.length > 0) {
    throw new SchemaError(`types not reached from a root or query: ${unused.join(', ')}`);
  }
  const done = defs as Map<string, Def>;
  validate(done, queries);
  return { defs: done, queries };
}

function resolve(defs: ReadonlyMap<string, Def>, ty: TypeRef): TypeRef {
  while (typeof ty === 'object' && 'named' in ty) {
    const def = defs.get(ty.named);
    if (def?.kind.kind !== 'newtype') break;
    ty = def.kind.inner;
  }
  return ty;
}

function validate(defs: ReadonlyMap<string, Def>, queries: ReadonlyMap<string, QueryDef>): void {
  const check = (context: string, ty: TypeRef): void => {
    if (typeof ty === 'string' || 'named' in ty) return;
    if ('vec' in ty) {
      check(context, ty.vec);
      return;
    }
    if ('map' in ty) {
      const key = resolve(defs, ty.map[0]);
      if (typeof key !== 'string' || !KEY_SCALARS.has(key)) {
        throw new SchemaError(
          `${context}: map key \`${displayType(ty.map[0])}\` must be an integer, a string, or a newtype of one`,
        );
      }
      check(context, ty.map[1]);
      return;
    }
    const inner = resolve(defs, ty.option);
    if (typeof inner === 'object' && 'option' in inner) {
      throw new SchemaError(`${context}: \`${displayType(ty)}\` nests options; use an enum`);
    }
    check(context, ty.option);
  };
  for (const q of queries.values()) {
    for (const a of q.args) check(`query ${q.name}(${a.name})`, a.ty);
    check(`query ${q.name} result`, q.result);
  }
  for (const def of defs.values()) {
    const k = def.kind;
    if (k.kind === 'struct') for (const f of k.fields) check(`${def.name}.${f.wire}`, f.ty);
    else if (k.kind === 'newtype') check(def.name, k.inner);
    else
      for (const v of k.variants)
        for (const f of v.fields) check(`${def.name}::${v.name}.${f.wire}`, f.ty);
  }
}

function renderFields(fields: readonly { readonly wire: string; readonly ty: TypeRef }[]): string {
  return `{ ${fields.map((f) => `${f.wire}: ${displayType(f.ty)}`).join(', ')} }`;
}

/** The canonical text: header, roots, queries, then every type in discovery order. */
function canonicalText(
  header: string,
  roots: readonly string[],
  defs: readonly Def[],
  queries: readonly QueryDef[],
): string {
  let out = `${header}\n`;
  for (const root of roots) out += `root ${root}\n`;
  for (const q of queries) {
    const args = q.args.map((a) => `${a.name}: ${displayType(a.ty)}`).join(', ');
    out += `query ${q.name}(${args}) -> ${displayType(q.result)}\n`;
  }
  for (const def of defs) {
    const k = def.kind;
    if (k.kind === 'struct') out += `struct ${def.name} ${renderFields(k.fields)}\n`;
    else if (k.kind === 'newtype') out += `newtype ${def.name}(${displayType(k.inner)})\n`;
    else {
      out += `enum ${def.name} {\n`;
      for (const v of k.variants) {
        if (v.shape === 'unit') out += `  ${v.name}\n`;
        else if (v.shape === 'newtype') out += `  ${v.name}(${displayType(v.fields[0]!.ty)})\n`;
        else out += `  ${v.name} ${renderFields(v.fields)}\n`;
      }
      out += '}\n';
    }
  }
  return out;
}

function shapeOf(kind: Kind): TypeShape {
  if (kind.kind === 'struct') return { struct: kind.fields.map((f) => f.ty) };
  if (kind.kind === 'newtype') return { newtype: kind.inner };
  return { enum: kind.variants.map((v) => v.fields.map((f) => f.ty)) };
}
