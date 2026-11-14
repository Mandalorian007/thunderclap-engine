// Interop with the Rust game loop (crates/tc-sim): `createNet` over a real
// WebSocket to the tally game in crates/tc-sim/tests/tally. Run by
// `cargo test -p tc-sim --test net` (or `pnpm test:sim-interop`), which
// starts the server and sets TC_SIM_INTEROP_URL; skipped otherwise.
import { describe, expect, it } from 'vitest';
import { defineSchema } from './envelope';
import { createNet, type Net } from './session';
import type { Connect } from './transport';

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
    types: {
      Span: { struct: { from: 'i32', to: 'i32' } },
      Dot: { struct: { x: 'i32', tally: 'u64' } },
      Board: { struct: { names: { vec: 'String' }, total: 'u64' } },
    },
    roles: {
      welcome: 'u64',
      command: 'String',
      result: 'String',
      interest: 'Span',
      input: 'i32',
      state: 'i32',
      client: 'String',
      server: 'String',
    },
    roots: ['Dot'],
    queries: {
      tally: { args: { name: 'String' }, result: 'u64' },
      board: { result: 'Board' },
      mine: { result: 'u64' },
      where: { args: { player: 'u64' }, result: 'i32' },
      steps: { result: 'u64' },
      tick: { args: { every: 'u64' }, result: 'u64' },
    },
  });

function open(token: string): Net {
  return createNet({
    schema: tallySchema(),
    connect: wsConnect(url!),
    hello: { token },
    entities: 'Dot',
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

  it('follows a live query and the entity stream', async () => {
    const net = open('di');
    await net.ready;
    const seen: bigint[] = [];
    net.query<number | bigint>('mine', {}, (v) => seen.push(BigInt(v)));
    await until(() => seen.length === 1, 'the first result');
    expect(seen[0]).toBe(0n);
    net.setInterest({ from: -10, to: 10 });
    await until(() => net.entities!.entities.size >= 1, 'a dot');
    expect(await net.command('add 5')).toBe('5');
    await until(() => seen.at(-1) === 5n, 'the patched result');
    net.close();
  });

  it('comes back as the same player', async () => {
    const net = open('cy');
    const welcome = await net.ready;
    expect(BigInt(welcome.ext as number | bigint)).toBe(7n);
    net.close();
  });
});
