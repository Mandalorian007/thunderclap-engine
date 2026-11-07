/**
 * The game's ctx: the engine's `EngineCtx` plus this game's nouns. `createGame` returns the
 * engine part; `main.ts` widens the same object with `Object.assign`, so every scene sees one ctx.
 * Devices never leak past the bindings and touch zones below.
 */
import type { EngineCtx } from '@thunderclap-engine/engine';
import type {
  Bindings,
  TouchZoneOptions,
  TouchZonesOptions,
} from '@thunderclap-engine/engine/input';
import type { Material } from '@thunderclap-engine/engine/render';
import type { Tweens } from '@thunderclap-engine/engine/tween';
import type { Level } from './levels/format';
import type { ProgressStore } from './save/schema';
import type { Frames } from './world/world';

export type Action = 'left' | 'right' | 'jump' | 'dash' | 'pause' | 'confirm';

/** Keyboard and pad per action. Touch comes through the zones below. */
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

/**
 * The two thumbs on a touch screen, as engine touch zones (`createTouchZones` in `main.ts`): the
 * left half is a stick that steers (x only; a thumb's travel of `radius` CSS px is a full run,
 * the first `deadZone` of it reads 0), the right half jumps, except its top third, which dashes.
 * Separate zones so a second finger on the right still lands. Each zone claims its pointer from
 * the gesture recogniser, so two thumbs never pinch.
 */
export const touchZones: TouchZonesOptions<Record<'move' | 'jump' | 'dash', TouchZoneOptions>> = {
  zones: {
    move: {
      kind: 'stick',
      rect: (w, h) => ({ x: 0, y: 0, w: w / 2, h }),
      deadZone: 12 / 64,
      radius: 64,
    },
    jump: {
      kind: 'buttons',
      rect: (w, h) => ({ x: w / 2, y: h / 3, w: w / 2, h: (2 * h) / 3 }),
      buttons: { jump: (w, h) => ({ x: w / 2, y: h / 3, w: w / 2, h: (2 * h) / 3 }) },
    },
    dash: {
      kind: 'buttons',
      rect: (w, h) => ({ x: w / 2, y: 0, w: w / 2, h: h / 3 }),
      buttons: { dash: (w, h) => ({ x: w / 2, y: 0, w: w / 2, h: h / 3 }) },
    },
  },
  bindings: {
    left: { zone: 'move', axis: 'x', dir: -1 },
    right: { zone: 'move', axis: 'x', dir: 1 },
    jump: { zone: 'jump', button: 'jump' },
    dash: { zone: 'dash', button: 'dash' },
  },
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
  readonly run: Run;
  /** Starts (or restarts) the level at `run.levelIndex`. */
  startLevel(level: Level): void;
  /** Back to the title. */
  toTitle(): void;
}
