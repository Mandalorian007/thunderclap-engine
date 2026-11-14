// Interop with the Rust server for a game with a wire of its own: the talk
// game in crates/tc-net/tests/talk, whose messages are inline envelope
// variants, in its own order, with a running-total ack and its own close
// enum. Run by `cargo test -p tc-net --test interop` (or
// `pnpm test:net-interop`), which starts the server and sets
// TC_NET_INTEROP_URL; skipped otherwise.
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defineSchema } from './envelope';
import { createNet, type Net } from './session';
import type { Connect } from './transport';

const url = process.env.TC_NET_INTEROP_URL;

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

/** The talk game's schema, as `crates/tc-net/tests/talk` lays it out. */
const talkSchema = () =>
  defineSchema({
    types: { Bye: { enum: { Restart: null, Kicked: null } } },
    roles: { hello: 'String', welcome: 'u32', command: 'u32', result: 'String' },
    envelope: {
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
      hello: ['schema_hash', 'token', 'bulk', 'ext'],
      welcome: ['player', 'paused', 'time', 'ext'],
      ack: 'total',
      close: { type: 'Bye', codes: [1012, 4003] },
    },
  });

const DEFLATE = 1;

const open = (name: string): Net =>
  createNet({
    schema: talkSchema(),
    connect: wsConnect(url!),
    hello: { token: 'ada', ext: name },
    bulk: DEFLATE,
    inflate: async (codec, data) => (codec === DEFLATE ? inflateRawSync(data) : data),
    reconnect: { initialDelay: 20, maxDelay: 100 },
  });

async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Said = { type: 'Said'; text: string; from: number };

describe.skipIf(!url)('tc-net interop: a wire of its own', () => {
  it('has the hash the server was built with, and talks inline', async () => {
    expect(talkSchema().hash).toBe(process.env.TC_NET_INTEROP_HASH);
    const net = open('grace');
    const welcome = await net.ready;
    expect(welcome.ext).toBe(5);
    expect(welcome.stepUs).toBe(0);
    const heard: Said[] = [];
    net.on('game', (m) => heard.push(m as Said));
    net.send({ type: 'Say', text: 'hello' });
    await until(() => heard.length === 1, 'the line back');
    expect(heard[0]).toEqual({ type: 'Said', text: 'grace: hello', from: welcome.player });
    net.close();
  });

  it('carries the bulk lane, acked with a running total', async () => {
    const net = open('ada');
    await net.ready;
    const got: Said[] = [];
    net.on('game', (m) => got.push(m as Said));
    for (const round of [1, 2]) {
      expect(await net.command(30)).toBe('30');
      await until(() => got.length === 30 * round, 'the bulk lane');
    }
    expect(got[59]?.text).toMatch(/^bulk 29 x+$/);
    // Every total was taken: the session stays up and still answers.
    expect(await net.command(0)).toBe('0');
    net.close();
  });

  it('ends for good on the game’s final close code', async () => {
    const net = open('ada');
    await net.ready;
    const closed = new Promise<number>((resolve) => net.on('closed', (code) => resolve(code)));
    net.send({ type: 'Wave' });
    expect(await closed).toBe(4003);
    expect(net.status).toBe('closed');
  });
});
