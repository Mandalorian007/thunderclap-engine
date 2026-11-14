// Rust parity: vectors the Rust crates wrote (crates/tc-wire/tests/net.rs)
// from derived types, generics included. This runtime must build the same
// schema text and hash from their description, decode every value to the
// JSON shape listed, and encode it back to the same bytes.
import { describe, expect, it } from 'vitest';
import { defineTypes, type TypeSpec, type TypesDesc } from './schema';
import vectors from './testdata/wire-rust.json';
import { Fixed } from './wire';

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A decoded value in the vectors' JSON shape. */
function toJson(v: unknown): unknown {
  if (v instanceof Fixed) return { $fixed: v.bits.toString() };
  if (v instanceof Uint8Array) return { $bytes: toHex(v) };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [toJson(k), toJson(x)]) };
  if (Array.isArray(v)) return v.map(toJson);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  }
  return v;
}

/** A value from the vectors' JSON shape. */
function fromJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromJson);
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$fixed === 'string') return Fixed.fromBits(BigInt(o.$fixed));
  if (typeof o.$bytes === 'string') return fromHex(o.$bytes);
  if (Array.isArray(o.$map)) {
    return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [fromJson(k), fromJson(x)]));
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fromJson(x)]));
}

describe('Rust wire vectors', () => {
  const schema = defineTypes(vectors.desc as unknown as TypesDesc);

  it('builds the same schema text and hash', () => {
    expect(schema.text).toBe(vectors.text);
    expect(schema.hash).toBe(vectors.hash);
  });

  it('decodes and encodes every value byte for byte', () => {
    expect(vectors.cases.length).toBeGreaterThan(8);
    for (const c of vectors.cases) {
      const ty = c.ty as TypeSpec;
      const value = schema.decode(ty, fromHex(c.hex));
      expect(toJson(value), c.name).toEqual(c.value);
      expect(toHex(schema.encode(ty, fromJson(c.value))), c.name).toBe(c.hex);
    }
  });
});
