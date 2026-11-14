// Interop with the Rust server (crates/tc-net): `createNet` over a real
// WebSocket to the echo game in crates/tc-net/tests/echo. Run by
// `cargo test -p tc-net --test interop` (or `pnpm test:net-interop`),
// which starts the server and sets TC_NET_INTEROP_URL; skipped otherwise.
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defineSchema } from './envelope';
import { createNet, type Net, type NetOptions } from './session';
import type { Connect } from './transport';

const url = process.env.TC_NET_INTEROP_URL;

/** A `Connect` over the runtime's WebSocket. */
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

/** The echo game's schema, as the Rust side builds it. */
const echoSchema = (extra = false) =>
  defineSchema({
    types: {
      Ghost: { struct: { x: 'i32', y: 'i32' } },
      Echoed: { struct: { text: 'String', count: 'u32' } },
      ...(extra ? { Extra: { struct: { a: 'u8' } } } : {}),
    },
    roles: { command: 'String', result: 'String', server: 'String' },
    roots: extra ? ['Ghost', 'Extra'] : ['Ghost'],
    queries: { echo: { args: { text: 'String' }, result: 'Echoed' } },
  });

const DEFLATE = 1;

function open(options: Partial<NetOptions> = {}): Net {
  return createNet({
    schema: echoSchema(),
    connect: wsConnect(url!),
    hello: { token: 'ada' },
    entities: 'Ghost',
    bulk: DEFLATE,
    inflate: async (codec, data) => (codec === DEFLATE ? inflateRawSync(data) : data),
    reconnect: { initialDelay: 20, maxDelay: 100 },
    ...options,
  });
}

/** Resolves once `test` holds, polling. */
async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe.skipIf(!url)('tc-net interop', () => {
  it('has the hash the server was built with', () => {
    expect(echoSchema().hash).toBe(process.env.TC_NET_INTEROP_HASH);
  });

  it('handshakes, commands, and patches a live query', async () => {
    const net = open();
    const welcome = await net.ready;
    expect(welcome.stepUs).toBe(50_000);
    expect(net.clock.stepMs).toBe(50);
    const seen: { text: string; count: number }[] = [];
    let patched = 0;
    const q = net.query<{ text: string; count: number }>('echo', { text: 'hi' }, (v, patch) => {
      seen.push({ ...v });
      if (patch) patched++;
    });
    await until(() => seen.length === 1, 'the first result');
    const start = seen[0]!.count;
    expect(seen[0]!.text).toBe('hi');
    expect(await net.command('hello')).toBe('HELLO');
    await until(() => patched === 1, 'a patch');
    expect(q.value).toEqual({ text: 'hi', count: start + 1 });
    expect(q.version).toBe(2);
    net.close();
  });

  it('carries the entity stream and the bulk lane, acked', async () => {
    const net = open();
    await net.ready;
    expect(await net.command('ghosts 3')).toBe('3');
    await until(() => net.entities!.entities.size === 3, 'three ghosts');
    expect(net.entities!.get(2)).toEqual({ x: 1, y: -1 });
    const got: unknown[] = [];
    net.on('game', (v) => got.push(v));
    expect(await net.command('bulk 40')).toBe('40');
    await until(() => got.length === 40, 'the bulk lane');
    expect(got[39]).toMatch(/^bulk 39 x+$/);
    // Acks are taken: the session stays up and still answers.
    expect(await net.command('again')).toBe('AGAIN');
    net.close();
  });

  it('reconnects on a restart and resumes its query', async () => {
    const net = open();
    const first = await net.ready;
    const results: number[] = [];
    net.query<{ count: number }>('echo', { text: 'r' }, (v) => results.push(v.count));
    await until(() => results.length === 1, 'the first result');
    let downs = 0;
    net.on('down', () => downs++);
    const welcomes: number[] = [];
    net.on('welcome', (w) => welcomes.push(w.player));
    await net.command('restart');
    await until(() => welcomes.length === 1, 'a reconnect');
    expect(downs).toBe(1);
    expect(welcomes[0]).not.toBe(first.player);
    await until(() => results.length === 2, 'the query again');
    expect(net.status).toBe('open');
    net.close();
  });

  it('ends for good on a final close code', async () => {
    const net = open();
    await net.ready;
    const closed = new Promise<number>((resolve) => net.on('closed', (code) => resolve(code)));
    void net.command('kick').catch(() => {});
    expect(await closed).toBe(4001);
    expect(net.status).toBe('closed');
  });

  it('is rejected, stale, with another schema', async () => {
    const net = open({ schema: echoSchema(true) });
    const rejected = new Promise<[string, boolean]>((resolve) =>
      net.on('rejected', (reason, stale) => resolve([reason, stale])),
    );
    const [reason, stale] = await rejected;
    expect(stale).toBe(true);
    expect(reason).toMatch(/schema mismatch/);
    expect(net.status).toBe('closed');
  });
});
