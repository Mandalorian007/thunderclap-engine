/**
 * Net harness page: `@thunderclap-engine/engine/net` with no WebGPU, so e2e/net.spec.ts can verify
 * it on every matrix row. A tiny 2D co-op game, noun-free: two dots walk to a beacon, and each
 * time one reaches it the shared score goes up and the beacon moves.
 *
 * - An in-page authority on `inPageHub`: `ServerEnd` per connection, inputs applied as they
 *   arrive and answered with `PlayerState`, a 20 Hz step that sends each client an
 *   `EntityEncoder` frame of every player and a `QueryFeed` update of the `team` query.
 * - Two clients (`createNet`), drawn side by side: each predicts its own dot (`net.predict`,
 *   `net.input`), draws the other through its snapshot buffer, and shows the live score.
 * - Latency, jitter and loss sliders change the hub's link conditions live; Drop drops every link
 *   and both clients reconnect, resume their query and reset their prediction.
 */
import {
  createNet,
  defineSchema,
  EMPTY,
  EntityEncoder,
  inPageHub,
  type Net,
  type Predictor,
  QueryFeed,
  ServerEnd,
} from '@thunderclap-engine/engine/net';
import type { HarnessNetApi, HarnessNetClient, HarnessNetState } from './net-state';

const W = 200;
const H = 120;
const SPEED = 2;
const STEP_MS = 50;
const REACH = 6;

interface Body {
  x: number;
  y: number;
}
interface Move {
  dx: number;
  dy: number;
}
interface View {
  x: number;
  y: number;
  vx: number;
  vy: number;
}
interface Team {
  score: number;
  beaconX: number;
  beaconY: number;
  players: number;
}

const schema = defineSchema({
  types: {
    Move: { struct: { dx: 'i32', dy: 'i32' } },
    Body: { struct: { x: 'i32', y: 'i32' } },
    View: { struct: { x: 'i32', y: 'i32', vx: 'i32', vy: 'i32' } },
    Team: { struct: { score: 'u32', beacon_x: 'i32', beacon_y: 'i32', players: 'u32' } },
    Reset: { struct: {} },
    Done: { struct: { score: 'u32' } },
  },
  roles: { input: 'Move', state: 'Body', command: 'Reset', result: 'Done' },
  roots: ['View'],
  queries: { team: { result: 'Team' } },
});

/** The game's one rule, run by the authority and by each client's predictor alike. */
function step(b: Body, m: Move): Body {
  return {
    x: Math.min(W, Math.max(0, b.x + Math.sign(m.dx) * SPEED)),
    y: Math.min(H, Math.max(0, b.y + Math.sign(m.dy) * SPEED)),
  };
}

// --- The authority -------------------------------------------------------------------------------

interface Player {
  id: number;
  token: string;
  body: Body;
  prev: Body;
  view: View;
  lastSeq: number;
}
interface Conn {
  end: ServerEnd;
  player: Player | null;
  encoder: EntityEncoder<View>;
  feed: QueryFeed | null;
}

const server = {
  tick: 0,
  score: 0,
  beacon: { x: 150, y: 60 },
  seed: 7,
  players: new Map<string, Player>(),
  conns: new Set<Conn>(),
};
const views = new Map<number, View>();

function nextBeacon(): void {
  server.seed = (server.seed * 1103515245 + 12345) >>> 0;
  server.beacon.x = 10 + (server.seed % (W - 20));
  server.seed = (server.seed * 1103515245 + 12345) >>> 0;
  server.beacon.y = 10 + (server.seed % (H - 20));
}

function team(): Team {
  return {
    score: server.score,
    beaconX: server.beacon.x,
    beaconY: server.beacon.y,
    players: views.size,
  };
}

