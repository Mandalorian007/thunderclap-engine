/**
 * Input recording and replay (ws/input-replay). A recorder sits beside an `Input` through its
 * feed hook (`Input.onFeed`) and writes down, tick by tick, every feed call and the gamepad
 * snapshot `update()` read. A playback feeds the same calls back into an `Input` before each
 * `update()` and hands it the recorded pads, so an identical game sees identical `pressed`,
 * `held`, `released` and `value` per tick. Neither changes how `Input` evaluates bindings.
 *
 * The recording is plain JSON: `{ version: 3, ticks: [...] }`, deltas only. A tick with events
 * is `{ t, k?, b?, p?, w?, r?, d?, g?, ptr?, cx?, cs? }`; a run of ticks with none is `{ t, n }`.
 * Version 2 (ws/input-5) adds the `ptr` lane (every pointer the dispatcher saw, so touch zones,
 * gestures and a second thumb replay) and the observational `cx` and `cs`. Version 3
 * (ws/input-7) stamps each `ptr` entry with its time, so a replayed tap, long-press or
 * double-tap classifies as it did live. Versions 1 and 2 still parse and play. A recording may
 * carry `tickMs`, its tick spacing (ws/input-9), which a playback given a tick `clock` advances
 * it by per fed tick, so a replay at any `speed` keeps game time.
 */
import { type TickClock, wallClock } from './clock';
import type { Input, InputFeedHook, InputPointerPhase } from './input';
import type { GamepadLike, PointerState } from './types';

/** The linked gestures' clock, else the linked look's, else the wall clock. */
function linkedClock<A extends string>(input: Input<A>): () => number {
  const g = input.getGestures();
  if (g) return g.now;
  const look = input.getLook();
  if (look) return () => look.clock.now();
  return wallClock.now;
}

/** True when neither the linked gestures nor the linked look has a clock of its own. */
function onWallClock<A extends string>(input: Input<A>): boolean {
  const g = input.getGestures();
  if (g) return g.clock === wallClock;
  const look = input.getLook();
  return !look || look.clock === wallClock;
}

/** One gamepad as recorded: button values (1 when `pressed`) and axes. `null` for an empty slot. */
export type PadSnapshot = { buttons: number[]; axes: number[] } | null;

/** A tick on which something was fed. Fields are present only when that kind of event happened. */
export interface InputTickEvents {
  /** Tick index, counted from the recorder's start. */
  t: number;
  /** Keys, in call order: `[code, 1]` down, `[code, 0]` up. */
  k?: [string, 0 | 1][];
  /** Mouse buttons, in call order: `[button, 1]` down, `[button, 0]` up. */
  b?: [number, 0 | 1][];
  /** The last pointer position fed this tick, client CSS px; the type when not `mouse`. */
  p?: [number, number, PointerState['type']?];
  /** Wheel delta summed over the tick. */
  w?: [number, number];
  /** `releaseAll` was called (replayed first on the tick). */
  r?: 1;
  /**
   * A key went down after the tick's last pointer position was fed, so the keyboard is the
   * `lastDevice`; the playback then feeds `p` before `k`. Absent, `p` is fed after `k`.
   */
  d?: 1;
  /** The pads `update()` read, when they differ from the previous snapshot. */
  g?: PadSnapshot[];
  /**
   * `Input.rumble` calls this tick, in call order: `[strong, weak, ms]` or `[strong, weak, ms,
   * pad]`. Playback does not re-issue them (the game does, from the same inputs); they are kept
   * so a replay can assert the game rumbled when it should.
   */
  rumble?: [number, number, number, number?][];
  /**
   * Every pointer event the attached dispatcher delivered this tick, in order (version 2): see
   * `InputPointerEntry`. Consecutive moves of one pointer keep only the last. Playback dispatches
   * them on the attached pointer target after the other lanes; without one they are skipped.
   */
  ptr?: InputPointerEntry[];
  /**
   * Context pushes (`[name, 1]`) and removals (`[name, 0]`) this tick, in order (version 2).
   * Observational, like `rumble`: the game pushes them again from the same inputs.
   */
  cx?: [string, 0 | 1][];
  /** Actions `consume`d this tick, in order (version 2). Observational. */
  cs?: string[];
}

