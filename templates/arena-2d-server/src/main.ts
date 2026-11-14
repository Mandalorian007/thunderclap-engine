/**
 * Arena: the client. The server (`server/`, Rust) owns the game; this page joins it, moves its own
 * player at once (prediction: it runs the server's `step` itself, `src/rules.ts`) and draws the
 * others a little in the past, between the snapshots the server streams (`SnapshotBuffer`).
 *
 * - `?server=ws://host:port` picks the server (default: this page's host, port 4711, or
 *   `VITE_ARENA_SERVER` at build time); `?name=` the player's name (default: a random one).
 * - Arrow keys or WASD move; on a touch screen, hold a finger where to go.
 * - `window.__arena` is the test probe (`e2e/arena-2d-server.spec.ts`).
 */
import { composeGame } from '@thunderclap-engine/engine/kit';
import { type Connect, createNet, EMPTY } from '@thunderclap-engine/engine/net';
import type { DrawParams } from '@thunderclap-engine/engine/render';
import { DOWN, HEIGHT, LEFT, RADIUS, RIGHT, STEP_MS, step, UP, WIDTH } from './rules';
import { schema } from './schema';
import type { Player, Pos, Score } from './types';

interface ArenaProbe {
  status: string;
  player: number;
  me: Pos;
  others: { id: number; name: string; x: number; y: number; it: boolean }[];
  it: number;
  frames: number;
  corrections: number;
}

declare global {
  interface Window {
    __arena?: ArenaProbe;
  }
}

const probe: ArenaProbe = {
  status: 'connecting',
  player: 0,
  me: { x: 0, y: 0 },
  others: [],
  it: 0,
  frames: 0,
  corrections: 0,
};
window.__arena = probe;

const params = new URLSearchParams(location.search);
const serverUrl =
  params.get('server') ??
  (import.meta.env.VITE_ARENA_SERVER as string | undefined) ??
  `ws://${location.hostname || '127.0.0.1'}:4711`;
const name = params.get('name') ?? `player_${Math.floor(Math.random() * 1e6)}`;

