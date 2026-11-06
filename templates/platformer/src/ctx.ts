/**
 * The game's ctx: the engine's `EngineCtx` plus this game's nouns. `createGame` returns the
 * engine part; `main.ts` widens the same object with `Object.assign`, so every scene sees one ctx.
 * Devices never leak past the bindings below and `input/touch.ts`.
 */
import type { EngineCtx } from '@thunderclap/engine';
import type { Bindings } from '@thunderclap/engine/input';
import type { Material } from '@thunderclap/engine/render';
import type { Tweens } from '@thunderclap/engine/tween';
import type { TouchZones } from './input/touch';
import type { Level } from './levels/format';
import type { ProgressStore } from './save/schema';
import type { Frames } from './world/world';

export type Action = 'left' | 'right' | 'jump' | 'dash' | 'pause' | 'confirm';

/**
 * Keyboard and pad per action. Touch is not here: the two thumb zones read the router's pointer
 * list directly (`input/touch.ts`), because the gesture recogniser treats two fingers as a pinch.
 */
export const bindings: Bindings<Action> = {
  left: [{ key: 'ArrowLeft' }, { key: 'KeyA' }, { padButton: 14 }, { padAxis: 0, dir: -1 }],
  right: [{ key: 'ArrowRight' }, { key: 'KeyD' }, { padButton: 15 }, { padAxis: 0, dir: 1 }],
  jump: [{ key: 'Space' }, { key: 'ArrowUp' }, { key: 'KeyW' }, { key: 'KeyZ' }, { padButton: 0 }],
  dash: [
    { key: 'ShiftLeft' },
    { key: 'ShiftRight' },
    { key: 'KeyX' },
    { padButton: 1 },
    { padButton: 5 },
  ],
  pause: [{ key: 'Escape' }, { key: 'KeyP' }, { padButton: 9 }],
  confirm: [{ key: 'Enter' }, { key: 'Space' }, { padButton: 0 }],
};

/** Keys the engine keeps from the page (no scrolling on Space or the arrows). */
export const buttonKeys = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/** What one play-through carries between levels. */
export interface Run {
  lives: number;
  /** Index into `LEVELS`. */
  levelIndex: number;
}

export interface GameCtx extends EngineCtx<Action, ProgressStore, GameCtx> {
  /** The one atlas material every tile layer and sprite draws with. */
  readonly atlas: Material;
  readonly frames: Frames;
  readonly tweens: Tweens;
  readonly touch: TouchZones;
  readonly run: Run;
  /** Starts (or restarts) the level at `run.levelIndex`. */
  startLevel(level: Level): void;
  /** Back to the title. */
  toTitle(): void;
}