/**
 * One recorded pointer event: `[phase, id, device, clientX, clientY, button, primary, time]`,
 * phase 0 down, 1 move, 2 up, 3 cancel, 4 leave; `primary` 1 or 0. `time` (version 3) is when
 * the event happened, ms since the recorder started, on the recorder's clock (the linked
 * gestures' `now`), rounded to 0.01 ms; version 2 entries have no `time`. A window blur is
 * recorded as a cancel of every pointer still down.
 */
export type InputPointerEntry = [
  0 | 1 | 2 | 3 | 4,
  number,
  'mouse' | 'touch' | 'pen',
  number,
  number,
  number,
  0 | 1,
  number?,
];

const PHASES: readonly InputPointerPhase[] = ['down', 'move', 'up', 'cancel', 'leave'];

/** A run of `n` ticks starting at `t` on which nothing was fed. */
export interface InputTickRun {
  t: number;
  n: number;
}

export type InputTick = InputTickEvents | InputTickRun;

/** What `createInputRecorder` builds and `createInputPlayback` reads. Plain JSON. */
export interface InputRecording {
  /** 3 from ws/input-7 (`ptr` entries carry `time`); 2 (ws/input-5: `ptr`, `cx`, `cs`) and 1 still read. */
  version: 1 | 2 | 3;
  ticks: InputTick[];
  /**
   * Ms between ticks while recording (ws/input-9): the mean spacing on the recorder's clock
   * (exactly the fixed step on a `createTickClock()`), or `Input.tickMs` when the recorder ran on
   * the wall clock. A playback given a `clock` advances it by this per fed tick. Absent in
   * recordings made before ws/input-9 and in a recording of no ticks.
   */
  tickMs?: number;
}

export interface InputRecorderOptions {
  /** Capture the pads `update()` reads. Default true. */
  pads?: boolean;
  /**
   * The clock pointer `time`s are stamped on (ws/input-7). Default: the clock of the gestures
   * linked to the input when the recorder is made (`Gestures.now`), else the linked look's
   * (`Look.clock`, ws/input-8), else `performance.now()`. With a `createTickClock()` shared by
   * gestures and look, times are game time.
   */
  now?: () => number;
}

export interface InputRecorder {
  /**
   * Close the current tick. Called for you from `input.update()` (through the feed hook), so a
   * game never calls it; it is public for driving a recorder by hand in tests.
   */
  tick(): void;
  /** Uninstall the hook and return the recording (the same object as `recording`). */
  stop(): InputRecording;
  /** The recording so far, live. */
  readonly recording: InputRecording;
  /** Ticks recorded so far. */
  readonly ticks: number;
}

export interface InputPlaybackOptions {
  /** Ticks fed per `step()`. Default 1. See `InputPlayback.speed`. */
  speed?: number;
  /**
   * The clock recorded pointer `time`s replay on (ws/input-7). Default: `clock` when given, else
   * the clock of the gestures linked to the input when the playback is made (`Gestures.now`),
   * else the linked look's (`Look.clock`, ws/input-8), else `performance.now()`. On a
   * `createTickClock()` the replay is the same on every tick index whatever the wall time
   * between `step()`s.
   */
  now?: () => number;
  /**
   * A tick clock the playback drives (ws/input-9): every fed tick advances it by `tickMs`, after
   * the tick's events are fed and before its `update()`, as a fixed step does live. So
   * `speed: 4` advances it 4 × `tickMs` per `step()`, and a long-press fires on the same recorded
   * tick at any speed. Pass the clock the input's gestures and look run on, and stop advancing it
   * from the game's own step while the playback is installed (`InputPlayback.clock` says which
   * clock it drives). Omitted, the playback advances nothing (the default, as before).
   */
  clock?: TickClock;
  /**
   * Ms a fed tick advances `clock` by. Default: the recording's `tickMs`, else the input's
   * `Input.tickMs` (for recordings made before ws/input-9).
   */
  tickMs?: number;
}