/** A WebSocket per connection; the session reconnects on its own. */
const connect: Connect = (events) => {
  const ws = new WebSocket(serverUrl);
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

const net = createNet({
  schema,
  connect,
  // Dev guests: the server takes `guest:<name>` as that name.
  hello: { token: `guest:${name}` },
  entities: 'Player',
  snapshots: { dims: 2, stepMs: STEP_MS },
});
const predictor = net.predict<Pos, number>({
  step,
  equal: (a, b) => a.x === b.x && a.y === b.y,
  distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  start: { seq: 0, state: { x: WIDTH / 2, y: HEIGHT / 2 } },
  stepMs: STEP_MS,
});
// Everyone in the arena: the interest is the whole box.
net.setInterest(EMPTY);
net.on('welcome', () => {
  // The server's first `PlayerState` says where this player is: not a misprediction.
  predictor.expectReset();
});

const pos = new Float64Array(2);
const vel = new Float64Array(2);
net.on('entities', (changes) => {
  const now = performance.now();
  for (const id of changes.changed) {
    const p = net.entities?.get(id) as Player | undefined;
    if (!p) continue;
    pos[0] = p.x;
    pos[1] = p.y;
    vel[0] = p.vx;
    vel[1] = p.vy;
    net.snapshots.push(id, changes.tick, pos, vel, now);
  }
  for (const id of changes.gone) net.snapshots.remove(id);
  // The probe's view of the others: as the server last sent them (not per frame).
  const me = net.welcome?.player ?? 0;
  probe.others = [];
  for (const [id, p] of net.entities?.entities ?? []) {
    const v = p as unknown as Player;
    if (id !== me) probe.others.push({ id, name: v.name, x: v.x, y: v.y, it: v.it });
  }
});

let score: Score | null = null;
const hud = document.getElementById('hud') as HTMLElement;
net.query<Score>('score', {}, (s) => {
  score = s;
  const me = net.welcome?.player ?? 0;
  hud.textContent = s.players
    .filter((p) => p.present)
    .map(
      (p) =>
        `${Number(p.id) === me ? '▸ ' : ''}${p.name}${p.id === s.it ? ' (it)' : ''}: ${p.tags}`,
    )
    .join('   ');
});

// --- Input: keys held, or a finger held where to go -------------------------------------------

const KEYS: Record<string, number> = {
  ArrowLeft: LEFT,
  KeyA: LEFT,
  ArrowRight: RIGHT,
  KeyD: RIGHT,
  ArrowUp: UP,
  KeyW: UP,
  ArrowDown: DOWN,
  KeyS: DOWN,
};
let held = 0;
let target: Pos | null = null;
addEventListener('keydown', (e) => {
  const k = KEYS[e.code];
  if (k) {
    held |= k;
    e.preventDefault();
  }
});
addEventListener('keyup', (e) => {
  held &= ~(KEYS[e.code] ?? 0);
});
addEventListener('blur', () => {
  held = 0;
});

/** The keys that move the player towards `target` (within a step of it, none). */
function towards(me: Pos, t: Pos): number {
  let k = 0;
  if (t.x < me.x - RADIUS / 2) k |= LEFT;
  if (t.x > me.x + RADIUS / 2) k |= RIGHT;
  if (t.y < me.y - RADIUS / 2) k |= UP;
  if (t.y > me.y + RADIUS / 2) k |= DOWN;
  return k;
}

// One input a step, as the server takes them.
setInterval(() => {
  const keys = held || (target ? towards(predictor.state, target) : 0);
  if (keys !== 0) net.input(keys);
}, STEP_MS);

// --- Drawing -----------------------------------------------------------------------------------

const MAX = 8;
const floor: DrawParams = {
  x: WIDTH / 2,
  y: HEIGHT / 2,
  w: WIDTH,
  h: HEIGHT,
  tint: [0.07, 0.08, 0.11, 1],
};
const COLOURS: [number, number, number, number][] = [
  [0.3, 0.79, 0.94, 1],
  [0.97, 0.15, 0.52, 1],
  [0.56, 0.93, 0.56, 1],
  [1, 0.82, 0.4, 1],
  [0.7, 0.55, 1, 1],
  [1, 0.6, 0.3, 1],
  [0.4, 0.9, 0.85, 1],
  [0.95, 0.95, 0.95, 1],
];
const IT: [number, number, number, number] = [1, 0.15, 0.1, 1];
/** Pre-built draws: rings (it) under bodies, one each per seat. */
const rings: DrawParams[] = [];
const bodies: DrawParams[] = [];
for (let i = 0; i < MAX; i++) {
  rings.push({ x: 0, y: 0, w: RADIUS * 3, h: RADIUS * 3, tint: IT, rotation: Math.PI / 4 });
  bodies.push({ x: 0, y: 0, w: RADIUS * 2, h: RADIUS * 2, tint: COLOURS[i]! });
}
const other = new Float64Array(2);

const root = document.getElementById('app') as HTMLElement;
const ctx = await composeGame({
  root,
  title: 'Arena',
  design: { width: WIDTH, height: HEIGHT },
  loop: { sim: { step: 1 / 60 } },
});

/** Pointer: a held finger (or mouse button) is where to go, in arena units. */
if (ctx) {
  const canvas = root.querySelector('canvas');
  const toArena = (e: PointerEvent): Pos => {
    const r = (canvas ?? root).getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * WIDTH,
      y: ((e.clientY - r.top) / r.height) * HEIGHT,
    };
  };
  root.addEventListener('pointerdown', (e) => {
    target = toArena(e);
  });
  root.addEventListener('pointermove', (e) => {
    if (target) target = toArena(e);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    root.addEventListener(ev, () => {
      target = null;
    });
  }

  ctx.stack.push({
    name: 'arena',
    render(frame) {
      const now = performance.now();
      net.snapshots.frame(now);
      const me = net.welcome?.player ?? 0;
      const it = score ? Number(score.it) : 0;
      frame.sprite(null, floor);
      // The others, drawn where they were a moment ago.
      if (net.entities) {
        for (const [id, p] of net.entities.entities) {
          if (id === me || !net.snapshots.at(id, other)) continue;
          const i = (id - 1) % MAX;
          const v = p as unknown as Player;
          if (v.it) {
            rings[i]!.x = other[0]!;
            rings[i]!.y = other[1]!;
            frame.sprite(null, rings[i]!);
          }
          bodies[i]!.x = other[0]!;
          bodies[i]!.y = other[1]!;
          frame.sprite(null, bodies[i]!);
        }
      }
      // This player, where its predictor puts it, between its last two steps.
      if (me > 0) {
        const i = (me - 1) % MAX;
        const a = predictor.alpha();
        const x = predictor.previous.x + (predictor.state.x - predictor.previous.x) * a;
        const y = predictor.previous.y + (predictor.state.y - predictor.previous.y) * a;
        if (it === me) {
          rings[i]!.x = x;
          rings[i]!.y = y;
          frame.sprite(null, rings[i]!);
        }
        bodies[i]!.x = x;
        bodies[i]!.y = y;
        frame.sprite(null, bodies[i]!);
      }
      probe.status = net.status;
      probe.player = me;
      probe.me.x = predictor.state.x;
      probe.me.y = predictor.state.y;
      probe.it = it;
      probe.corrections = predictor.correctionCount;
      probe.frames++;
    },
  });
  ctx.loop.start();
}
