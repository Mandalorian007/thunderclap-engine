import { describe, expect, it } from 'vitest';
import {
  defineVertexSchema,
  packVertexField,
  unpackSectionVertex,
  VOXEL_VERTEX_OPTIONAL,
  vertexField,
  vertexFieldValue,
  vertexSchemaWgsl,
} from './schema';

// Forge Wilds' vertex layout (apps/web/src/mesh/vertex.ts), packed by hand as Forge does.
function forgeWord0(
  x: number,
  y: number,
  z: number,
  face: number,
  ao: number,
  sky: number,
  worked: number,
  block: number,
): number {
  return (
    (x |
      (y << 5) |
      (z << 10) |
      (face << 15) |
      (ao << 18) |
      (sky << 20) |
      (worked << 26) |
      (block << 27)) >>>
    0
  );
}
function forgeWord1(
  id: number,
  inset: number,
  side: number,
  facing: number,
  ripe: number,
  quad: number,
  hue: number,
): number {
  return (
    (id |
      (inset << 12) |
      (side << 17) |
      (facing << 20) |
      (ripe << 23) |
      (quad << 26) |
      (hue << 29)) >>>
    0
  );
}

const FORGE_SCHEMA = defineVertexSchema([
  { name: 'worked', bits: 1, word: 0, shift: 26 },
  { name: 'block', bits: 5, word: 0, shift: 27 },
  { name: 'inset', bits: 5, word: 1, shift: 12 },
  { name: 'side', bits: 3, word: 1, shift: 17 },
  { name: 'facing', bits: 3, word: 1, shift: 20 },
  { name: 'ripe', bits: 3, word: 1, shift: 23 },
  { name: 'quad', bits: 3, word: 1, shift: 26 },
  { name: 'hue', bits: 3, word: 1, shift: 29 },
]);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('VertexSchema', () => {
  it('places the defaults first-fit: word 0 low 31 bits, the id in word 1', () => {
    const s = defineVertexSchema();
    const at = (n: string) => {
      const f = vertexField(s, n);
      return f && [f.word, f.shift, f.bits];
    };
    expect(at('x')).toEqual([0, 0, 5]);
    expect(at('face')).toEqual([0, 15, 3]);
    expect(at('sky')).toEqual([0, 20, 6]);
    expect(at('block')).toEqual([0, 26, 5]);
    expect(at('id')).toEqual([1, 0, 12]);
    const more = defineVertexSchema(VOXEL_VERTEX_OPTIONAL);
    expect(vertexField(more, 'side')?.word).toBe(1);
    expect(vertexField(more, 'hue')?.shift).toBe(23);
  });

  it('reproduces Forge’s layout from explicit placements, and decodes what Forge packs', () => {
    const r = rng(7);
    const n = (bits: number) => Math.floor(r() * 2 ** bits);
    for (let i = 0; i < 500; i++) {
      const v = {
        x: n(5),
        y: n(5),
        z: n(5),
        face: n(3),
        ao: n(2),
        sky: n(6),
        worked: n(1),
        block: n(5),
        id: n(12),
        inset: n(5),
        side: n(3),
        facing: n(3),
        ripe: n(3),
        quad: n(3),
        hue: n(3),
      };
      const w0 = forgeWord0(v.x, v.y, v.z, v.face, v.ao, v.sky, v.worked, v.block);
      const w1 = forgeWord1(v.id, v.inset, v.side, v.facing, v.ripe, v.quad, v.hue);
      expect(unpackSectionVertex(FORGE_SCHEMA, w0, w1)).toEqual(v);
      const words = new Uint32Array(2);
      for (const f of FORGE_SCHEMA.fields)
        packVertexField(words, 0, f, v[f.name as keyof typeof v]);
      expect([words[0], words[1]]).toEqual([w0, w1]);
    }
  });

  it('generates the WGSL decode a person would write', () => {
    const s = defineVertexSchema([{ name: 'tint', bits: 4 }], { defaults: false });
    expect(vertexSchemaWgsl(s)).toBe(
      'struct VoxelVertex {\n  tint: u32,\n}\n\nfn decode_voxel_vertex(w0: u32, w1: u32) -> VoxelVertex {\n  var v: VoxelVertex;\n  v.tint = w0 & 15u;\n  return v;\n}\n',
    );
    const wgsl = vertexSchemaWgsl(FORGE_SCHEMA, { struct: 'V', fn: 'decode' });
    expect(wgsl).toContain('fn decode(w0: u32, w1: u32) -> V {');
    expect(wgsl).toContain('  v.x = w0 & 31u;');
    expect(wgsl).toContain('  v.y = (w0 >> 5u) & 31u;');
    expect(wgsl).toContain('  v.block = w0 >> 27u;');
    expect(wgsl).toContain('  v.id = w1 & 4095u;');
    expect(wgsl).toContain('  v.hue = w1 >> 29u;');
    expect(wgsl).not.toContain('override');
  });

  it('the WGSL decode computes what the CPU decode does (evaluated as written)', () => {
    // Evaluate each generated line's expression on the CPU: WGSL's u32 >>, & read the same in JS.
    const wgsl = vertexSchemaWgsl(FORGE_SCHEMA);
    const lines = [...wgsl.matchAll(/ {2}v\.(\w+) = (.+);/g)];
    expect(lines.length).toBe(FORGE_SCHEMA.fields.length);
    const r = rng(3);
    for (let i = 0; i < 100; i++) {
      const w0 = Math.floor(r() * 2 ** 32);
      const w1 = Math.floor(r() * 2 ** 32);
      const cpu = unpackSectionVertex(FORGE_SCHEMA, w0, w1);
      for (const [, name, expr] of lines) {
        const js = expr.replace(/(\d+)u/g, '$1').replace(/>>/g, '>>>');
        const value = new Function('w0', 'w1', `return (${js}) >>> 0;`)(w0, w1) as number;
        expect(value, name).toBe(cpu[name]);
      }
    }
  });

  it('rejects overlaps, overflow, bad names and duplicates', () => {
    expect(() =>
      defineVertexSchema(
        [
          { name: 'a', bits: 4, word: 0, shift: 0 },
          { name: 'b', bits: 4, word: 0, shift: 2 },
        ],
        { defaults: false },
      ),
    ).toThrow();
    expect(() =>
      defineVertexSchema([{ name: 'a', bits: 4, word: 1, shift: 30 }], { defaults: false }),
    ).toThrow();
    expect(() => defineVertexSchema([{ name: '1a', bits: 4 }])).toThrow();
    expect(() =>
      defineVertexSchema(
        [
          { name: 'a', bits: 1 },
          { name: 'a', bits: 1 },
        ],
        { defaults: false },
      ),
    ).toThrow();
    expect(() => defineVertexSchema([{ name: 'big', bits: 24 }])).toThrow();
  });

  it('a missing field packs nothing and reads 0', () => {
    const s = defineVertexSchema();
    expect(vertexField(s, 'hue')).toBeUndefined();
    const words = new Uint32Array(2);
    packVertexField(words, 0, vertexField(s, 'hue'), 5);
    expect([...words]).toEqual([0, 0]);
    expect(vertexFieldValue(undefined, 1, 1)).toBe(0);
  });
});
