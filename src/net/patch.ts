/**
 * Patches: how a live query's result changes on the wire.
 *
 * A result is kept as its encoded bytes. A patch is a list of ops, each addressed by a path from
 * the root of the value: a struct field by index, an enum field within the value's current variant,
 * a present option's value, or a map entry's value by its encoded key. `applyPatch` walks the bytes
 * with the schema's shapes and rebuilds them with each op applied, validating everything exactly as
 * decoding does. `diffValues` is the other half, for an authority written in TypeScript: the
 * smallest patch the server's structural diff would send. Nothing here is specific to any game.
 */

import type { TypeRef, Types } from './schema';
import { compareKeys, type MapKey, Reader, Writer } from './wire';

/** One step of a patch path. */
export type PathStep =
  | { readonly type: 'Field'; readonly index: number }
  | { readonly type: 'Variant'; readonly variant: number; readonly field: number }
  | { readonly type: 'Entry'; readonly key: Uint8Array }
  | { readonly type: 'Present' };

/** One patch op. */
export type PatchOp =
  | { readonly type: 'Set'; readonly path: readonly PathStep[]; readonly value: Uint8Array }
  | {
      readonly type: 'MapPut';
      readonly path: readonly PathStep[];
      readonly key: Uint8Array;
      readonly value: Uint8Array;
    }
  | { readonly type: 'MapRemove'; readonly path: readonly PathStep[]; readonly key: Uint8Array };

/** Thrown when a patch doesn't fit the value it is applied to. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/**
 * Applies `ops` in order to `old`, an encoding of `ty`, and returns the new encoding. Throws
 * `PatchError` (or `DecodeError`) if anything doesn't fit.
 */
export function applyPatch(
  types: Types,
  ty: TypeRef,
  old: Uint8Array,
  ops: readonly PatchOp[],
): Uint8Array {
  const walk = new Walk(types);
  walk.check(ty, old);
  let current = old;
  for (const op of ops) current = walk.apply(ty, current, op);
  walk.check(ty, current);
  return current;
}

/**
 * The patch that turns `old` into `next`, both encodings of `ty`: empty if they are equal. Picks
 * finer ops only where they encode smaller than a whole `Set`, as the server's diff does.
 */
export function diffValues(
  types: Types,
  ty: TypeRef,
  old: Uint8Array,
  next: Uint8Array,
): PatchOp[] {
  const walk = new Walk(types);
  walk.check(ty, old);
  walk.check(ty, next);
  const out: PatchOp[] = [];
  walk.diff(ty, old, next, [], out);
  return out;
}

/** Encodes patch ops exactly as the envelope's `Vec<PatchOp>` items do. */
export function writePatchOp(w: Writer, op: PatchOp): void {
  const path = (steps: readonly PathStep[]) =>
    w.vec(steps, (s) => {
      switch (s.type) {
        case 'Field':
          w.variant(0);
          w.u32(s.index);
          return;
        case 'Variant':
          w.variant(1);
          w.u32(s.variant);
          w.u32(s.field);
          return;
        case 'Entry':
          w.variant(2);
          w.bytes(s.key);
          return;
        case 'Present':
          w.variant(3);
          return;
      }
    });
  switch (op.type) {
    case 'Set':
      w.variant(0);
      path(op.path);
      w.bytes(op.value);
      return;
    case 'MapPut':
      w.variant(1);
      path(op.path);
      w.bytes(op.key);
      w.bytes(op.value);
      return;
    case 'MapRemove':
      w.variant(2);
      path(op.path);
      w.bytes(op.key);
      return;
  }
}

function encodedLen(ops: readonly PatchOp[]): number {
  const w = new Writer();
  for (const op of ops) writePatchOp(w, op);
  return w.finish().length;
}

type Shape =
  | { kind: 'scalar' }
  | { kind: 'struct'; fields: readonly TypeRef[] }
  | { kind: 'enum'; name: string; variants: readonly (readonly TypeRef[])[] }
  | { kind: 'option'; inner: TypeRef }
  | { kind: 'vec'; inner: TypeRef }
  | { kind: 'map'; key: TypeRef; value: TypeRef };