export interface InputPlayback {
  /**
   * Feed the next tick's events into the input (then the caller runs `input.update()`). With
   * `speed` above 1, the extra ticks are fed and updated inside the call, so the input
   * fast-forwards; the caller's game logic only sees the last one. Returns false when the
   * recording is finished and nothing was fed.
   */
  step(): boolean;
  /** True once every recorded tick has been fed. */
  readonly done: boolean;
  /** The next tick to feed. */
  readonly tick: number;
  /** Total ticks in the recording. */
  readonly length: number;
  /** Jump to a tick. The input gets `releaseAll()` first; skipped ticks are not fed. */
  seek(tick: number): void;
  /** Ticks per `step()` (an integer of at least 1). */
  speed: number;
  /** The tick clock this playback advances per fed tick (`InputPlaybackOptions.clock`), or null. */
  readonly clock: TickClock | null;
  /** Ms each fed tick advances `clock` by (`InputPlaybackOptions.tickMs`, resolved). */
  readonly tickMs: number;
  /** Uninstall the hook; `input.playback` is null again. */
  detach(): void;
}

/** Called when a recording does not have the expected shape. */
export class InputRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputRecordingError';
  }
}

/** Total ticks a recording covers. */
export function recordingLength(rec: InputRecording): number {
  const last = rec.ticks[rec.ticks.length - 1];
  if (!last) return 0;
  return last.t + ('n' in last ? last.n : 1);
}

function isRun(tick: InputTick): tick is InputTickRun {
  return 'n' in tick;
}

// ---------------------------------------------------------------- recorder

/**
 * Record everything `input` is fed. The recorder installs a feed hook and closes one tick per
 * `input.update()`; `stop()` removes it. `input.recorder` points at it meanwhile.
 */
