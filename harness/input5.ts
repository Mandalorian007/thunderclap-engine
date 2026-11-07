/**
 * Input-5 page (ws/input-5): action contexts, the input buffer, the three stick shapes, gyro
 * aim, `Look.onTap` and the all-pointer record lane, on a 2D canvas (no WebGPU) so
 * e2e/input5.spec.ts can check them on every matrix row. Noun-free. One mode per query:
 *
 * - `?contexts`: gameplay binds `attack` to J; at t = 1 s a `menu` context (pass `'none'`) is
 *   pushed that binds `confirm` to J and Enter and `back` to Escape, which pops it.
 * - `?buffer`: a scripted press of `jump`; `buffered('jump', 100)` 3 ticks later, `consume`,
 *   `buffered` again; a second press read 7 ticks later.
 * - `?stick`: a fake pad's left stick circles (parked at (0.6, 0.1) with `?still`), read through
 *   `input.stick` in each shape and drawn as three dots.
 * - `?gyro`: a fake rotation-rate source (45 deg/s right, 20 deg/s up) through `Look.gyro`
 *   turns the camera line; `?still` stops it.
 * - `?tap`: an orbit `Look` with `onTap`; each tap drops a marker, reported in logical px.
 * - `?replay`: a scripted two-thumb session on touch zones over a hidden element is recorded,
 *   replayed into a fresh `Input`, and every tick's action states compared.
 */
import {
  type Binding,
  createGyroSource,
  createInputPlayback,
  createInputRecorder,
  createTouchZones,
  Gestures,
  type GyroEnv,
  Input,
  type InputRecording,
  Look,
  type StickShape,
} from '@thunderclap-engine/engine/input';
import type { HarnessInput5Api, HarnessInput5State, Input5Mode } from './input5-state';

const params = new URLSearchParams(location.search);
const MODES: readonly Input5Mode[] = ['contexts', 'buffer', 'stick', 'gyro', 'tap', 'replay'];
const mode = MODES.find((m) => params.has(m)) ?? 'contexts';
const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const panel = document.getElementById('panel') as HTMLElement;
const padEl = document.getElementById('pad') as HTMLElement;
const W = 960;
const H = 540;
const TICK_MS = 1000 / 60;

const state: HarnessInput5State = {
  ready: false,
  mode,
  still: params.has('still'),
  frames: 0,
  ticks: 0,
  context: null,
  attackFired: 0,
  confirmFired: 0,
  buffered: null,
  consumed: null,
  bufferedAfter: null,
  bufferedLate: null,
  raw: [0, 0],
  radial: [0, 0],
  axial: [0, 0],
  scaledRadial: [0, 0],
  yaw: 0,
  pitch: 0,
  taps: [],
  recorded: 0,
  replayed: 0,
  match: null,
};
const api: HarnessInput5Api = {
  state,
  setStill(still) {
    state.still = still;
  },
};
window.__harnessInput5 = api;

/** Client px to the canvas's 960 x 540 logical px. */
const toLogical = (x: number, y: number) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((x - r.left) * W) / r.width, y: ((y - r.top) * H) / r.height };
};

// ------------------------------------------------------------------ modes

/** One fixed tick: feed, `input.update()`, read. */
let step: () => void = () => {};
/** Draw the frame. */
let draw: () => void = () => {};