interface Entry {
  key: MapKey;
  keyBytes: Uint8Array;
  value: Uint8Array;
}

class Walk {
  readonly #types: Types;

  constructor(types: Types) {
    this.#types = types;
  }

  /** Follows newtypes. */
  resolve(ty: TypeRef): TypeRef {
    while (typeof ty === 'object' && 'named' in ty) {
      const shape = this.#types[ty.named];
      if (!shape || !('newtype' in shape)) break;
      ty = shape.newtype;
    }
    return ty;
  }

  shape(ty: TypeRef): Shape {
    const t = this.resolve(ty);
    if (typeof t === 'string') return { kind: 'scalar' };
    if ('vec' in t) return { kind: 'vec', inner: t.vec };
    if ('option' in t) return { kind: 'option', inner: t.option };
    if ('map' in t) return { kind: 'map', key: t.map[0], value: t.map[1] };
    const shape = this.#types[t.named];
    if (!shape) throw new PatchError(`unknown type ${t.named}`);
    if ('struct' in shape) return { kind: 'struct', fields: shape.struct };
    if ('enum' in shape) return { kind: 'enum', name: t.named, variants: shape.enum };
    throw new PatchError(`unknown type ${t.named}`);
  }

  /** Requires `bytes` to be exactly one valid encoding of `ty`. */
  check(ty: TypeRef, bytes: Uint8Array): void {
    const r = new Reader(bytes);
    this.skip(ty, r);
    r.finish();
  }

  /** Reads past one value of `ty`, validating it exactly as decoding does. */
  skip(ty: TypeRef, r: Reader): void {
    const t = this.resolve(ty);
    if (typeof t === 'string') {
      switch (t) {
        case 'bool':
          r.bool();
          return;
        case 'u8':
          r.u8();
          return;
        case 'u16':
          r.u16();
          return;
        case 'u32':
          r.u32();
          return;
        case 'u64':
          r.u64();
          return;
        case 'i32':
          r.i32();
          return;
        case 'i64':
          r.i64();
          return;
        case 'Fixed':
          r.fixed();
          return;
        case 'String':
          r.string();
          return;
        case 'Bytes':
          r.bytes();
          return;
      }
    }
    const shape = this.shape(t);
    switch (shape.kind) {
      case 'vec':
        r.vec(() => this.skip(shape.inner, r));
        return;
      case 'option':
        r.option(() => this.skip(shape.inner, r));
        return;
      case 'map':
        r.map(
          () => this.readKey(shape.key, r),
          () => this.skip(shape.value, r),
        );
        return;
      case 'struct':
        for (const field of shape.fields) this.skip(field, r);
        return;
      case 'enum':
        for (const field of this.variantFields(shape, r)[1]) this.skip(field, r);
        return;
      case 'scalar':
        throw new PatchError(`unknown scalar type ${String(t)}`);
    }
  }

  variantFields(shape: Shape & { kind: 'enum' }, r: Reader): [number, readonly TypeRef[]] {
    const index = r.variant();
    const fields = shape.variants[index];
    if (!fields) throw r.unknownVariant(shape.name);
    return [index, fields];
  }

  readKey(ty: TypeRef, r: Reader): MapKey {
    const t = this.resolve(ty);
    switch (t) {
      case 'u8':
        return r.u8();
      case 'u16':
        return r.u16();
      case 'u32':
        return r.u32();
      case 'u64':
        return r.u64();
      case 'i32':
        return r.i32();
      case 'i64':
        return r.i64();
      case 'String':
        return r.string();
      default:
        throw new PatchError(`${JSON.stringify(t)} cannot be a map key`);
    }
  }

