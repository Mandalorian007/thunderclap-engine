// A game's own envelope, every option used, as thunderclap-server generates it: the schema hashes
// as the Rust one does and every frame the Rust codecs wrote decodes and encodes back byte for
// byte. `crates/thunderclap-server/tests/ts_envelope.rs` writes testdata/own-envelope.* (TC_BLESS=1).
import { describe, expect, it } from 'vitest';
import { envelopeOf } from './envelope';
import { SCHEMA_HASH, schema } from './testdata/own-envelope.gen';
import vectors from './testdata/own-envelope.json';
import type { Fixed } from './wire';

const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('a generated schema for an envelope of its own', () => {
  it('hashes as the server does', () => {
    expect(schema.hash).toBe(SCHEMA_HASH);
    expect([...envelopeOf(schema).serverGame]).toEqual(['Chunk', 'Note']);
  });

  it('decodes and encodes every frame byte for byte', () => {
    for (const root of ['ClientMsg', 'ServerMsg'] as const) {
      for (const hex of vectors[root]) {
        const msg = schema.decode(root, fromHex(hex));
        expect(toHex(schema.encode(root, msg)), `${root} ${JSON.stringify(msg)}`).toBe(hex);
      }
    }
  });

  it('reads the split Hello, the game messages and 53-bit stamps as numbers', () => {
    const [hello, , look] = vectors.ClientMsg.map((h) => schema.decode('ClientMsg', fromHex(h)));
    expect(hello).toEqual({
      type: 'Hello',
      token: 'ada',
      schemaHash: '0123456789abcdef',
      watch: true,
      region: 'north',
      bulk: 1,
      seed: 2 ** 53 - 1,
    });
    expect((look as { at: Fixed }).at.bits).toBe(-(3n << 32n) - 1n);
    const chunk = schema.decode('ServerMsg', fromHex(vectors.ServerMsg[3]!));
    expect(chunk).toMatchObject({ type: 'Chunk', stamp: 4294967295000 });
  });
});