export function createInputRecorder<A extends string>(
  input: Input<A>,
  opts: InputRecorderOptions = {},
): InputRecorder {
  const capturePads = opts.pads !== false;
  const recording: InputRecording = { version: 3, ticks: [] };
  const clock = opts.now ?? linkedClock(input);
  const start = clock();
  /** The spacing is measured on the recorder's clock unless that is the wall clock. */
  const measure = opts.now !== undefined || !onWallClock(input);
  /** ms since `start`, `age` ms ago, to 0.01 ms. */
  const stamp = (age: number): number => Math.round((clock() - age - start) * 100) / 100;
  /** Pointers down (by id), for turning a blur into cancels. */
  const live = new Map<number, InputPointerEntry>();
  let t = 0;
  /** The tick being built, or null while nothing happened on it. */
  let cur: InputTickEvents | null = null;
  /** The last pad snapshot written, for the delta comparison. */
  let lastPads: PadSnapshot[] = [];
  let padsWritten = false;

  const open = (): InputTickEvents => {
    if (!cur) cur = { t };
    return cur;
  };

  const key = (code: string, down: 0 | 1): void => {
    const c = open();
    if (c.k) c.k.push([code, down]);
    else c.k = [[code, down]];
    if (down && c.p) c.d = 1;
  };
  const button = (b: number, down: 0 | 1): void => {
    const c = open();
    if (c.b) c.b.push([b, down]);
    else c.b = [[b, down]];
  };

  const hook: InputFeedHook = {
    keyDown: (code) => key(code, 1),
    keyUp: (code) => key(code, 0),
    buttonDown: (b) => button(b, 1),
    buttonUp: (b) => button(b, 0),
    wheel: (dx, dy) => {
      const c = open();
      if (c.w) {
        c.w[0] += dx;
        c.w[1] += dy;
      } else c.w = [dx, dy];
    },
    pointerAt: (x, y, type) => {
      const c = open();
      c.p = type === 'mouse' ? [x, y] : [x, y, type];
      if (c.d) delete c.d;
    },
    releaseAll: () => {
      open().r = 1;
    },
    rumble: (strong, weak, ms, pad) => {
      const c = open();
      const e: [number, number, number, number?] =
        pad === undefined ? [strong, weak, ms] : [strong, weak, ms, pad];
      if (c.rumble) c.rumble.push(e);
      else c.rumble = [e];
    },
    pointer: (phase, p) => {
      const c = open();
      const ph = PHASES.indexOf(phase) as InputPointerEntry[0];
      const e: InputPointerEntry = [
        ph,
        p.id,
        p.device,
        p.clientX,
        p.clientY,
        p.button,
        p.primary ? 1 : 0,
        stamp(p.age),
      ];
      if (!c.ptr) c.ptr = [];
      const lane = c.ptr;
      const last = lane[lane.length - 1];
      if (ph === 1 && last && last[0] === 1 && last[1] === p.id) lane[lane.length - 1] = e;
      else lane.push(e);
      if (ph === 0 || (ph === 1 && live.has(p.id))) live.set(p.id, e);
      else if (ph === 2 || ph === 3) live.delete(p.id);
    },
    cancelPointers: () => {
      if (live.size === 0) return;
      const c = open();
      if (!c.ptr) c.ptr = [];
      const lane = c.ptr;
      const at = stamp(0);
      for (const e of live.values()) lane.push([3, e[1], e[2], e[3], e[4], e[5], e[6], at]);
      live.clear();
    },
    context: (name, pushed) => {
      const c = open();
      if (!c.cx) c.cx = [];
      c.cx.push([name, pushed ? 1 : 0]);
    },
    consume: (action) => {
      const c = open();
      if (!c.cs) c.cs = [];
      c.cs.push(action);
    },
    gamepads: (pads) => {
      if (capturePads && !samePads(lastPads, pads, padsWritten)) {
        lastPads = snapshotPads(pads);
        padsWritten = true;
        open().g = lastPads;
      }
      rec.tick();
      return pads;
    },
  };

  const rec: InputRecorder = {
    tick() {
      if (cur) {
        recording.ticks.push(cur);
        cur = null;
      } else {
        const last = recording.ticks[recording.ticks.length - 1];
        if (last && isRun(last) && last.t + last.n === t) last.n++;
        else recording.ticks.push({ t, n: 1 });
      }
      t++;
      const ms = measure ? (clock() - start) / t : input.tickMs;
      if (ms > 0 && Number.isFinite(ms)) recording.tickMs = ms;
    },
    stop() {
      remove();
      if (input.recorder === rec) input.recorder = null;
      return recording;
    },
    get recording() {
      return recording;
    },
    get ticks() {
      return t;
    },
  };
  const remove = input.onFeed(hook);
  input.recorder = rec;
  return rec;
}

/** Button value as recorded: `pressed` counts as 1, as `Input.evaluate` reads it. */
function buttonValue(b: { pressed: boolean; value: number }): number {
  return b.pressed ? Math.max(1, b.value) : b.value;
}

/**
 * True when the live pads equal the snapshot. Before any snapshot is written the implied state
 * is "no pad connected", so a page whose `navigator.getGamepads()` is four empty slots records
 * nothing. Allocation-free.
 */
function samePads(
  snap: PadSnapshot[],
  pads: readonly (GamepadLike | null)[],
  written: boolean,
): boolean {
  if (!written) {
    for (const p of pads) if (p && p.connected !== false) return false;
    return true;
  }
  if (snap.length !== pads.length) return false;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    const s = snap[i];
    const live = p && p.connected !== false ? p : null;
    if (!live || !s) {
      if (live || s) return false;
      continue;
    }
    if (s.buttons.length !== live.buttons.length || s.axes.length !== live.axes.length)
      return false;
    for (let j = 0; j < live.buttons.length; j++) {
      if (s.buttons[j] !== buttonValue(live.buttons[j]!)) return false;
    }
    for (let j = 0; j < live.axes.length; j++) if (s.axes[j] !== live.axes[j]) return false;
  }
  return true;
}

