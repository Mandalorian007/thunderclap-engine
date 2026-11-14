/**
 * The input service (ws/kit): the action map with its gestures (on the game's tick clock), the
 * pointer router, pad navigation of modal panels, recording, replay from a recording and
 * `ctx.replay`. `createKitInput` builds it alone from an explicit dependency list; `withInput`
 * is the `composeGame` field.
 */

import {
  type Bindings,
  createGestures,
  createInputPlayback,
  createInputRecorder,
  createPointerRouter,
  type GamepadLike,
  type Gestures,
  type HitTester,
  Input,
  type InputRecording,
  type MagnifyOptions,
  type PointerRouter,
  type TickClock,
} from '../input';
import type { Surface } from '../platform';
import type { Camera } from '../render';
import { type Overlay, PadNav, type PanelStack } from '../ui';
import type { GameReplay, KitService, ReplayOptions } from './types';

/** The input's options (`CreateGameOptions.input` plus the pointer router's first testers). */
export interface KitInputOptions<A extends string, P = unknown> {
  /** The base action map; `A` is the full action union (a pushed context may bind the rest). */
  bindings: Partial<Bindings<A>>;
  /** See `InputOptions.globalKeys`. */
  globalKeys?: Iterable<string>;
  /** See `InputOptions.buttonKeys`. */
  buttonKeys?: Iterable<string>;
  /** Extra block on top of "a modal panel is open". */
  blocked?: () => boolean;
  /** Gamepad source for the action map and pad navigation. Default `navigator.getGamepads()`. */
  getGamepads?: () => readonly (GamepadLike | null)[];
  /** Loupe and snap for small touch targets (`GestureOptions.magnify`). */
  magnify?: MagnifyOptions;
  /** Record everything the input is fed (`ctx.input.recorder`). */
  record?: boolean;
  /** Run from a recording instead of the DOM. */
  replay?: InputRecording;
  /** The pointer router's first hit testers; their target type is `P`. */
  testers?: readonly HitTester<P>[];
}

/** `createKitInput`'s dependencies. */
export interface KitInputDeps<A extends string, P = unknown> extends KitInputOptions<A, P> {
  /** The canvas the input attaches to and the client-to-design transform. */
  surface: Surface;
  /** The game's tick clock: gestures run on it, a playback drives it. */
  clock: TickClock;
  /** False: the input is attached to nothing (feed it by hand or from a replay). */
  dom: boolean;
  /** The overlay: input is blocked under its modal panels, which the pad then drives. */
  ui: Overlay | null;
  /** The camera pointer rays go through (read each update). */
  camera: () => Camera;
}

/** The ctx fields the input service adds. */
export interface KitInputFields<A extends string, P = unknown> {
  readonly input: Input<A>;
  readonly gestures: Gestures;
  readonly pointers: PointerRouter<P>;
  readonly padNav: PadNav;
  replay(recording: InputRecording, opts?: ReplayOptions): GameReplay;
}

/** What `createKitInput` returns: the fields and the per-update step the loop calls. */
export interface KitInput<A extends string, P = unknown> {
  readonly fields: KitInputFields<A, P>;
  /**
   * One update: feeds a playback's tick (and ends a finished `ctx.replay`), advances `clock` by
   * `dt` unless the playback drove it, then updates the input and pad navigation.
   */
  step(dt: number): void;
}

/**
 * The input, gestures, pointer router and pad navigation, linked (shared block, transform and
 * attach), attached to the canvas (or a sink in replay mode, or nothing without a DOM).
 */