  /** The spans of consecutive values of `types` that make up `bytes`. */
  split(types: readonly TypeRef[], bytes: Uint8Array): Uint8Array[] {
    const r = new Reader(bytes);
    const spans = types.map((ty) => {
      const start = r.position;
      this.skip(ty, r);
      return bytes.subarray(start, r.position);
    });
    r.finish();
    return spans;
  }

  entries(key: TypeRef, value: TypeRef, bytes: Uint8Array): Entry[] {
    const r = new Reader(bytes);
    const count = r.count();
    const entries: Entry[] = [];
    for (let i = 0; i < count; i++) {
      const keyStart = r.position;
      const k = this.readKey(key, r);
      const keyBytes = bytes.subarray(keyStart, r.position);
      const start = r.position;
      this.skip(value, r);
      entries.push({ key: k, keyBytes, value: bytes.subarray(start, r.position) });
    }
    r.finish();
    return entries;
  }

  diff(ty: TypeRef, old: Uint8Array, next: Uint8Array, path: PathStep[], out: PatchOp[]): void {
    if (sameBytes(old, next)) return;
    const finer: PatchOp[] = [];
    let structured = false;
    const shape = this.shape(ty);
    if (shape.kind === 'struct') {
      const o = this.split(shape.fields, old);
      const n = this.split(shape.fields, next);
      shape.fields.forEach((field, index) => {
        path.push({ type: 'Field', index });
        this.diff(field, o[index]!, n[index]!, path, finer);
        path.pop();
      });
      structured = true;
    } else if (shape.kind === 'enum') {
      const ro = new Reader(old);
      const rn = new Reader(next);
      const [vo, fields] = this.variantFields(shape, ro);
      const [vn] = this.variantFields(shape, rn);
      if (vo === vn && fields.length > 0) {
        const o = this.split(fields, old.subarray(ro.position));
        const n = this.split(fields, next.subarray(rn.position));
        fields.forEach((field, i) => {
          path.push({ type: 'Variant', variant: vo, field: i });
          this.diff(field, o[i]!, n[i]!, path, finer);
          path.pop();
        });
        structured = true;
      }
    } else if (shape.kind === 'option') {
      if (old[0] === 1 && next[0] === 1) {
        path.push({ type: 'Present' });
        this.diff(shape.inner, old.subarray(1), next.subarray(1), path, finer);
        path.pop();
        structured = true;
      }
    } else if (shape.kind === 'map') {
      const o = this.entries(shape.key, shape.value, old);
      const n = this.entries(shape.key, shape.value, next);
      let i = 0;
      let j = 0;
      while (i < o.length || j < n.length) {
        const a = o[i];
        const b = n[j];
        const order = a && b ? compareKeys(a.key, b.key) : a ? -1 : 1;
        if (order < 0) {
          finer.push({ type: 'MapRemove', path: path.slice(), key: a!.keyBytes.slice() });
          i++;
        } else if (order > 0) {
          finer.push({
            type: 'MapPut',
            path: path.slice(),
            key: b!.keyBytes.slice(),
            value: b!.value.slice(),
          });
          j++;
        } else {
          path.push({ type: 'Entry', key: b!.keyBytes.slice() });
          this.diff(shape.value, a!.value, b!.value, path, finer);
          path.pop();
          i++;
          j++;
        }
      }
      structured = true;
    }
    const set: PatchOp = { type: 'Set', path: path.slice(), value: next.slice() };
    if (structured && encodedLen(finer) < encodedLen([set])) out.push(...finer);
    else out.push(set);
  }