function snapshotPads(pads: readonly (GamepadLike | null)[]): PadSnapshot[] {
  const out: PadSnapshot[] = [];
  for (const p of pads) {
    if (!p || p.connected === false) out.push(null);
    else out.push({ buttons: p.buttons.map(buttonValue), axes: [...p.axes] });
  }
  return out;
}

// ---------------------------------------------------------------- playback

/**
 * Replay `recording` into `input`. Call `step()` before each `input.update()`; the input's
 * `getGamepads` result is replaced by the recorded snapshot while the playback is installed.
 * `input.playback` points at it until `detach()`.
 */
export function createInputPlayback<A extends string>(
  input: Input<A>,
  recording: InputRecording,
  opts: InputPlaybackOptions = {},
): InputPlayback {
  const ticks = recording.ticks;
  const length = recordingLength(recording);
  let tick = 0;
  /** Index into `ticks` of the entry covering `tick`. */
  let index = 0;
  let pads: GamepadLike[] = [];
  let speed = Math.max(1, Math.floor(opts.speed ?? 1));
  /** Replayed pointers still down, cancelled on `seek`. */
  const live = new Map<number, InputPointerEntry>();
  const driven = opts.clock ?? null;
  const clock = opts.now ?? (driven ? () => driven.now() : linkedClock(input));
  const tickMs = positive(opts.tickMs) ?? positive(recording.tickMs) ?? input.tickMs;
  /**
   * Anchor at the first `step()` (ws/input-10) unless the clock is the wall clock, whose readings
   * between steps follow the replay's frame rate rather than its ticks.
   */
  const anchorAtStep = opts.now !== undefined || driven !== null || !onWallClock(input);
  /**
   * The clock reading that recorded time 0 maps to. Off the wall clock it is set at the first
   * `step()` (and the first after a `seek`): that reading less the fed tick's recorded start
   * (`tick × tickMs`), so the first event keeps its recorded age however late the replay starts.
   * On the wall clock, and wherever that anchor would put the first timed entry after the
   * moment it is fed, the first timed entry sets it so that entry happens as it is fed (age 0),
   * as before ws/input-10. `null` until then.
   */
  let base: number | null = null;
  /** Set at creation and by `seek`: the next `step()` anchors `base`. */
  let fresh = true;
  /** Set with `fresh`: the next timed entry may re-anchor `base` (see above). */
  let firstTimed = true;

  const replayPointer = (e: InputPointerEntry): void => {
    // Version 3 entries happen at their recorded offset from tick 0; older ones (and the
    // cancels `seek` makes) when their tick is fed, so their timing is the replay's tick spacing.
    const time = e[7];
    let age = 0;
    if (time !== undefined) {
      const now = clock();
      // An event cannot happen after it is handled: a step anchor that would say so (a
      // recording made with the clock advanced before the events, or a frozen replay clock)
      // gives way to the entry itself.
      if (base === null || (firstTimed && now < base + time)) base = now - time;
      firstTimed = false;
      age = now - (base + time);
    }
    input.replayPointer(PHASES[e[0]]!, e[1], e[2], e[3], e[4], e[5], e[6] === 1, age);
    if (e[0] === 0 || (e[0] === 1 && live.has(e[1]))) live.set(e[1], e);
    else if (e[0] === 2 || e[0] === 3) live.delete(e[1]);
  };

  const feedTick = (): void => {
    // Advance the entry cursor to the one covering this tick.
    while (index < ticks.length) {
      const e = ticks[index]!;
      if (tick < e.t + (isRun(e) ? e.n : 1)) break;
      index++;
    }
    const e = ticks[index];
    tick++;
    if (!e || isRun(e) || e.t !== tick - 1) return;
    if (e.r) input.releaseAll();
    // Only `keyDown` and `pointerAt` set `lastDevice`, so their relative order is all that is
    // kept: the pointer goes first when a key came down after it (`d`), last otherwise.
    if (e.d && e.p) input.pointerAt(e.p[0], e.p[1], e.p[2] ?? 'mouse');
    if (e.k) {
      for (const [code, down] of e.k) {
        if (down) input.keyDown(code);
        else input.keyUp(code);
      }
    }
    // The pointer moves before the buttons (ws/input-8), as a DOM pointer event sets the
    // position before its button: an orbit look's drag then starts where the press was, not at
    // the previous position.
    if (e.p && !e.d) input.pointerAt(e.p[0], e.p[1], e.p[2] ?? 'mouse');
    if (e.b) {
      for (const [button, down] of e.b) {
        if (down) input.buttonDown(button);
        else input.buttonUp(button);
      }
    }
    if (e.w) input.wheel(e.w[0], e.w[1]);
    if (e.ptr) for (const p of e.ptr) replayPointer(p);
    if (e.g) pads = e.g.map(padFromSnapshot);
  };

  const hook: InputFeedHook = {
    keyDown: noop,
    keyUp: noop,
    buttonDown: noop,
    buttonUp: noop,
    wheel: noop,
    pointerAt: noop,
    releaseAll: noop,
    padSource: () => pads,
    gamepads: () => pads,
  };

  /** Feed one tick, then advance the driven clock past it, as a live fixed step does. */
  const feedAndAdvance = (): void => {
    feedTick();
    driven?.advance(tickMs);
  };

  const pb: InputPlayback = {
    step() {
      if (tick >= length) return false;
      if (fresh) {
        fresh = false;
        if (anchorAtStep) base = clock() - tick * tickMs;
      }
      feedAndAdvance();
      for (let i = 1; i < speed && tick < length; i++) {
        input.update();
        feedAndAdvance();
      }
      return true;
    },
    get done() {
      return tick >= length;
    },
    get tick() {
      return tick;
    },
    get length() {
      return length;
    },
    seek(to) {
      for (const e of [...live.values()]) replayPointer([3, e[1], e[2], e[3], e[4], e[5], e[6]]);
      input.releaseAll();
      tick = Math.max(0, Math.min(length, Math.floor(to)));
      index = 0;
      base = null;
      fresh = true;
      firstTimed = true;
      // The pads in force at `to` are the last snapshot at or before it.
      pads = [];
      for (const e of ticks) {
        if (e.t >= tick) break;
        if (!isRun(e) && e.g) pads = e.g.map(padFromSnapshot);
      }
    },
    get speed() {
      return speed;
    },
    set speed(v) {
      speed = Math.max(1, Math.floor(v));
    },
    clock: driven,
    tickMs,
    detach() {
      remove();
      if (input.playback === pb) input.playback = null;
    },
  };
  const remove = input.onFeed(hook);
  input.playback = pb;
  return pb;
}

