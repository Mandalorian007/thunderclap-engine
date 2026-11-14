// Interop with the Rust accounts and auth (crates/tc-auth): `createNet`
// joins tc-net's echo game with a tc-auth session token, the token is
// revoked, and the session ends for good with 4001: no reconnect. Run by
// `cargo test -p tc-auth --test interop`, which starts the server and sets
// TC_AUTH_INTEROP_URL; skipped otherwise.
import { describe, expect, it } from 'vitest';
import { defineSchema } from './envelope';
import { createNet, type Net } from './session';
import type { Connect } from './transport';

const url = process.env.TC_AUTH_INTEROP_URL;
const token = process.env.TC_AUTH_INTEROP_TOKEN ?? '';

/** A `Connect` over the runtime's WebSocket, counting its opens. */
let opens = 0;
const wsConnect =
  (to: string): Connect =>
  (events) => {
    opens++;
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

/** The echo game's schema (crates/tc-net/tests/echo), as in interop.test.ts. */
const echoSchema = () =>
  defineSchema({
    types: {
      Ghost: { struct: { x: 'i32', y: 'i32' } },
      Echoed: { struct: { text: 'String', count: 'u32' } },
    },
    roles: { command: 'String', result: 'String', server: 'String' },
    roots: ['Ghost'],
    queries: { echo: { args: { text: 'String' }, result: 'Echoed' } },
  });

function open(): Net {
  return createNet({
    schema: echoSchema(),
    connect: wsConnect(url!),
    hello: { token },
    reconnect: { initialDelay: 20, maxDelay: 100 },
  });
}

describe.skipIf(!url)('tc-auth interop', () => {
  it('is closed for good with 4001 when its token is revoked', async () => {
    expect(echoSchema().hash).toBe(process.env.TC_AUTH_INTEROP_HASH);
    opens = 0;
    const net = open();
    await net.ready;
    let welcomes = 0;
    net.on('welcome', () => welcomes++);
    const closed = new Promise<[number, string]>((resolve) =>
      net.on('closed', (code, reason) => resolve([code, reason])),
    );
    void net.command('revoke ada').catch(() => {});
    const [code, reason] = await closed;
    expect(code).toBe(4001);
    expect(reason).toMatch(/revoked/);
    expect(net.status).toBe('closed');
    // Ten reconnect delays later: still one connection, no new welcome.
    await new Promise((r) => setTimeout(r, 1000));
    expect(opens).toBe(1);
    expect(welcomes).toBe(0);
    expect(net.status).toBe('closed');
  });

  it('is rejected at the handshake with the revoked token', async () => {
    const net = open();
    const [reason, stale] = await new Promise<[string, boolean]>((resolve) =>
      net.on('rejected', (r, s) => resolve([r, s])),
    );
    expect(stale).toBe(false);
    expect(reason).toMatch(/revoked/);
    expect(net.status).toBe('closed');
  });
});