  apply(ty: TypeRef, bytes: Uint8Array, op: PatchOp): Uint8Array {
    switch (op.type) {
      case 'Set':
        return this.rewrite(ty, bytes, op.path, (at) => {
          this.check(at, op.value);
          return op.value;
        });
      case 'MapPut':
        return this.rewrite(ty, bytes, op.path, (at, current) => {
          const shape = this.shape(at);
          if (shape.kind !== 'map')
            throw new PatchError(`MapPut on ${JSON.stringify(at)}, which is not a map`);
          const r = new Reader(op.key);
          const key = this.readKey(shape.key, r);
          r.finish();
          this.check(shape.value, op.value);
          const entries = this.entries(shape.key, shape.value, current);
          const entry = { key, keyBytes: op.key, value: op.value };
          const i = entries.findIndex((e) => compareKeys(e.key, key) >= 0);
          if (i < 0) entries.push(entry);
          else if (compareKeys(entries[i]!.key, key) === 0) entries[i] = entry;
          else entries.splice(i, 0, entry);
          return encodeEntries(entries);
        });
      case 'MapRemove':
        return this.rewrite(ty, bytes, op.path, (at, current) => {
          const shape = this.shape(at);
          if (shape.kind !== 'map')
            throw new PatchError(`MapRemove on ${JSON.stringify(at)}, which is not a map`);
          const entries = this.entries(shape.key, shape.value, current);
          const i = entries.findIndex((e) => sameBytes(e.keyBytes, op.key));
          if (i < 0) throw new PatchError('MapRemove of an absent key');
          entries.splice(i, 1);
          return encodeEntries(entries);
        });
      default:
        throw new PatchError(`unknown patch op ${JSON.stringify((op as { type?: unknown }).type)}`);
    }
  }

  /** Rebuilds `bytes` (a `ty`) with the value at `path` replaced by `leaf(type, bytes)` there. */
  rewrite(
    ty: TypeRef,
    bytes: Uint8Array,
    path: readonly PathStep[],
    leaf: (ty: TypeRef, bytes: Uint8Array) => Uint8Array,
  ): Uint8Array {
    const [step, ...rest] = path;
    if (!step) return leaf(ty, bytes);
    const shape = this.shape(ty);
    const mismatch = () =>
      new PatchError(`path step ${step.type} does not fit ${JSON.stringify(ty)}`);
    switch (step.type) {
      case 'Field': {
        if (shape.kind !== 'struct') throw mismatch();
        const field = shape.fields[step.index];
        if (!field) throw mismatch();
        const spans = this.split(shape.fields, bytes);
        spans[step.index] = this.rewrite(field, spans[step.index]!, rest, leaf);
        return concat(spans);
      }
      case 'Variant': {
        if (shape.kind !== 'enum') throw mismatch();
        const r = new Reader(bytes);
        const [index, fields] = this.variantFields(shape, r);
        if (index !== step.variant) {
          throw new PatchError(
            `path expects variant ${step.variant} of ${shape.name}, the value is variant ${index}`,
          );
        }
        const field = fields[step.field];
        if (!field) throw mismatch();
        const head = bytes.subarray(0, r.position);
        const spans = this.split(fields, bytes.subarray(r.position));
        spans[step.field] = this.rewrite(field, spans[step.field]!, rest, leaf);
        return concat([head, ...spans]);
      }
      case 'Present': {
        if (shape.kind !== 'option') throw mismatch();
        if (bytes[0] !== 1) throw new PatchError('path goes into an absent option');
        return concat([
          bytes.subarray(0, 1),
          this.rewrite(shape.inner, bytes.subarray(1), rest, leaf),
        ]);
      }
      case 'Entry': {
        if (shape.kind !== 'map') throw mismatch();
        const entries = this.entries(shape.key, shape.value, bytes);
        const entry = entries.find((e) => sameBytes(e.keyBytes, step.key));
        if (!entry) throw new PatchError('path names an absent map key');
        entry.value = this.rewrite(shape.value, entry.value, rest, leaf);
        return encodeEntries(entries);
      }
      default:
        throw new PatchError(
          `unknown path step ${JSON.stringify((step as { type?: unknown }).type)}`,
        );
    }
  }
}

function encodeEntries(entries: readonly Entry[]): Uint8Array {
  const w = new Writer();
  w.u64(entries.length);
  for (const e of entries) {
    w.raw(e.keyBytes);
    w.raw(e.value);
  }
  return w.finish();
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
