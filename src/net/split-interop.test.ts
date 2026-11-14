// Interop with the Rust server for an existing protocol the envelope's options fit: the split game
// in crates/tc-net/tests/split, whose Hello lays the game's fields among the envelope's, whose
// Rejected has no stale_schema, and whose bulk lane is acked by whole messages. Run by
// `cargo test -p tc-net --test interop` (or `pnpm test:net-interop`), which starts the server and
// sets TC_NET_INTEROP_URL; skipped otherwise.
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defineSchema } from './envelope';
import { netType, type QuerySpec } from './schema';
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

/** The split game's schema, as `crates/tc-net/tests/split` lays it out (`queries`: another one). */
const splitSchema = (queries?: Record<string, QuerySpec>) =>
  defineSchema({
    types: {
      Joining: { struct: { watch: 'bool', content: 'String', opening: netType.option('u32') } },
    },
    roles: {
      hello: 'Joining',
      welcome: 'String',
      command: 'u32',
      result: 'String',
      server: 'String',
    },
    queries,
    envelope: {
      hello: ['token', 'schema_hash', { ext: 1 }, 'bulk', { ext: 2 }],
      rejected: ['reason'],
      ack: 'messages',
    },
  });

const DEFLATE = 1;

const open = (schema = splitSchema()): Net =>
  createNet({
    schema,
    connect: wsConnect(url!),
    hello: { token: 'ada', ext: { watch: true, content: 'base', opening: 7 } },
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

describe.skipIf(!url)('tc-net interop: an existing protocol, fitted', () => {
  it('has the hash the server was built with, and Hello’s fields reach the game', async () => {
    expect(splitSchema().hash).toBe(process.env.TC_NET_INTEROP_HASH);
    const net = open();
    const welcome = await net.ready;
    expect(welcome.ext).toBe('true base 7');
    net.close();
  });

  it('carries the bulk lane, acked by whole messages', async () => {
    const net = open();
    await net.ready;
    const got: string[] = [];
    net.on('game', (m) => got.push(m as string));
    for (const round of [1, 2, 3]) {
      expect(await net.command(40)).toBe('40');
      await until(() => got.length === 40 * round, 'the bulk lane');
    }
    expect(got[119]).toMatch(/^bulk 39 x+$/);
    // Every total named whole messages sent: the session stays up and still answers.
    expect(await net.command(0)).toBe('0');
    expect(net.status).toBe('open');
    net.close();
  });

  it('rejects a stale client with its hash quoted, and no stale_schema', async () => {
    const stale = splitSchema({ other: { args: {}, result: 'u32' } });
    const net = open(stale);
    const rejected = new Promise<[string, boolean]>((resolve) =>
      net.on('rejected', (reason, isStale) => resolve([reason, isStale])),
    );
    net.ready.catch(() => {});
    const [reason, isStale] = await rejected;
    expect(reason).toBe(
      `protocol schema mismatch: server ${process.env.TC_NET_INTEROP_HASH}, client "${stale.hash}"; update the client`,
    );
    expect(isStale).toBe(false);
  });
});