export function createKitInput<A extends string, P = unknown>(
  deps: KitInputDeps<A, P>,
): KitInput<A, P> {
  const { surface, clock, ui } = deps;
  // Input is blocked while a modal panel is up, so the pad drives panels through this. With no
  // overlay there are no panels: the pad stays the game's.
  const padNav = new PadNav(ui ? ui.stack : NO_PANELS, { getGamepads: deps.getGamepads });
  const extraBlock = deps.blocked;
  // Gestures and pointer rays link to the input: same block, same transform, same attach,
  // advanced in `input.update()`. The gestures run on the game's tick clock (advanced by the
  // loop), so their timers are game time and a replay lands them on the same ticks.
  const gestures = createGestures({ magnify: deps.magnify, clock });
  const pointers = createPointerRouter<P>({ camera: deps.camera, testers: deps.testers });
  const panels = ui?.stack;
  const modal = panels ? () => panels.hasModal : () => false;
  const input = new Input<A>(deps.bindings, {
    blocked: extraBlock ? () => modal() || extraBlock() : modal,
    globalKeys: deps.globalKeys,
    buttonKeys: deps.buttonKeys,
    getGamepads: deps.getGamepads,
    gestures,
    pointers,
  });
  // A replay feeds the input itself: no DOM listeners, so a real key never leaks in (E-011).
  // The playback drives the game's clock (ws/input-9).
  const playback = deps.replay ? createInputPlayback(input, deps.replay, { clock }) : null;
  if (deps.record) createInputRecorder(input);
  // The recorded pointers are dispatched through a pointer target nothing real can reach (an
  // element outside the page that keys are read from too). Its box is the canvas's (ws/core-8),
  // so a touch stick or touch zone replays where it was recorded. Without a DOM there is nothing
  // to attach to: `detach()` only releases what is held.
  const sink = deps.dom ? surface.root.ownerDocument.createElement('div') : null;
  const attachSink = sink
    ? () => input.attach({ pointerTarget: sink, keyTarget: sink, bounds: surface.canvas })
    : () => input.detach();
  // Where the input lives outside a `ctx.replay`: the canvas, or the sink in replay mode.
  const attachHome =
    playback || !sink ? attachSink : () => input.attach({ pointerTarget: surface.canvas });
  attachHome();
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));
  // Overlay controls (ws/input-12): every button click reaches the input by its stable id, so a
  // recording carries it; a replay's `ui` lane clicks the button with that id.
  if (ui) {
    ui.onControl((id) => input.control(id));
    input.on('control', (id) => {
      ui.activate(id);
    });
  }
  /** The playback `replay` installed, until it ends or is stopped. */
  let replaying: GameReplay | null = null;
  /** Its `onEnd`, cleared by `stop()` so a stopped or replaced replay never reports an end. */
  let replayEnd: (() => void) | undefined;
  const replay = (recording: InputRecording, ropts: ReplayOptions = {}): GameReplay => {
    replaying?.stop();
    input.playback?.detach();
    // `attach` releases every key and button first, so nothing the player held leaks in.
    attachSink();
    // A live pointer source (the screen, an XR controller) is muted for the replay too. Its
    // remover lifts only this mute, so a mute the game set stays.
    const unmute = pointers.mute();
    const pb = createInputPlayback(input, recording, {
      speed: ropts.speed,
      tickMs: ropts.tickMs,
      clock,
    }) as GameReplay;
    const uninstall = pb.detach;
    pb.stop = pb.detach = () => {
      uninstall();
      unmute();
      if (replaying !== pb) return;
      replaying = null;
      replayEnd = undefined;
      // Releases the recording's last held keys and buttons too.
      attachHome();
    };
    replaying = pb;
    replayEnd = ropts.onEnd;
    return pb;
  };
  return {
    fields: { input, gestures, pointers, padNav, replay },
    step(dt) {
      // A replay feeds this tick's events first: live, they arrived between the frames, while
      // the clock still read the last tick. Then the clock moves by the step, before the input
      // (and its gestures) update. A playback driving the clock has already moved it for each
      // tick it fed; once the recording is done the step moves it again. The playback is read
      // from the input each step, so one the game installs mid-session is stepped here too
      // (ws/core-5). A `ctx.replay` whose recording ran out last step gives the input back
      // here, before this step's update (ws/core-6).
      const pb = input.playback;
      const fed = pb ? pb.step() : false;
      if (!fed && replaying !== null && pb === replaying) {
        const onEnd = replayEnd;
        replaying.stop();
        onEnd?.();
      }
      if (!fed || pb?.clock !== clock) clock.advance(dt * 1000);
      input.update();
      padNav.update();
    },
  };
}

/**
 * The input service. `A` is the action union, `P` the pointer targets (inferred from `testers`).
 * The loop steps it first in each update; pointer rays go through `KitCore.rayCamera()`.
 */
export function withInput<A extends string, P = unknown>(
  opts: KitInputOptions<A, P>,
): KitService<KitInputFields<A, P>, KitInput<A, P>> {
  return {
    setup(core) {
      return createKitInput<A, P>({
        ...opts,
        surface: core.surface,
        clock: core.clock,
        dom: core.dom,
        ui: core.ui,
        camera: core.rayCamera,
      });
    },
  };
}

/**
 * `PadNav`'s stack without an overlay: no panels, so the pad never leaves the game. PadNav reads
 * only `padOwner` and `onPadOwnerChange`.
 */
const NO_PANELS = {
  padOwner: 'game',
  onPadOwnerChange: () => () => {},
} as unknown as PanelStack;
