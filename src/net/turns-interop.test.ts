// Interop with a turn-based game on the Rust server: `createNet` over a real WebSocket to the
// tic-tac-toe game in crates/tc-sim/tests/turns_game. Run by
// `cargo test -p thunderclap-server --test turns`, which serves it through the facade
// and sets TC_TURNS_URL; skipped otherwise.
import { describe, expect, it } from 'vitest';
import { defineSchema } from './envelope';
import { createNet, type Net } from './session';
import type { Connect } from './transport';

const url = process.env.TC_TURNS_URL;

/** `ServerMsg` variant indexes, read off a frame's first byte. */
const UPDATE = 3;
const RESYNC = 4;

/** A link a test can hold down: while `held`, a reconnect waits. */
interface Link {
  seen: number[];
  held: Promise<void> | null;
}

/** A WebSocket `Connect` that also reports each frame's first byte. */
const wsConnect =
  (to: string, link: Link = { seen: [], held: null }): Connect =>
  (events) => {
    let ws: WebSocket | null = null;
    let closed = false;
    const start = () => {
      if (closed) return;
      ws = new WebSocket(to);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => events.open();
      ws.onmessage = (e) => {
        const frame = new Uint8Array(e.data as ArrayBuffer);
        link.seen.push(frame[0]!);
        events.message(frame);
      };
      ws.onclose = (e) => events.close(e.code, e.reason);
    };
    if (link.held) void link.held.then(start);
    else start();
    return {
      send: (frame) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(frame as Uint8Array<ArrayBuffer>);
      },
      close: () => {
        closed = true;
        ws?.close();
      },
    };
  };

/** The turn game's schema, as the Rust side builds it. */
const turnsSchema = () =>
  defineSchema({
    types: {
      Move: { enum: { Place: { cell: 'u8' }, Resign: null, Rematch: null } },
      Reply: { enum: { Done: null, Refused: ['String'] } },
      Board: {
        struct: {
          cells: { vec: 'u8' },
          next: 'u8',
          winner: 'u8',
          turn: 'u32',
          round: 'u32',
          deadline: 'u64',
          x: 'String',
          o: 'String',
          wins_x: 'u32',
          wins_o: 'u32',
        },
      },
    },
    roles: { welcome: 'u8', command: 'Move', result: 'Reply' },
    roots: ['Empty'],
    queries: { board: { result: 'Board' }, mark: { result: 'u8' } },
  });

interface Board {
  cells: number[] | Uint8Array;
  next: number;
  winner: number;
  turn: number;
  x: string;
  o: string;
}

type Reply = { type: 'Done' } | { type: 'Refused'; value: string };

function open(token: string, link?: Link): Net {
  return createNet({
    schema: turnsSchema(),
    connect: wsConnect(url!, link),
    hello: { token },
  });
}

const place = (cell: number) => ({ type: 'Place', cell });

/** Resolves once `test` holds, polling. */
async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Long names: the board must outweigh a patch's hash, or the server resends it whole.
const X = 'xander-of-the-long-name';
const O = 'oona-of-the-even-longer-name';

describe.skipIf(!url)('turns interop', () => {
  it('has the hash the server was built with', () => {
    expect(turnsSchema().hash).toBe(process.env.TC_TURNS_HASH);
  });

  it('plays a round, a watcher following the board', async () => {
    const x = open(X);
    const o = open(O);
    expect((await x.ready).ext).toBe(1);
    expect((await o.ready).ext).toBe(2);
    const watcher = open('cy');
    expect((await watcher.ready).ext).toBe(0);
    let board: Board | undefined;
    watcher.query<Board>('board', {}, (b) => (board = b));
    await until(() => board?.next === 1, 'X to open');
    expect([board!.x, board!.o]).toEqual([X, O]);

    const refused = (await o.command(place(4))) as Reply;
    expect(refused).toEqual({ type: 'Refused', value: 'not your turn' });
    // X 0 1 8, O 4 2 6: O takes the rising diagonal.
    for (const [who, cell] of [
      [x, 0],
      [o, 4],
      [x, 1],
      [o, 2],
      [x, 8],
      [o, 6],
    ] as const) {
      expect(await who.command(place(cell))).toEqual({ type: 'Done' });
    }
    await until(() => board?.winner === 2, 'O to win');
    expect(Array.from(board!.cells)).toEqual([1, 1, 2, 0, 2, 0, 2, 0, 1]);
    expect(await x.command(place(3))).toEqual({
      type: 'Refused',
      value: 'the round is over',
    });
    for (const n of [x, o, watcher]) n.close();
  });

  it('resumes the board with a patch after a dropped link', async () => {
    const link: Link = { seen: [], held: null };
    const x = open(X, link);
    await x.ready;
    let board: Board | undefined;
    x.query<Board>('board', {}, (b) => (board = b));
    await until(() => board?.winner === 2, 'the finished round');
    const o = open(O);
    await o.ready;
    // X drops and stays away while O starts the next round.
    let release = () => {};
    link.held = new Promise((r) => (release = r));
    x.reconnect();
    await until(() => x.status !== 'open', 'X down');
    expect(await o.command({ type: 'Rematch' })).toEqual({ type: 'Done' });
    link.seen.length = 0;
    link.held = null;
    release();
    await until(() => board?.winner === 0 && board.next === 2, 'the new round, from the resume');
    // The resumed subscription was patched, never resent whole.
    expect(link.seen).toContain(UPDATE);
    expect(link.seen).not.toContain(RESYNC);
    for (const n of [x, o]) n.close();
  });
});
