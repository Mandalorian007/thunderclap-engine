// Interop with the Rust game loop (crates/tc-sim): `createNet` over a real
// WebSocket to the tally game in crates/tc-sim/tests/tally. Run by
// `cargo test -p tc-sim --test net`, which starts the server and sets
// TC_SIM_INTEROP_URL; skipped otherwise.
import { describe, expect, it } from 'vitest';
import { defineSchema } from '../../../src/net/envelope';
import { createNet, type Net } from '../../../src/net/session';
import type { Connect } from '../../../src/net/transport';

const url = process.env.TC_SIM_INTEROP_URL;

const wsConnect =
  (to: string): Connect =>
  (events) => {
    const ws = new WebSocket(to);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => events.open();
    ws.onmessage = (e) => events.message(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => events.close(e.code, e.reason);
    return {
      send: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame as Uint8Array<ArrayBuffer>);
      },
      close: () => ws.close(),
    };
  };

/** The tally game's schema, as the Rust side builds it. */
const tallySchema = () =>
  defineSchema({
    types: {},
    roles: {
      welcome: 'u64',
      command: 'String',
      result: 'String',
      input: 'i32',
      state: 'i32',
      server: 'String',
    },
    roots: [],
    queries: {},
  });

function open(token: string): Net {
  return createNet({ schema: tallySchema(), connect: wsConnect(url!), hello: { token } });
}

describe.skipIf(!url)('tc-sim interop', () => {
  it('has the hash the server was built with', () => {
    expect(tallySchema().hash).toBe(process.env.TC_SIM_INTEROP_HASH);
  });

  it('joins and commands, reading its writes', async () => {
    const net = open('cy');
    const welcome = await net.ready;
    expect(welcome.stepUs).toBe(50_000);
    expect(await net.command('add 3')).toBe('3');
    expect(await net.command('add 4')).toBe('7');
    expect(await net.command('nonsense')).toMatch(/^error/);
    net.close();
  });

  it('comes back as the same player', async () => {
    const net = open('cy');
    const welcome = await net.ready;
    expect(BigInt(welcome.ext as number | bigint)).toBe(7n);
    net.close();
  });
});
