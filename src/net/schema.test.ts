import { describe, expect, it } from 'vitest';
import { hashHex, resultHash, stableHash } from './hash';
import {
  defineTypes,
  defineTypesWithHeader,
  netType,
  propName,
  SchemaError,
  type TypesDesc,
} from './schema';
import hashVectors from './testdata/hash.json';
import schemaVectors from './testdata/schema.json';
import { Fixed } from './wire';

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

// The original test types: enum Root { A { x: u32, y: Inner }, B, C(Id) }, Inner, Id(u64).
const base: TypesDesc = {
  roots: ['Root'],
  types: {
    Id: { newtype: 'u64' },
    Inner: { struct: { a: 'i32', b: netType.option('String') } },
    Root: { enum: { A: { x: 'u32', y: 'Inner' }, B: null, C: ['Id'] } },
  },
};

describe('stable hash', () => {
  it('matches the server for every vector', () => {
    expect(hashVectors.length).toBeGreaterThan(10);
    for (const v of hashVectors) expect(hashHex(stableHash(fromHex(v.bytes)))).toBe(v.hash);
    expect(resultHash(new Uint8Array(0))).toBe('0397ab29740681d9');
  });
});

describe('schema', () => {
  it('writes the original canonical text exactly, under its header', () => {
    const s = defineTypesWithHeader('forge-wire 2', base);
    expect(s.text).toBe(
      'forge-wire 2\nroot Root\nenum Root {\n  A { x: u32, y: Inner }\n  B\n  C(Id)\n}\nstruct Inner { a: i32, b: Option<String> }\nnewtype Id(u64)\n',
    );
    // The server's StableHasher over that text (computed in Rust).
    expect(s.hash).toBe('f5fdfd2f9a7219a0');
  });

  it('matches the shared vectors (text and hash, for the server to reuse)', () => {
    for (const v of schemaVectors) {
      const s = defineTypes(v.desc as unknown as TypesDesc);
      expect(s.text).toBe(v.text);
      expect(s.hash).toBe(v.hash);
    }
  });

  it('uses the engine header and changes the hash with any change', () => {
    const s = defineTypes(base);
    expect(s.text.startsWith('thunderclap-wire 2\n')).toBe(true);
    expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    const variants: TypesDesc[] = [
      { ...base, types: { ...base.types, Id: { newtype: 'i64' } } },
      {
        ...base,
        types: { ...base.types, Inner: { struct: { b: netType.option('String'), a: 'i32' } } },
      },
      {
        ...base,
        types: { ...base.types, Root: { enum: { A: { x: 'u32', y: 'Inner' }, B: {}, C: ['Id'] } } },
      },
      { ...base, queries: { board: { result: 'Id' } } },
    ];
    const hashes = new Set([s.hash, ...variants.map((d) => defineTypes(d).hash)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it('lists types in discovery order and queries after roots', () => {
    const s = defineTypes({
      roots: ['A'],
      types: {
        C: { struct: {} },
        B: { struct: { c: 'C' } },
        A: { struct: { b: 'B', m: netType.map('u32', netType.vec('Bytes')) } },
        Q: { newtype: 'String' },
      },
      queries: { find: { args: { name: 'Q', at: 'Fixed' }, result: netType.option('B') } },
    });
    expect(s.text).toBe(
      'thunderclap-wire 2\nroot A\nquery find(name: Q, at: Fixed) -> Option<B>\nstruct A { b: B, m: Map<u32, Vec<Bytes>> }\nstruct B { c: C }\nstruct C {  }\nnewtype Q(String)\n',
    );
  });

  it('rejects bad schemas', () => {
    const bad = (desc: TypesDesc) => () => defineTypes(desc);
    expect(bad({ roots: ['X'], types: {} })).toThrow(SchemaError);
    expect(bad({ ...base, types: { ...base.types, Extra: { newtype: 'u8' } } })).toThrow(
      /not reached/,
    );
    expect(bad({ ...base, queries: { Board: { result: 'u8' } } })).toThrow(/snake_case/);
    expect(
      bad({ roots: ['M'], types: { M: { struct: { m: netType.map('Fixed', 'u8') } } } }),
    ).toThrow(/map key/);
    expect(
      bad({ roots: ['M'], types: { M: { struct: { o: netType.option(netType.option('u8')) } } } }),
    ).toThrow(/nests options/);
    expect(bad({ roots: ['M'], types: { M: { struct: { a_b: 'u8', aB: 'u8' } } } })).toThrow(
      /share a name/,
    );
  });

  it('round-trips values with camelCase props, enums and maps', () => {
    const s = defineTypes({
      roots: ['Msg'],
      types: {
        Msg: {
          enum: {
            Hello: { player_name: 'String', at: 'Fixed', tags: netType.map('String', 'u16') },
            Bye: null,
            Raw: ['Bytes'],
            Many: [netType.vec(netType.option('i32'))],
          },
        },
      },
    });
    const values = [
      {
        type: 'Hello',
        playerName: 'ada',
        at: Fixed.parse('1.5'),
        tags: new Map([
          ['z', 1],
          ['a', 2],
        ]),
      },
      { type: 'Bye' },
      { type: 'Raw', value: Uint8Array.of(1, 2, 3) },
      { type: 'Many', value: [1, null, -7] },
    ];
    for (const v of values) expect(s.decode('Msg', s.encode('Msg', v))).toEqual(v);
    expect(Array.from(s.encode('Msg', { type: 'Bye' }))).toEqual([1]);
    expect(() => s.encode('Msg', { type: 'Nope' })).toThrow(/unknown variant type "Nope"/);
    expect(() => s.decode('Msg', Uint8Array.of(9))).toThrow(/unknown variant 9 for Msg/);
    expect(s.variants('Msg')).toEqual(['Hello', 'Bye', 'Raw', 'Many']);
    expect(s.types.Msg).toEqual({
      enum: [
        ['String', 'Fixed', { map: ['String', 'u16'] }],
        [],
        ['Bytes'],
        [{ vec: { option: 'i32' } }],
      ],
    });
  });

  it('compiles recursive types', () => {
    const s = defineTypes({
      roots: ['Tree'],
      types: { Tree: { struct: { value: 'u8', kids: netType.vec('Tree') } } },
    });
    const tree = {
      value: 1,
      kids: [
        { value: 2, kids: [] },
        { value: 3, kids: [{ value: 4, kids: [] }] },
      ],
    };
    expect(s.decode('Tree', s.encode('Tree', tree))).toEqual(tree);
  });

  it('names fields like generated code', () => {
    expect(propName('schema_hash')).toBe('schemaHash');
    expect(propName('_x')).toBe('_x');
    expect(propName('a_b_c')).toBe('aBC');
  });
});
