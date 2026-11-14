/**
 * Client mode's frame source (ws/kit): a game that owns its frames (its own rAF, a worker's
 * tick, a server-paced client) drives the loop with `frame(loop, now)`; the engine schedules
 * nothing and reads no clock of its own.
 */

import { FRAME_CAP_SLACK_MS, type GameLoop } from '../core/loop';
import type { FrameSource } from '../host';

/**
 * A `FrameSource` that never calls back: pass it as the loop's `frames` (with `now: () => 0`),
 * then call `frame(loop, now)` once per frame with the game's own timestamp.
 */
export interface ExternalFrames extends FrameSource {
  /**
   * Runs one frame of `loop` at `now` (ms, the game's clock): update and render with the delta
   * since the last call. The first call after `loop.start()` runs with a delta of 0. Ignored
   * while the loop is stopped (hidden, backgrounded) or halted (device lost). The loop's
   * `maxFps` applies (ws/kit-fit): a call that comes sooner than `1000 / maxFps` ms (less a few
   * ms of vsync slack) after the last frame that ran is skipped whole (no update, no render),
   * and the next delta runs from that last frame. A game feeding a headset's frames this way
   * sets `loop.maxFps = null` while the session runs: a skipped XR frame judders.
   */
  frame(loop: GameLoop, now: number): void;
}

/** A frame source for a loop the game drives itself. */
export function createExternalFrames(): ExternalFrames {
  /** The last `now` given since the loop (re)started; null before the first frame. */
  let last: number | null = null;
  return {
    // `loop.start()` (and nothing else, since this source never runs a callback) requests a
    // frame: the next `frame` call is the first of a run.
    requestFrame() {
      last = null;
      return 0;
    },
    cancelFrame() {},
    frame(loop, now) {
      if (!loop.isRunning) return;
      const cap = loop.maxFps;
      if (cap !== null && last !== null && now - last < 1000 / cap - FRAME_CAP_SLACK_MS) return;
      const dt = last === null ? 0 : (now - last) / 1000;
      last = now;
      loop.tickOnce(dt);
    },
  };
}
