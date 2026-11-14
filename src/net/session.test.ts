import { describe, expect, it } from 'vitest';
import { EntityEncoder } from './entities';
import { type ClientMsg, defineSchema } from './envelope';
import { FakeTimers } from './fake-timers.test-util';
import { QueryFeed, ServerEnd } from './host';
import { createNet, type Net, NetError, type NetOptions } from './session';
import { type InPageHub, inPageHub } from './transport';
import { Writer } from './wire';

// A small game schema: a counter board, chat-like game messages, a 1D walker, ghosts.
const schema = defineSchema({
  types: {
    Join: { struct: { name: 'String' } },
    Cmd: { enum: { Add: { n: 'i32' }, Fail: null } },
    Res: { enum: { Ok: { total: 'i32' }, No: { reason: 'String' } } },
    Board: { struct: { title: 'String', scores: { map: ['String', 'i32'] } } },
    Area: { struct: { x: 'i32', w: 'u32' } },
    Walk: { struct: { dx: 'i32' } },
    Body: { struct: { x: 'i32' } },
    Ghost: { struct: { x: 'i32', y: 'i32', color: 'u8' } },
    Say: { struct: { text: 'String' } },
  },
  roles: {
    hello: 'Join',
    command: 'Cmd',
    result: 'Res',
    interest: 'Area',
    input: 'Walk',
    state: 'Body',
    client: 'Say',
    server: 'Say',
  },
  queries: { board: { args: { room: 'u32' }, result: 'Board' } },
  roots: ['Ghost'],
});

interface Client {
  end: ServerEnd;
  got: ClientMsg[];
}

/** An in-page server that records what each connection sent; tests answer by hand. */
function setup(options: Partial<NetOptions> = {}, autoWelcome = true) {
  const timers = new FakeTimers();
  const clients: Client[] = [];
  const hub: InPageHub = inPageHub(
    (connect) => {
      const c: Client = { got: [], end: null as unknown as ServerEnd };
      c.end = new ServerEnd(schema, connect, {
        message(msg) {
          c.got.push(msg);
          if (autoWelcome && msg.type === 'Hello') {
            c.end.send({
              type: 'Welcome',
              player: 7,
              time: 100,
              paused: false,
              stepUs: 50_000,
              ext: {},
            });
          }
        },
      });
      clients.push(c);
    },
    { timers, random: () => 0.5 },
  );
  const net = createNet({
    schema,
    connect: hub.connect,
    hello: { token: 'tok', ext: { name: 'ann' } },
    timers,
    random: () => 0.5,
    ...options,
  });
  const last = () => clients[clients.length - 1]!;
  const sent = (type: ClientMsg['type']) => last().got.filter((m) => m.type === type);
  return { timers, hub, net, clients, last, sent };
}

async function opened(net: Net, timers: FakeTimers): Promise<void> {
  await timers.advance(0);
  expect(net.status).toBe('open');
}

describe('net session: handshake', () => {
  it('sends Hello with the schema hash and resolves ready on Welcome', async () => {
    const { net, timers, sent } = setup();
    let welcomed = 0;
    net.on('welcome', () => welcomed++);
    await opened(net, timers);
    expect(sent('Hello')).toEqual([
      { type: 'Hello', token: 'tok', schemaHash: schema.hash, bulk: null, ext: { name: 'ann' } },
    ]);
    expect((await net.ready).player).toBe(7);
    expect(welcomed).toBe(1);
    expect(net.clock.now()).toBe(100);
    await timers.advance(500);
    expect(net.clock.now()).toBe(110);
  });

  it('a Rejected handshake closes for good and says if the schema is stale', async () => {
    const { net, timers, last } = setup({}, false);
    const seen: unknown[] = [];
    net.on('rejected', (reason, stale) => seen.push(reason, stale));
    net.on('closed', (code) => seen.push(code));
    await timers.advance(0);
    last().end.send({ type: 'Rejected', reason: 'old client', staleSchema: true });
    await timers.advance(0);
    expect(seen).toEqual(['old client', true, 4000]);
    expect(net.status).toBe('closed');
    await expect(net.ready).rejects.toThrow(NetError);
    await timers.advance(60_000);
    expect(net.status).toBe('closed');
  });

  it('a handshake that never finishes counts as a failed attempt', async () => {
    const { net, timers, clients } = setup({ handshakeMs: 1000 }, false);
    await timers.advance(1000);
    expect(net.status).toBe('down');
    await timers.advance(100);
    expect(clients.length).toBe(2);
  });

  it('a fresh hello each connection when hello is a function', async () => {
    let n = 0;
    const { net, timers, sent } = setup({
      hello: () => ({ token: `t${++n}`, ext: { name: 'b' } }),
    });
    await opened(net, timers);
    net.reconnect();
    await timers.advance(0);
    expect(sent('Hello')[0]).toMatchObject({ token: 't2' });
  });
});

