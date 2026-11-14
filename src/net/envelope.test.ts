import { describe, expect, it } from 'vitest';
import { defineSchema, type EnvelopeSpec, envelopeOf } from './envelope';
import { SchemaError } from './schema';
import { Reader, Writer } from './wire';

/** The game `crates/tc-net/src/envelope.rs`'s tests call `Custom`, laid out the same way. */
const envelope: EnvelopeSpec = {
  client: ['Ping', 'Hello', { Say: { text: 'String' } }, 'Command', { Wave: null }, 'Ack'],
  server: [
    'Pong',
    'Welcome',
    { Said: { text: 'String', from: 'u32' } },
    'Rejected',
    'Closed',
    'CommandResult',
    'Bulk',
  ],
  hello: ['schema_hash', 'token', 'ext'],
  welcome: ['player', 'paused', 'time', 'ext'],
  ack: 'total',
  close: { type: 'Bye', codes: [1012, 4003, 4004] },
};

const custom = () =>
  defineSchema({
    types: { Bye: { enum: { Restart: null, Kicked: null, Banned: null } } },
    roles: { hello: 'String', welcome: 'u32', command: 'u32', result: 'String' },
    envelope,
  });

const encode = (schema: ReturnType<typeof custom>, type: string, msg: unknown) => {
  const w = new Writer();
  schema.codec(type).encode(w, msg);
  return [...w.finish()];
};
const decode = (schema: ReturnType<typeof custom>, type: string, bytes: number[]) =>
  schema.codec(type).decode(new Reader(new Uint8Array(bytes)));

describe('envelope layout', () => {
  it('gives the Rust side’s text for the same layout', () => {
    expect(custom().text).toBe(`thunderclap-wire 2
root ClientMsg
root ServerMsg
enum ClientMsg {
  Ping { client_time: u64 }
  Hello { schema_hash: String, token: String, ext: String }
  Say { text: String }
  Command { seq: u32, command: u32 }
  Wave
  Ack { total: u64 }
}
enum ServerMsg {
  Pong { client_time: u64, time: u64, paused: bool }
  Welcome { player: u64, paused: bool, time: u64, ext: u32 }
  Said { text: String, from: u32 }
  Rejected { reason: String, stale_schema: bool }
  Closed { code: Bye, reason: String }
  CommandResult { seq: u32, result: String }
  Bulk { codec: u8, data: Bytes }
}
enum Bye {
  Restart
  Kicked
  Banned
}
`);
  });

  it('encodes the bytes the Rust side does', () => {
    const s = custom();
    const hello = { type: 'Hello', token: 't', schemaHash: 'h', bulk: 1, ext: 'ann' };
    expect(encode(s, 'ClientMsg', hello)).toEqual([1, 1, 104, 1, 116, 3, 97, 110, 110]);
    expect(encode(s, 'ClientMsg', { type: 'Say', text: 'x' })).toEqual([2, 1, 120]);
    expect(encode(s, 'ClientMsg', { type: 'Wave' })).toEqual([4]);
    expect(encode(s, 'ClientMsg', { type: 'Ack', total: 300 })).toEqual([5, 0xac, 0x02]);
    expect(decode(s, 'ServerMsg', [1, 7, 1, 9, 3])).toEqual({
      type: 'Welcome',
      player: 7,
      paused: true,
      time: 9,
      ext: 3,
    });
    expect(decode(s, 'ServerMsg', [2, 1, 121, 5])).toEqual({ type: 'Said', text: 'y', from: 5 });
    expect(decode(s, 'ServerMsg', [4, 2, 0])).toEqual({
      type: 'Closed',
      code: { type: 'Banned' },
      reason: '',
    });
    const info = envelopeOf(s);
    expect(info.ack).toBe('total');
    expect([...info.clientGame]).toEqual(['Say', 'Wave']);
    expect([...info.serverGame]).toEqual(['Said']);
    expect(info.closeCodes?.get('Banned')).toBe(4004);
  });

  it('is the engine’s wire by default', () => {
    const plain = defineSchema({ roles: { command: 'u32' } });
    const spelled = defineSchema({
      roles: { command: 'u32' },
      envelope: {
        hello: ['token', 'schema_hash', 'bulk', 'ext'],
        welcome: ['player', 'time', 'paused', 'step_us', 'ext'],
      },
    });
    expect(spelled.hash).toBe(plain.hash);
    expect(envelopeOf(plain).ack).toBe('each');
    expect(envelopeOf(plain).closeCodes).toBeNull();
  });

  it('refuses a layout a session cannot follow', () => {
    const bad =
      (e: EnvelopeSpec, types = {}) =>
      () =>
        defineSchema({ types, roles: { command: 'u32' }, envelope: e });
    expect(bad({ client: ['Hello'] })).toThrow(/Ping is required/);
    expect(bad({ server: ['Welcome', 'Rejected', 'Closed'] })).toThrow(/Pong is required/);
    expect(bad({ client: ['Hello', 'Ping', 'Ping'] })).toThrow(/listed twice/);
    expect(bad({ client: ['Hello', 'Ping', { Hello: null }] })).toThrow(/engine variant's name/);
    expect(bad({ client: ['Hello', 'Ping', 'Game', { Jump: null }] })).toThrow(/both/);
    expect(bad({ hello: ['token', 'schema_hash'] })).toThrow(/ext is required/);
    expect(bad({ close: { type: 'Nope', codes: [] } })).toThrow(SchemaError);
    expect(
      bad({ close: { type: 'E', codes: [1] } }, { E: { enum: { A: null, B: null } } }),
    ).toThrow(/one code for each/);
  });
});