const hub = inPageHub((connect) => {
  const conn: Conn = {
    end: null as unknown as ServerEnd,
    player: null,
    encoder: new EntityEncoder<View>(schema, 'View'),
    feed: null,
  };
  conn.end = new ServerEnd(schema, connect, {
    message(msg) {
      switch (msg.type) {
        case 'Hello': {
          let p = server.players.get(msg.token);
          if (!p) {
            const id = server.players.size + 1;
            const start = { x: 20 + 20 * id, y: 20 + 10 * id };
            const view = { x: start.x, y: start.y, vx: 0, vy: 0 };
            p = { id, token: msg.token, body: start, prev: start, view, lastSeq: 0 };
            server.players.set(msg.token, p);
          }
          conn.player = p;
          views.set(p.id, p.view);
          server.conns.add(conn);
          conn.end.send({
            type: 'Welcome',
            player: p.id,
            time: server.tick,
            paused: false,
            stepUs: STEP_MS * 1000,
            ext: EMPTY,
          });
          // Where it is now: the client's predictor takes it as a reset.
          conn.end.send({ type: 'PlayerState', seq: p.lastSeq, state: p.body, tickUs: 0 });
          return;
        }
        case 'Input': {
          const p = conn.player;
          if (!p || msg.seq <= p.lastSeq) return;
          p.lastSeq = msg.seq;
          p.body = step(p.body, msg.input as Move);
          conn.end.send({ type: 'PlayerState', seq: msg.seq, state: p.body, tickUs: 0 });
          return;
        }
        case 'Subscribe': {
          conn.feed ??= new QueryFeed(schema, msg.query, msg.sub);
          if (conn.feed.resume(msg.sub, msg.resume)) return;
          const out = conn.feed.next(team());
          if (out) conn.end.send(out);
          return;
        }
        case 'Unsubscribe':
          conn.feed = null;
          return;
        case 'Ping':
          conn.end.send({
            type: 'Pong',
            clientTime: msg.clientTime,
            time: server.tick,
            paused: false,
          });
          return;
        case 'Command':
          server.score = 0;
          conn.end.send({ type: 'CommandResult', seq: msg.seq, result: { score: 0 } });
          return;
        case 'EntityResync':
          conn.encoder.resync();
          return;
        default:
          return;
      }
    },
    close() {
      server.conns.delete(conn);
      if (conn.player) views.delete(conn.player.id);
    },
  });
});

setInterval(() => {
  server.tick++;
  for (const p of server.players.values()) {
    p.view.x = p.body.x;
    p.view.y = p.body.y;
    p.view.vx = p.body.x - p.prev.x;
    p.view.vy = p.body.y - p.prev.y;
    p.prev = p.body;
    if (
      views.has(p.id) &&
      Math.abs(p.body.x - server.beacon.x) <= REACH &&
      Math.abs(p.body.y - server.beacon.y) <= REACH
    ) {
      server.score++;
      nextBeacon();
    }
  }
  const t = team();
  for (const c of server.conns) {
    if (!c.end.open) continue;
    const frame = c.encoder.frame(server.tick, views);
    if (frame) c.end.send({ type: 'EntityStream', data: frame });
    const out = c.feed?.next(t);
    if (out) c.end.send(out);
  }
}, STEP_MS);

// --- The clients ---------------------------------------------------------------------------------

interface Client {
  name: 'a' | 'b';
  net: Net;
  predictor: Predictor<Body, Move>;
  held: Move;
  team: Team | null;
  welcomes: number;
  other: Float64Array;
  hasOther: boolean;
  view: HarnessNetClient;
}

const pos = new Float64Array(2);
const vel = new Float64Array(2);

function makeClient(name: 'a' | 'b'): Client {
  const net = createNet({
    schema,
    connect: hub.connect,
    hello: { token: name },
    entities: 'View',
    snapshots: { dims: 2, stepMs: STEP_MS },
  });
  const predictor = net.predict<Body, Move>({
    step,
    equal: (p, q) => p.x === q.x && p.y === q.y,
    distance: (p, q) => Math.hypot(p.x - q.x, p.y - q.y),
    start: { seq: 0, state: { x: 0, y: 0 } },
    stepMs: STEP_MS,
  });
  const c: Client = {
    name,
    net,
    predictor,
    held: { dx: 0, dy: 0 },
    team: null,
    welcomes: 0,
    other: new Float64Array(2),
    hasOther: false,
    view: {
      status: 'connecting',
      player: 0,
      welcomes: 0,
      x: 0,
      y: 0,
      corrections: 0,
      resets: 0,
      pending: 0,
      score: -1,
      others: 0,
      otherX: Number.NaN,
      otherY: Number.NaN,
      delayMs: 0,
      clock: 0,
    },
  };
  net.on('welcome', () => {
    c.welcomes++;
    // The server's first `PlayerState` puts the dot where it is: not a misprediction.
    predictor.expectReset();
  });
  net.on('entities', (changes) => {
    const now = performance.now();
    const me = net.welcome?.player ?? 0;
    for (const id of changes.changed) {
      if (id === me) continue;
      const v = net.entities?.get(id) as View | undefined;
      if (!v) continue;
      pos[0] = v.x;
      pos[1] = v.y;
      vel[0] = v.vx;
      vel[1] = v.vy;
      net.snapshots.push(id, changes.tick, pos, vel, now);
    }
    for (const id of changes.gone) net.snapshots.remove(id);
  });
  net.query<Team>('team', undefined, (value) => {
    c.team = value;
  });
  return c;
}