describe('net session: commands', () => {
  it('matches results by seq, in any order', async () => {
    const { net, timers, sent, last } = setup();
    await opened(net, timers);
    const a = net.command({ type: 'Add', n: 1 });
    const b = net.command({ type: 'Add', n: 2 });
    await timers.advance(0);
    const [ca, cb] = sent('Command') as Extract<ClientMsg, { type: 'Command' }>[];
    expect(ca!.seq).not.toBe(cb!.seq);
    last().end.send({ type: 'CommandResult', seq: cb!.seq, result: { type: 'Ok', total: 2 } });
    last().end.send({ type: 'CommandResult', seq: ca!.seq, result: { type: 'No', reason: 'x' } });
    await timers.advance(0);
    expect(await a).toEqual({ type: 'No', reason: 'x' });
    expect(await b).toEqual({ type: 'Ok', total: 2 });
  });

  it("refuses what the wire can't carry, and anything while not open", async () => {
    const { net, timers } = setup();
    await expect(net.command({ type: 'Add', n: 1 })).rejects.toThrow(/not connected/);
    await opened(net, timers);
    await expect(net.command({ type: 'Add', n: 'one' })).rejects.toThrow(/can't be sent/);
  });

  it('times out, and fails what is in flight when the link drops', async () => {
    const { net, timers, hub } = setup({ commandMs: 1000 });
    await opened(net, timers);
    const slow = net.command({ type: 'Fail' });
    const timedOut = expect(slow).rejects.toThrow(/timed out/);
    await timers.advance(1000);
    await timedOut;
    const lost = net.command({ type: 'Fail' });
    const failed = expect(lost).rejects.toThrow(/connection lost/);
    hub.dropAll();
    await timers.advance(0);
    await failed;
    expect(net.status).toBe('down');
  });

  it('a result for an unknown seq is a protocol error: it reconnects', async () => {
    const { net, timers, last, clients } = setup();
    const errors: Error[] = [];
    net.on('error', (e) => errors.push(e));
    await opened(net, timers);
    last().end.send({ type: 'CommandResult', seq: 99, result: { type: 'Ok', total: 0 } });
    await timers.advance(0);
    expect(errors[0]?.message).toMatch(/unknown command 99/);
    await timers.advance(200);
    expect(clients.length).toBe(2);
    expect(net.status).toBe('open');
  });

  it('undecodable bytes are a protocol error too', async () => {
    const { net, timers, last } = setup();
    const errors: Error[] = [];
    net.on('error', (e) => errors.push(e));
    await opened(net, timers);
    last().end.sendRaw(new Uint8Array([200, 1, 2]));
    await timers.advance(0);
    expect(errors[0]?.message).toMatch(/undecodable/);
  });
});

describe('net session: live queries', () => {
  const subOf = (c: Client) =>
    c.got.find((m) => m.type === 'Subscribe') as Extract<ClientMsg, { type: 'Subscribe' }>;

  it('applies patches to the last result and delivers it whole', async () => {
    const { net, timers, last } = setup();
    await opened(net, timers);
    const seen: unknown[] = [];
    const q = net.query('board', { room: 3 }, (v, patch) => seen.push([v, patch?.length ?? null]));
    await timers.advance(0);
    const s = subOf(last());
    expect(s.query).toBe('board');
    expect(s.args).toEqual(schema.encodeArgs('board', { room: 3 }));
    expect(s.resume).toBeNull();
    const feed = new QueryFeed(schema, 'board', s.sub);
    const v1 = { title: 'a', scores: new Map([['ann', 1]]) };
    const v2 = {
      title: 'a',
      scores: new Map([
        ['ann', 1],
        ['bo', 4],
      ]),
    };
    last().end.send(feed.next(v1)!);
    last().end.send(feed.next(v2)!);
    await timers.advance(0);
    expect(seen).toEqual([
      [v1, null],
      [v2, 1],
    ]);
    expect(q.value).toEqual(v2);
    expect(q.version).toBe(2);
    q.close();
    await timers.advance(0);
    expect(last().got.at(-1)).toEqual({ type: 'Unsubscribe', sub: s.sub });
  });

  it('a hash mismatch asks for the whole result again', async () => {
    const { net, timers, last } = setup();
    await opened(net, timers);
    const seen: unknown[] = [];
    net.query('board', { room: 1 }, (v) => seen.push(v));
    await timers.advance(0);
    const s = subOf(last());
    const feed = new QueryFeed(schema, 'board', s.sub);
    last().end.send(feed.next({ title: 'a', scores: new Map() })!);
    const upd = feed.next({ title: 'b', scores: new Map() })!;
    last().end.send({ ...upd, hash: '0000000000000000' } as typeof upd);
    await timers.advance(0);
    expect(seen.length).toBe(1);
    const again = last().got.filter((m) => m.type === 'Subscribe') as Extract<
      ClientMsg,
      { type: 'Subscribe' }
    >[];
    expect(again.length).toBe(2);
    expect(again[1]!.sub).not.toBe(s.sub);
    expect(again[1]!.resume).toBeNull();
    expect(last().got).toContainEqual({ type: 'Unsubscribe', sub: s.sub });
  });

  it('after a reconnect, resumes from the result it holds, and reports QueryFailed', async () => {
    const { net, timers, last, hub } = setup();
    await opened(net, timers);
    const failed: string[] = [];
    const q = net.query('board', { room: 1 }, () => {}, { onFailed: (r) => failed.push(r) });
    await timers.advance(0);
    const feed = new QueryFeed(schema, 'board', subOf(last()).sub);
    last().end.send(feed.next({ title: 'a', scores: new Map() })!);
    await timers.advance(0);
    hub.dropAll();
    await timers.advance(200);
    expect(net.status).toBe('open');
    const s2 = subOf(last());
    expect(s2.resume).not.toBeNull();
    expect(feed.resume(s2.sub, s2.resume)).toBe(true);
    last().end.send(feed.next({ title: 'b', scores: new Map() })!);
    last().end.send({ type: 'QueryFailed', sub: s2.sub, reason: 'gone' });
    await timers.advance(0);
    expect(q.value).toEqual({ title: 'b', scores: new Map() });
    expect(failed).toEqual(['gone']);
  });
});

describe('net session: reconnect and liveness', () => {
  it('backs off with jitter, then gives up', async () => {
    const opens: number[] = [];
    const timers = new FakeTimers();
    const net = createNet({
      schema,
      timers,
      random: () => 0,
      reconnect: { initialDelay: 100, maxDelay: 400, jitter: 0.5, giveUpAfter: 2000 },
      connect: (events) => {
        opens.push(timers.now());
        timers.setTimeout(() => events.close(1006, 'refused'), 0);
        return { send() {}, close() {} };
      },
    });
    const closed: string[] = [];
    net.on('closed', (_c, r) => closed.push(r));
    await timers.advance(3000);
    // 100, 200, 400, 400... (random 0: no jitter taken off)
    expect(opens.slice(0, 5)).toEqual([0, 100, 300, 700, 1100]);
    expect(closed[0]).toMatch(/could not reconnect within 2000 ms/);
    expect(net.status).toBe('closed');
  });

  it('a Closed in the game range closes for good; a restart reconnects', async () => {
    const { net, timers, last, clients } = setup();
    await opened(net, timers);
    const down: number[] = [];
    net.on('down', (c) => down.push(c));
    last().end.send({ type: 'Closed', code: 1012, reason: 'restarting' });
    await timers.advance(200);
    expect(down).toEqual([1012]);
    expect(net.status).toBe('open');
    last().end.send({ type: 'Closed', code: 4001, reason: 'kicked' });
    await timers.advance(1000);
    expect(net.status).toBe('closed');
    expect(clients.length).toBe(2);
  });

  it('pings when quiet, measures latency, and drops a link that goes silent', async () => {
    const { net, timers, last, sent, clients } = setup({
      liveness: { pingMs: 1000, deadMs: 4000 },
    });
    await opened(net, timers);
    await timers.advance(1000);
    const ping = sent('Ping')[0] as Extract<ClientMsg, { type: 'Ping' }>;
    expect(ping).toBeDefined();
    await timers.advance(60);
    last().end.send({ type: 'Pong', clientTime: ping.clientTime, time: 200, paused: false });
    await timers.advance(0);
    expect(net.clock.latencyMs).toBe(30);
    await timers.advance(4500);
    expect(clients.length).toBe(2);
  });

  it('wake() reconnects unless something answers soon', async () => {
    const { net, timers, clients } = setup({
      liveness: { pingMs: 60_000, deadMs: 60_000, wakeMs: 500 },
    });
    await opened(net, timers);
    net.wake();
    await timers.advance(600);
    expect(clients.length).toBe(2);
  });

  it('close() stops retrying while down', async () => {
    const { net, timers, hub, clients } = setup();
    await opened(net, timers);
    hub.dropAll();
    await timers.advance(0);
    net.close();
    await timers.advance(10_000);
    expect(clients.length).toBe(1);
    expect(net.status).toBe('closed');
  });
});

describe('net session: game messages, interest, prediction, entities, bulk', () => {
  it('sends and receives game messages, and re-sends interest after a reconnect', async () => {
    const { net, timers, last, sent, hub } = setup();
    const heard: unknown[] = [];
    net.on('game', (v) => heard.push(v));
    expect(net.send({ text: 'early' })).toBe(false);
    net.setInterest({ x: 1, w: 10 });
    await opened(net, timers);
    expect(sent('SetInterest')).toEqual([{ type: 'SetInterest', interest: { x: 1, w: 10 } }]);
    net.send({ text: 'hi' });
    last().end.send({ type: 'Game', value: { text: 'yo' } });
    last().end.send({ type: 'InterestRejected', reason: 'too big' });
    await timers.advance(0);
    expect(sent('Game')).toEqual([{ type: 'Game', value: { text: 'hi' } }]);
    expect(heard).toEqual([{ text: 'yo' }]);
    hub.dropAll();
    await timers.advance(200);
    expect(sent('SetInterest').length).toBe(1);
  });

  it('predicts inputs, reconciles on PlayerState, and follows while watching', async () => {
    const { net, timers, last, sent } = setup();
    await opened(net, timers);
    const p = net.predict<{ x: number }, { dx: number }>({
      step: (s, i) => ({ x: s.x + i.dx }),
      equal: (a, b) => a.x === b.x,
      start: { seq: 0, state: { x: 0 } },
    });
    net.input({ dx: 2 });
    net.input({ dx: 2 });
    expect(p.state.x).toBe(4);
    await timers.advance(0);
    expect(sent('Input').map((m) => (m as { seq: number }).seq)).toEqual([1, 2]);
    last().end.send({ type: 'PlayerState', seq: 1, state: { x: 1 }, tickUs: 50_000 });
    await timers.advance(0);
    expect(p.correctionCount).toBe(1);
    expect(p.state.x).toBe(3);
    last().end.send({ type: 'Control', driving: false });
    last().end.send({ type: 'PlayerState', seq: 5, state: { x: 9 }, tickUs: 50_000 });
    await timers.advance(0);
    expect(net.driving).toBe(false);
    expect(net.input({ dx: 1 })).toBe(false);
    expect(p.state.x).toBe(9);
  });

  it('decodes the entity stream and asks for a key frame after a bad one', async () => {
    const { net, timers, last, sent } = setup({ entities: 'Ghost' });
    await opened(net, timers);
    const enc = new EntityEncoder(schema, 'Ghost');
    const frame = enc.frame(1, new Map([[5, { x: 1, y: 2, color: 3 }]]))!;
    last().end.send({ type: 'EntityStream', data: frame });
    await timers.advance(0);
    expect(net.entities!.get(5)).toEqual({ x: 1, y: 2, color: 3 });
    last().end.send({ type: 'EntityStream', data: new Uint8Array([0, 2, 1, 9, 4, 0]) });
    await timers.advance(0);
    expect(sent('EntityResync').length).toBe(1);
    expect(net.entities!.waiting).toBe(true);
  });

  it('handles a bulk lane in order and acknowledges it', async () => {
    const { net, timers, last, sent } = setup({
      inflate: async (_codec, data) => {
        await new Promise<void>((r) => timers.setTimeout(r, 50));
        return data;
      },
      bulk: 3,
    });
    const heard: unknown[] = [];
    net.on('game', (v) => heard.push((v as { text: string }).text));
    await opened(net, timers);
    expect(sent('Hello')[0]).toMatchObject({ bulk: 3 });
    const lane = new Writer();
    for (const text of ['a', 'b'])
      lane.bytes(schema.encode('ServerMsg', { type: 'Game', value: { text } }));
    const data = lane.finish();
    last().end.send({ type: 'Bulk', codec: 3, data });
    last().end.send({ type: 'Game', value: { text: 'c' } });
    await timers.advance(0);
    expect(heard).toEqual([]);
    await timers.advance(50);
    expect(heard).toEqual(['a', 'b', 'c']);
    expect(sent('Ack')).toEqual([{ type: 'Ack', bytes: data.length }]);
  });

  it('a throwing listener does not stop the others', async () => {
    const { net, timers } = setup();
    let second = 0;
    net.on('welcome', () => {
      throw new Error('boom');
    });
    net.on('welcome', () => second++);
    await opened(net, timers);
    expect(second).toBe(1);
  });
});

describe('net session: fit options', () => {
  const welcome = schema.encode('ServerMsg', {
    type: 'Welcome',
    player: 1,
    time: 0,
    paused: false,
    stepUs: 50_000,
    ext: {},
  });

  /** A session over a hand-driven transport: `deliver` hands it a frame in the same call. */
  function direct(options: Partial<NetOptions> = {}) {
    const timers = new FakeTimers();
    const out: ClientMsg[] = [];
    let events: Parameters<NetOptions['connect']>[0] | null = null;
    let opens = 0;
    const net = createNet({
      schema,
      timers,
      random: () => 0.5,
      hello: { ext: { name: 'ann' } },
      connect: (e) => {
        events = e;
        opens++;
        timers.setTimeout(() => e.open(), 0);
        return { send: (f) => out.push(schema.decode<ClientMsg>('ClientMsg', f)), close() {} };
      },
      ...options,
    });
    const deliver = (frame: Uint8Array) => events!.message(frame);
    const sentOf = (type: ClientMsg['type']) => out.filter((m) => m.type === type);
    return { net, timers, deliver, sentOf, opens: () => opens };
  }

  it('rawResults: a command resolves with its result bytes, undecoded', async () => {
    const { net, timers, deliver, sentOf } = direct({ rawResults: true });
    await timers.advance(0);
    deliver(welcome);
    const p = net.command({ type: 'Add', n: 1 });
    const seq = (sentOf('Command')[0] as { seq: number }).seq;
    const frame = schema.encode('ServerMsg', {
      type: 'CommandResult',
      seq,
      result: { type: 'Ok', total: 5 },
    });
    deliver(frame);
    const bytes = (await p) as Uint8Array;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(schema.decode('Res', bytes)).toEqual({ type: 'Ok', total: 5 });
    // Everything else is decoded as before.
    const game: unknown[] = [];
    net.on('game', (v) => game.push(v));
    deliver(schema.encode('ServerMsg', { type: 'Game', value: { text: 'x' } }));
    expect(game).toEqual([{ text: 'x' }]);
  });

  it('plainBulk: an uncompressed lane is handled in the same call and acknowledged', async () => {
    const { net, timers, deliver, sentOf } = direct({ plainBulk: true });
    await timers.advance(0);
    expect(sentOf('Hello')[0]).toMatchObject({ bulk: 0 });
    deliver(welcome);
    const heard: string[] = [];
    net.on('game', (v) => heard.push((v as { text: string }).text));
    const lane = new Writer();
    for (const text of ['a', 'b'])
      lane.bytes(schema.encode('ServerMsg', { type: 'Game', value: { text } }));
    const data = lane.finish();
    deliver(schema.encode('ServerMsg', { type: 'Bulk', codec: 0, data }));
    expect(heard).toEqual(['a', 'b']);
    expect(sentOf('Ack')).toEqual([{ type: 'Ack', bytes: data.length }]);
    // A compressed one with no inflate hook is still a protocol error.
    const errors: Error[] = [];
    net.on('error', (e) => errors.push(e));
    deliver(schema.encode('ServerMsg', { type: 'Bulk', codec: 1, data }));
    expect(errors[0]?.message).toMatch(/inflate hook/);
  });

  it("heardBy 'tick': reads the clock once per tick, not per message", async () => {
    const { net, timers, deliver, opens } = direct({
      liveness: { pingMs: 1000, deadMs: 4000, heardBy: 'tick' },
    });
    await timers.advance(0);
    deliver(welcome);
    let reads = 0;
    const now = timers.now.bind(timers);
    timers.now = () => {
      reads++;
      return now();
    };
    const pong = schema.encode('ServerMsg', { type: 'InterestRejected', reason: '' });
    for (let i = 0; i < 100; i++) deliver(pong);
    expect(reads).toBeLessThan(5);
    // Still alive: heard at each tick, so it never counts as dead while frames arrive.
    for (let i = 0; i < 10; i++) {
      await timers.advance(1000);
      deliver(pong);
    }
    expect(opens()).toBe(1);
    await timers.advance(5000);
    expect(opens()).toBe(2);
    expect(net.status).not.toBe('closed');
  });

  it('structured reasons: down and closed carry a typed kind, NetError a reason', async () => {
    const { net, timers, deliver } = direct({
      liveness: { pingMs: 1000, deadMs: 2000 },
      reconnect: { giveUpAfter: 1000 },
      handshakeMs: 300,
      commandMs: 100,
    });
    await timers.advance(0);
    deliver(welcome);
    const cmd = net.command({ type: 'Fail' });
    const timedOut = expect(cmd).rejects.toMatchObject({
      reason: { kind: 'commandTimeout', detail: 'command 1 timed out' },
    });
    await timers.advance(100);
    await timedOut;
    const seen: unknown[] = [];
    net.on('down', (code, reason, why) => seen.push(['down', code, reason, why.kind]));
    net.on('closed', (code, _r, why) => seen.push(['closed', code, why.kind, why.last?.kind]));
    await timers.advance(2500);
    expect(seen[0]).toEqual(['down', 1006, expect.stringMatching(/nothing heard/), 'dead']);
    await timers.advance(5000);
    expect(seen.at(-1)).toEqual(['closed', 1006, 'gaveUp', 'handshakeTimeout']);
    await expect(net.ready).resolves.toBeDefined();
    await expect(net.command({})).rejects.toMatchObject({ reason: { kind: 'notOpen' } });
  });

  it('structured reasons: Rejected, a final Closed and close()', async () => {
    const a = direct();
    const why: string[] = [];
    a.net.on('closed', (_c, _r, w) => why.push(w.kind));
    await a.timers.advance(0);
    a.deliver(schema.encode('ServerMsg', { type: 'Rejected', reason: 'no', staleSchema: false }));
    const b = direct();
    b.net.on('closed', (_c, _r, w) => why.push(w.kind));
    await b.timers.advance(0);
    b.deliver(welcome);
    b.deliver(schema.encode('ServerMsg', { type: 'Closed', code: 4002, reason: 'banned' }));
    const c = direct();
    c.net.on('closed', (_c, _r, w) => why.push(`${w.kind}:${w.detail}`));
    c.net.close();
    expect(why).toEqual(['rejected', 'serverClosed', 'closed:closed']);
  });

  it("listenerErrors 'throw': the others run, then the first error leaves the call", async () => {
    const { net, timers, deliver } = direct({ listenerErrors: 'throw' });
    await timers.advance(0);
    const boom = new Error('boom');
    let second = 0;
    const errors: Error[] = [];
    net.on('error', (e) => errors.push(e));
    net.on('welcome', () => {
      throw boom;
    });
    net.on('welcome', () => second++);
    expect(() => deliver(welcome)).toThrow(boom);
    expect(second).toBe(1);
    expect(errors).toEqual([]);
    expect(net.status).toBe('open');
    // Not a protocol error: the connection stays up.
    net.on('game', () => {
      throw boom;
    });
    expect(() =>
      deliver(schema.encode('ServerMsg', { type: 'Game', value: { text: 'x' } })),
    ).toThrow(boom);
    expect(net.status).toBe('open');
  });

  it('reconnect({ backoff: true }) waits the backoff; reconnect() reopens at once', async () => {
    const { net, timers, deliver, opens } = direct({
      reconnect: { initialDelay: 400, jitter: 0 },
    });
    await timers.advance(0);
    deliver(welcome);
    net.reconnect();
    await timers.advance(0);
    expect(opens()).toBe(2);
    deliver(welcome);
    net.reconnect({ backoff: true });
    await timers.advance(399);
    expect(opens()).toBe(2);
    expect(net.status).toBe('down');
    await timers.advance(1);
    expect(opens()).toBe(3);
  });
});

describe('net session: an envelope of its own', () => {
  const own = defineSchema({
    types: { Bye: { enum: { Restart: null, Kicked: null } } },
    roles: { hello: 'String', welcome: 'u32', command: 'u32', result: 'String' },
    envelope: {
      client: ['Ping', 'Hello', { Say: { text: 'String' } }, 'Command', 'Ack'],
      server: ['Pong', 'Welcome', { Said: { text: 'String' } }, 'Rejected', 'Closed', 'Bulk'],
      hello: ['schema_hash', 'token', 'bulk', 'ext'],
      welcome: ['player', 'time', 'paused', 'ext'],
      ack: 'total',
      close: { type: 'Bye', codes: [1012, 4003] },
    },
  });

  function direct(options: Partial<NetOptions> = {}) {
    const timers = new FakeTimers();
    const out: ClientMsg[] = [];
    let events: Parameters<NetOptions['connect']>[0] | null = null;
    const net = createNet({
      schema: own,
      timers,
      random: () => 0.5,
      hello: { ext: 'ann' },
      plainBulk: true,
      reconnect: { initialDelay: 10, maxDelay: 10 },
      connect: (e) => {
        events = e;
        timers.setTimeout(() => e.open(), 0);
        return { send: (f) => out.push(own.decode<ClientMsg>('ClientMsg', f)), close() {} };
      },
      ...options,
    });
    const deliver = (msg: unknown) => events!.message(own.encode('ServerMsg', msg));
    const sentOf = (type: string) => out.filter((m) => m.type === type);
    return { net, timers, deliver, sentOf };
  }
  const welcome = { type: 'Welcome', player: 1, time: 0, paused: false, ext: 7 };

  it('sends and takes the game’s messages inline, with no step_us read as 0', async () => {
    const { net, timers, deliver, sentOf } = direct();
    await timers.advance(0);
    deliver(welcome);
    expect((await net.ready).stepUs).toBe(0);
    const heard: unknown[] = [];
    net.on('game', (m) => heard.push(m));
    deliver({ type: 'Said', text: 'hi' });
    expect(heard).toEqual([{ type: 'Said', text: 'hi' }]);
    expect(net.send({ type: 'Say', text: 'yo' })).toBe(true);
    expect(sentOf('Say')).toEqual([{ type: 'Say', text: 'yo' }]);
    expect(() => net.send({ type: 'Ping', clientTime: 0 })).toThrow(/not one of the game's/);
  });

  it('acknowledges the bulk lane cumulatively, from 0 on each connection', async () => {
    const { net, timers, deliver, sentOf } = direct();
    await timers.advance(0);
    deliver(welcome);
    await net.ready;
    const lane = (n: number) => {
      const w = new Writer();
      for (let i = 0; i < n; i++) w.bytes(own.encode('ServerMsg', { type: 'Said', text: 'x' }));
      return w.finish();
    };
    const a = lane(1);
    const b = lane(2);
    deliver({ type: 'Bulk', codec: 0, data: a });
    deliver({ type: 'Bulk', codec: 0, data: b });
    expect(sentOf('Ack')).toEqual([
      { type: 'Ack', total: a.length },
      { type: 'Ack', total: a.length + b.length },
    ]);
    // A restart (not final): the count starts again with the next Hello.
    deliver({ type: 'Closed', code: { type: 'Restart' }, reason: 'restart' });
    await timers.advance(20);
    deliver(welcome);
    deliver({ type: 'Bulk', codec: 0, data: a });
    expect(sentOf('Ack').at(-1)).toEqual({ type: 'Ack', total: a.length });
  });

  it('reads Closed’s code through the game’s close enum', async () => {
    const { net, timers, deliver } = direct();
    await timers.advance(0);
    deliver(welcome);
    await net.ready;
    const closed: number[] = [];
    net.on('closed', (code) => closed.push(code));
    deliver({ type: 'Closed', code: { type: 'Kicked' }, reason: 'bye' });
    expect(closed).toEqual([4003]);
    expect(net.status).toBe('closed');
  });
});
