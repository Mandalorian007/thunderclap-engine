import { describe, expect, it } from 'vitest';
import { BAKE_MANIFEST_VERSION, readBakeManifest } from './baked';

describe('readBakeManifest', () => {
  const good = {
    version: 1,
    bakedAt: '2026-11-06T00:00:00.000Z',
    entries: [
      { name: 'level', kind: 'nav', sources: ['a.json'], sha256: 'ab', bytes: 10, ms: 1.5 },
      { name: 'level', kind: 'collider', sources: ['a.json'], sha256: 'ab', bytes: 20, ms: 2 },
    ],
  };

  it('reads a string or parsed JSON', () => {
    const m = readBakeManifest(JSON.stringify(good));
    expect(m).toEqual(good);
    expect(readBakeManifest(good)).toEqual(good);
    expect(m.version).toBe(BAKE_MANIFEST_VERSION);
  });

  it('fills missing optional fields and rejects bad shapes', () => {
    const m = readBakeManifest({ version: 1, entries: [{ name: 'x', kind: 'nav' }] });
    expect(m.entries[0]).toEqual({
      name: 'x',
      kind: 'nav',
      sources: [],
      sha256: '',
      bytes: 0,
      ms: 0,
    });
    expect(m.bakedAt).toBe('');
    expect(() => readBakeManifest({ version: 2, entries: [] })).toThrow(/version 2/);
    expect(() => readBakeManifest({ version: 1 })).toThrow(/entries/);
    expect(() => readBakeManifest({ version: 1, entries: [{ name: 'x', kind: 'mesh' }] })).toThrow(
      /entry 0/,
    );
    expect(() => readBakeManifest('null')).toThrow(/not an object/);
  });
});