const clients = [makeClient('a'), makeClient('b')] as const;
let autopilot = true;

setInterval(() => {
  for (const c of clients) {
    if (c.net.status !== 'open') continue;
    let m = c.held;
    if (autopilot && c.team) {
      const s = c.predictor.state;
      m = { dx: Math.sign(c.team.beaconX - s.x), dy: Math.sign(c.team.beaconY - s.y) };
    }
    if (m.dx !== 0 || m.dy !== 0) c.net.input(m);
  }
}, STEP_MS);

// --- The page ------------------------------------------------------------------------------------

const canvas = document.getElementById('view') as HTMLCanvasElement;
const g = canvas.getContext('2d') as CanvasRenderingContext2D;
const statsEl = document.getElementById('stats') as HTMLElement;

const state: HarnessNetState = {
  ready: false,
  hash: schema.hash,
  tick: 0,
  score: 0,
  server: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } },
  a: clients[0].view,
  b: clients[1].view,
  latencyMs: 0,
  jitterMs: 0,
  loss: 0,
  frames: 0,
};

function refresh(now: number): void {
  for (const c of clients) {
    const v = c.view;
    const net = c.net;
    const me = net.welcome?.player ?? 0;
    net.snapshots.frame(now);
    v.status = net.status;
    v.player = me;
    v.welcomes = c.welcomes;
    v.x = c.predictor.state.x;
    v.y = c.predictor.state.y;
    v.corrections = c.predictor.correctionCount;
    v.resets = c.predictor.resets;
    v.pending = c.predictor.pending;
    v.score = c.team ? c.team.score : -1;
    v.others = 0;
    c.hasOther = false;
    if (net.entities) {
      for (const id of net.entities.entities.keys()) {
        if (id === me) continue;
        v.others++;
        if (!c.hasOther && net.snapshots.at(id, c.other)) c.hasOther = true;
      }
    }
    v.otherX = c.hasOther ? c.other[0]! : Number.NaN;
    v.otherY = c.hasOther ? c.other[1]! : Number.NaN;
    v.delayMs = net.snapshots.delay;
    v.clock = net.clock.now();
  }
  state.tick = server.tick;
  state.score = server.score;
  const pa = server.players.get('a');
  const pb = server.players.get('b');
  if (pa) Object.assign(state.server.a, pa.body);
  if (pb) Object.assign(state.server.b, pb.body);
  state.latencyMs = hub.conditions.latencyMs;
  state.jitterMs = hub.conditions.jitterMs;
  state.loss = hub.conditions.loss;
  state.ready = clients.every((c) => c.welcomes > 0 && c.team !== null);
}

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr);
  const ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, cw, ch);
  const top = 48 * dpr;
  const wide = cw >= ch;
  const paneW = wide ? cw / 2 : cw;
  const paneH = wide ? ch - top : (ch - top) / 2;
  const scale = Math.min((paneW - 16 * dpr) / W, (paneH - 16 * dpr) / H);
  const colours = ['#4cc9f0', '#f72585'];
  clients.forEach((c, i) => {
    const ox = (wide ? i * paneW : 0) + (paneW - W * scale) / 2;
    const oy = top + (wide ? 0 : i * paneH) + (paneH - H * scale) / 2;
    g.setTransform(scale, 0, 0, scale, ox, oy);
    g.fillStyle = '#16161c';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = colours[i]!;
    g.lineWidth = 1 / scale;
    g.strokeRect(0, 0, W, H);
    if (c.team) {
      g.fillStyle = '#ffd166';
      g.beginPath();
      g.arc(c.team.beaconX, c.team.beaconY, REACH, 0, Math.PI * 2);
      g.fill();
    }
    // The other player, interpolated.
    if (c.hasOther) {
      g.strokeStyle = colours[1 - i]!;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(c.other[0]!, c.other[1]!, 4, 0, Math.PI * 2);
      g.stroke();
    }
    // This client's own dot, predicted and drawn between its last two steps.
    const p = c.predictor;
    const a = p.alpha();
    const x = p.previous.x + (p.state.x - p.previous.x) * a;
    const y = p.previous.y + (p.state.y - p.previous.y) * a;
    g.fillStyle = colours[i]!;
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
    g.setTransform(dpr, 0, 0, dpr, ox / dpr, oy / dpr);
    g.fillStyle = '#fff';
    g.font = '13px system-ui, sans-serif';
    g.fillText(
      `${c.name}: ${c.view.status}  score ${c.view.score}  corrections ${c.view.corrections}  delay ${Math.round(c.view.delayMs)} ms`,
      4,
      -6,
    );
  });
}