if (mode === 'contexts') {
  const input = new Input(
    {
      attack: [{ key: 'KeyJ' }] as Binding[],
      confirm: [] as Binding[],
      back: [] as Binding[],
    },
    {},
  );
  input.attach({ pointerTarget: canvas });
  let pushed = false;
  step = () => {
    if (!pushed && state.ticks * TICK_MS >= 1000) {
      pushed = true;
      input.pushContext('menu', {
        bindings: { confirm: [{ key: 'KeyJ' }, { key: 'Enter' }], back: [{ key: 'Escape' }] },
        pass: 'none',
      });
    }
    input.update();
    if (input.pressed('attack')) state.attackFired++;
    if (input.pressed('confirm')) state.confirmFired++;
    if (input.pressed('back')) input.popContext('menu');
    state.context = input.context;
  };
  draw = () => {
    ctx.fillStyle = state.context === 'menu' ? '#3a4a7a' : '#2a5a3a';
    ctx.fillRect(W / 2 - 160, H / 2 - 60, 320, 120);
    ctx.fillStyle = '#fff';
    ctx.font = '28px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(state.context ?? 'gameplay', W / 2, H / 2 + 10);
  };
} else if (mode === 'buffer') {
  const input = new Input({ jump: [{ key: 'Space' }] as Binding[] }, { getGamepads: () => [] });
  let n = 0;
  step = () => {
    if (n === 30 || n === 60) input.keyDown('Space');
    input.update();
    n++;
    if (n === 31 || n === 61) input.keyUp('Space');
    if (n === 34) {
      state.buffered = input.buffered('jump', 100);
      state.consumed = input.consume('jump');
      state.bufferedAfter = input.buffered('jump', 100);
    }
    if (n === 68) state.bufferedLate = input.buffered('jump', 100);
  };
  draw = () => {
    const row = (label: string, v: boolean | null, y: number) => {
      ctx.fillStyle = v === null ? '#445' : v ? '#7c6' : '#c66';
      ctx.fillRect(W / 2 - 200, y, 40, 40);
      ctx.fillStyle = '#dde';
      ctx.font = '20px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(label, W / 2 - 140, y + 28);
    };
    row('buffered', state.buffered, 160);
    row('consumed', state.consumed, 220);
    row('after consume', state.bufferedAfter, 280);
    row('7 ticks late', state.bufferedLate, 340);
  };
} else if (mode === 'stick') {
  const axes = [0, 0];
  const pad = { connected: true, buttons: [], axes };
  const input = new Input(
    {
      left: [{ padAxis: 0, dir: -1, threshold: 0 }] as Binding[],
      right: [{ padAxis: 0, dir: 1, threshold: 0 }] as Binding[],
      up: [{ padAxis: 1, dir: -1, threshold: 0 }] as Binding[],
      down: [{ padAxis: 1, dir: 1, threshold: 0 }] as Binding[],
    },
    { getGamepads: () => [pad] },
  );
  const SHAPES: readonly StickShape[] = ['radial', 'axial', 'scaledRadial'];
  let phase = 0;
  step = () => {
    if (state.still) {
      axes[0] = 0.6;
      axes[1] = 0.1;
    } else {
      phase += TICK_MS / 1000;
      const m = 0.5 + 0.5 * Math.sin(phase * 0.7);
      axes[0] = Math.cos(phase) * m;
      axes[1] = Math.sin(phase) * m;
    }
    input.update();
    state.raw[0] = axes[0]!;
    state.raw[1] = axes[1]!;
    for (const shape of SHAPES) input.stick('left', 'right', 'up', 'down', state[shape], { shape });
  };
  const COLOURS: Record<StickShape, string> = {
    radial: '#e96',
    axial: '#6ce',
    scaledRadial: '#ae6',
  };
  draw = () => {
    SHAPES.forEach((shape, i) => {
      const cx = 200 + i * 280;
      const cy = H / 2;
      ctx.strokeStyle = '#556';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 100, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#334';
      ctx.beginPath();
      ctx.arc(cx + state.raw[0] * 100, cy + state.raw[1] * 100, 6, 0, Math.PI * 2);
      ctx.fill();
      const [x, y] = state[shape];
      ctx.fillStyle = COLOURS[shape];
      ctx.beginPath();
      ctx.arc(cx + x * 100, cy + y * 100, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#dde';
      ctx.font = '18px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(shape, cx, cy + 140);
    });
  };
} else if (mode === 'gyro') {
  // No real sensor in CI: a fake source fed each tick.
  const env: GyroEnv = { target: { addEventListener() {}, removeEventListener() {} } };
  const gyro = createGyroSource({ env, sensitivity: 1 });
  const look = new Look({ gyro, getGamepads: () => [] });
  step = () => {
    // 45 deg/s turning right (negative about the screen's up axis), 20 deg/s tilting up.
    if (!state.still) gyro.feed(0, 20, -45, TICK_MS);
    look.update();
    state.yaw += look.look.dx;
    state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch + look.look.dy));
  };
  draw = () => {
    const cx = W / 2;
    const cy = H / 2;
    ctx.strokeStyle = '#556';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 180, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#6ce';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(state.yaw) * 180, cy - Math.cos(state.yaw) * 180);
    ctx.stroke();
    ctx.fillStyle = '#ae6';
    ctx.fillRect(W - 60, cy - state.pitch * 150 - 4, 40, 8);
  };
} else if (mode === 'tap') {
  const look = new Look({ mode: 'orbit', touch: { moveZone: 'none' }, getGamepads: () => [] });
  const input = new Input({}, { look });
  input.attach({ pointerTarget: canvas });
  input.setPointerTransform(toLogical);
  look.onTap((x, y) => state.taps.push([Math.round(x), Math.round(y)]));
  step = () => input.update();
  draw = () => {
    ctx.fillStyle = '#e96';
    for (const [x, y] of state.taps) {
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  };
} else {
  // ?replay: a scripted two-thumb session, recorded, then replayed into a fresh input.
  type A = 'moveLeft' | 'moveRight' | 'moveUp' | 'moveDown' | 'jump';
  const game = () => {
    const input = new Input<A>(
      { moveLeft: [], moveRight: [], moveUp: [], moveDown: [], jump: [] },
      { getGamepads: () => [], gestures: new Gestures() },
    );
    input.attach({ pointerTarget: padEl });
    const zones = createTouchZones(input, {
      zones: {
        move: {
          kind: 'stick',
          rect: (w, h) => ({ x: 0, y: 0, w: w / 2, h }),
          radius: 50,
          deadZone: 0,
        },
        act: {
          kind: 'buttons',
          rect: (w, h) => ({ x: w / 2, y: 0, w: w / 2, h }),
          buttons: { jump: (w) => ({ x: w / 2, y: 0, w: w / 2, h: 200 }) },
        },
      },
      bindings: {
        moveLeft: { zone: 'move', axis: 'x', dir: -1 },
        moveRight: { zone: 'move', axis: 'x', dir: 1 },
        moveUp: { zone: 'move', axis: 'y', dir: -1 },
        moveDown: { zone: 'move', axis: 'y', dir: 1 },
        jump: { zone: 'act', button: 'jump' },
      },
    });
    const snap = () =>
      JSON.stringify(
        (['moveLeft', 'moveRight', 'moveUp', 'moveDown', 'jump'] as const).map((a) => {
          const s = input.state(a);
          return [s.pressed, s.held, s.released, Math.round(s.value * 1000)];
        }),
      );
    return { input, zones, snap };
  };
  const touch = (type: string, id: number, x: number, y: number) =>
    padEl.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        clientX: x,
        clientY: y,
        pointerType: 'touch',
        isPrimary: id === 1,
        button: 0,
        bubbles: true,
      }),
    );
  /** Thumb 1 circles in the move zone; thumb 2 taps jump three times. */
  const script = (n: number) => {
    if (n === 0) touch('pointerdown', 1, 100, 200);
    else if (n < 90) {
      const a = n / 10;
      touch('pointermove', 1, 100 + Math.cos(a) * 40, 200 + Math.sin(a) * 40);
    } else if (n === 90) touch('pointerup', 1, 100, 200);
    if (n === 10 || n === 40 || n === 70) touch('pointerdown', 2, 600 + n, 100);
    if (n === 20 || n === 50 || n === 80) touch('pointerup', 2, 600 + n - 10, 100);
  };
  const LENGTH = 100;
  let live: ReturnType<typeof game> | null = game();
  const recorder = createInputRecorder(live.input);
  const want: string[] = [];
  let recording: InputRecording | null = null;
  let replay: ReturnType<typeof game> | null = null;
  let playback: ReturnType<typeof createInputPlayback> | null = null;
  let matched = true;
  step = () => {
    if (live) {
      script(state.recorded);
      live.input.update();
      want.push(live.snap());
      state.recorded++;
      if (state.recorded === LENGTH) {
        recording = recorder.stop();
        live.zones.destroy();
        live.input.detach();
        live = null;
        replay = game();
        playback = createInputPlayback(replay.input, JSON.parse(JSON.stringify(recording)));
      }
    } else if (replay && playback && state.match === null) {
      if (playback.step()) {
        replay.input.update();
        if (replay.snap() !== want[state.replayed]) matched = false;
        state.replayed++;
      } else {
        state.match = matched && state.replayed === want.length;
        replay.zones.destroy();
        replay.input.detach();
      }
    }
  };
  draw = () => {
    ctx.fillStyle = '#dde';
    ctx.font = '22px monospace';
    ctx.textAlign = 'center';
    const m = state.match === null ? '...' : state.match ? 'match' : 'MISMATCH';
    ctx.fillText(`recorded ${state.recorded}  replayed ${state.replayed}  ${m}`, W / 2, H / 2);
  };
}

// ------------------------------------------------------------------ loop

let last = performance.now();
let acc = 0;
function frame(now: number): void {
  acc += Math.min(250, now - last);
  last = now;
  let steps = 0;
  while (acc >= TICK_MS && steps < 8) {
    acc -= TICK_MS;
    step();
    state.ticks++;
    steps++;
  }
  if (steps === 8) acc = 0;
  ctx.fillStyle = '#141a28';
  ctx.fillRect(0, 0, W, H);
  draw();
  state.frames++;
  panel.textContent = `${mode}${state.still ? ' (still)' : ''}  tick ${state.ticks}`;
  requestAnimationFrame(frame);
}
state.ready = true;
requestAnimationFrame(frame);