function noop(): void {}

function positive(v: number | undefined): number | undefined {
  return v !== undefined && v > 0 && Number.isFinite(v) ? v : undefined;
}

function padFromSnapshot(s: PadSnapshot): GamepadLike {
  if (!s) return DISCONNECTED;
  return {
    connected: true,
    buttons: s.buttons.map((v) => ({ pressed: v >= 1, value: v })),
    axes: s.axes,
  };
}

const DISCONNECTED: GamepadLike = { connected: false, buttons: [], axes: [] };

// ---------------------------------------------------------------- JSON

/** The recording as a JSON string. */
export function serializeRecording(rec: InputRecording): string {
  return JSON.stringify(rec);
}

/**
 * Parse and validate a recording (a JSON string or an already parsed value). Throws
 * `InputRecordingError` on a wrong version or a malformed tick.
 */
export function parseRecording(source: string | unknown): InputRecording {
  let v: unknown;
  if (typeof source === 'string') {
    try {
      v = JSON.parse(source);
    } catch (err) {
      throw new InputRecordingError(
        `not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else v = source;
  if (!isObject(v)) throw new InputRecordingError('recording is not an object');
  const version = v.version;
  if (version !== 1 && version !== 2 && version !== 3)
    throw new InputRecordingError(`unsupported version ${String(v.version)}`);
  if (!Array.isArray(v.ticks)) throw new InputRecordingError('ticks is not an array');
  if (
    v.tickMs !== undefined &&
    !(typeof v.tickMs === 'number' && v.tickMs > 0 && Number.isFinite(v.tickMs))
  ) {
    throw new InputRecordingError('bad tickMs');
  }
  let next = 0;
  v.ticks.forEach((e, i) => {
    if (!isObject(e) || typeof e.t !== 'number' || e.t !== next) {
      throw new InputRecordingError(`tick ${i}: expected t ${next}`);
    }
    if ('n' in e) {
      if (typeof e.n !== 'number' || e.n < 1 || !Number.isInteger(e.n)) {
        throw new InputRecordingError(`tick ${i}: bad run count`);
      }
      next += e.n;
      return;
    }
    next++;
    if (e.k !== undefined && !isPairs(e.k, 'string')) throw bad(i, 'k');
    if (e.b !== undefined && !isPairs(e.b, 'number')) throw bad(i, 'b');
    if (e.p !== undefined && !isPointer(e.p)) throw bad(i, 'p');
    if (e.w !== undefined && !isNumbers(e.w, 2)) throw bad(i, 'w');
    if (e.r !== undefined && e.r !== 1) throw bad(i, 'r');
    if (e.d !== undefined && e.d !== 1) throw bad(i, 'd');
    if (e.g !== undefined && !(Array.isArray(e.g) && e.g.every(isPadSnapshot))) throw bad(i, 'g');
    if (e.rumble !== undefined && !(Array.isArray(e.rumble) && e.rumble.every(isRumble))) {
      throw bad(i, 'rumble');
    }
    if (version === 1) return;
    const timed = version === 3;
    if (
      e.ptr !== undefined &&
      !(Array.isArray(e.ptr) && e.ptr.every((p) => isPointerEntry(p, timed)))
    ) {
      throw bad(i, 'ptr');
    }
    if (e.cx !== undefined && !isPairs(e.cx, 'string')) throw bad(i, 'cx');
    if (e.cs !== undefined && !(Array.isArray(e.cs) && e.cs.every((a) => typeof a === 'string'))) {
      throw bad(i, 'cs');
    }
  });
  return v as unknown as InputRecording;
}

function bad(i: number, field: string): InputRecordingError {
  return new InputRecordingError(`tick ${i}: bad ${field}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumbers(v: unknown, n?: number): v is number[] {
  return (
    Array.isArray(v) &&
    (n === undefined || v.length === n) &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

function isPairs(v: unknown, kind: 'string' | 'number'): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === kind && (e[1] === 0 || e[1] === 1),
    )
  );
}

function isPointer(v: unknown): boolean {
  if (!Array.isArray(v) || v.length < 2 || v.length > 3) return false;
  if (!isNumbers(v.slice(0, 2))) return false;
  return v.length === 2 || v[2] === 'mouse' || v[2] === 'touch' || v[2] === 'pen';
}

/** A `ptr` entry: 7 fields in version 2, 8 (with a finite `time`) in version 3. */
function isPointerEntry(v: unknown, timed: boolean): boolean {
  return (
    Array.isArray(v) &&
    v.length === (timed ? 8 : 7) &&
    (!timed || (typeof v[7] === 'number' && Number.isFinite(v[7]))) &&
    Number.isInteger(v[0]) &&
    v[0] >= 0 &&
    v[0] <= 4 &&
    (v[2] === 'mouse' || v[2] === 'touch' || v[2] === 'pen') &&
    isNumbers([v[1], v[3], v[4], v[5]]) &&
    (v[6] === 0 || v[6] === 1)
  );
}

function isRumble(v: unknown): boolean {
  return Array.isArray(v) && (v.length === 3 || v.length === 4) && isNumbers(v);
}

function isPadSnapshot(v: unknown): boolean {
  if (v === null) return true;
  return isObject(v) && isNumbers(v.buttons) && isNumbers(v.axes);
}