function frame(now: number): void {
  refresh(now);
  draw();
  state.frames++;
  statsEl.textContent = `step ${state.tick}  score ${state.score}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Controls ------------------------------------------------------------------------------------

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
function setLink(c: { latencyMs?: number; jitterMs?: number; loss?: number }): void {
  if (c.latencyMs !== undefined) hub.conditions.latencyMs = c.latencyMs;
  if (c.jitterMs !== undefined) hub.conditions.jitterMs = c.jitterMs;
  if (c.loss !== undefined) hub.conditions.loss = c.loss;
  input('latency').value = String(hub.conditions.latencyMs);
  input('jitter').value = String(hub.conditions.jitterMs);
  input('loss').value = String(hub.conditions.loss);
  (document.getElementById('latency-v') as HTMLElement).textContent =
    `${hub.conditions.latencyMs} ms`;
  (document.getElementById('jitter-v') as HTMLElement).textContent =
    `${hub.conditions.jitterMs} ms`;
  (document.getElementById('loss-v') as HTMLElement).textContent =
    `${Math.round(hub.conditions.loss * 100)}%`;
}
for (const id of ['latency', 'jitter', 'loss'] as const) {
  input(id).addEventListener('input', () => {
    const v = Number(input(id).value);
    setLink(id === 'latency' ? { latencyMs: v } : id === 'jitter' ? { jitterMs: v } : { loss: v });
  });
}
setLink({
  latencyMs: Number(input('latency').value),
  jitterMs: Number(input('jitter').value),
  loss: Number(input('loss').value),
});

function setAuto(on: boolean): void {
  autopilot = on;
  input('auto').checked = on;
}
input('auto').addEventListener('change', () => setAuto(input('auto').checked));
document.getElementById('drop')?.addEventListener('click', () => hub.dropAll());
const reset = () => clients[0].net.command<{ score: number }>({}).then((r) => r.score);
document.getElementById('reset')?.addEventListener('click', () => void reset());

// WASD drives a, the arrows drive b (auto off).
const keys = new Set<string>();
const KEYS: Record<string, ['a' | 'b', number, number]> = {
  KeyW: ['a', 0, -1],
  KeyS: ['a', 0, 1],
  KeyA: ['a', -1, 0],
  KeyD: ['a', 1, 0],
  ArrowUp: ['b', 0, -1],
  ArrowDown: ['b', 0, 1],
  ArrowLeft: ['b', -1, 0],
  ArrowRight: ['b', 1, 0],
};
function fromKeys(): void {
  for (const c of clients) {
    let dx = 0;
    let dy = 0;
    for (const k of keys) {
      const b = KEYS[k];
      if (b && b[0] === c.name) {
        dx += b[1];
        dy += b[2];
      }
    }
    c.held = { dx, dy };
  }
}
window.addEventListener('keydown', (e) => {
  if (!KEYS[e.code]) return;
  setAuto(false);
  keys.add(e.code);
  fromKeys();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  fromKeys();
});

const api: HarnessNetApi = {
  state,
  setLink,
  auto: setAuto,
  hold(name, dx, dy) {
    const c = clients.find((k) => k.name === name);
    if (c) c.held = { dx, dy };
  },
  drop: () => hub.dropAll(),
  reset,
};
window.__harnessNet = api;
