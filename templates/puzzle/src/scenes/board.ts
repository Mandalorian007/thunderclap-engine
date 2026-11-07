/**
 * The board scene: turns input into rule calls and draws the board the rules describe.
 *
 * - `update(dt)` runs each fixed step: reads actions (`select` with the tap's position, the
 *   cursor keys, `confirm`, `newGame`), calls `reveal`/`settle`, advances the flip animation.
 * - `render(frame, camera)` draws one sprite per cell through a `Transform` and pre-built
 *   `DrawParams`; nothing is allocated per frame.
 * - The camera (`ctx.camera`, `Camera.ortho2d` in design px) is fitted to the board inside the
 *   space the HUD leaves (`ctx.ui.layout.freeRect`, through `camera.fitFreeRect`), on enter and
 *   on every re-layout. A win emits `level_complete` through `ctx.analytics`.
 */
import { createScheduler, type Scene, type TimerHandle } from '@thunderclap/engine/core';
import {
  type CameraPoint,
  type CameraRect,
  type Frame,
  hex,
  type InstanceParams,
  type RGBA,
  Transform,
} from '@thunderclap/engine/render';
import type { GameCtx } from '../ctx';
import { type Board, isFaceUp, phase, reveal, settle } from '../rules/board';
import { recordWin } from '../save/schema';

/** Cell pitch and tile size in world units (design px; the camera does the fitting). */
const PITCH = 200;
const TILE = 176;
/** How long a mismatch stays on the table, seconds. */
const MISMATCH_S = 0.8;
/** Flip speed, full turns per second. */
const FLIP_RATE = 5;

const BACK: RGBA = hex('#2b3350');
const BACK_HOVER: RGBA = hex('#3a4570');
const CURSOR: RGBA = hex('#ffd36b', 1.5);
const FACES: readonly RGBA[] = [
  '#ff6b6b',
  '#ffa94d',
  '#ffd43b',
  '#69db7c',
  '#38d9a9',
  '#4dabf7',
  '#9775fa',
  '#f783ac',
  '#a9e34b',
  '#3bc9db',
  '#e599f7',
  '#ffc078',
].map((c) => hex(c));

interface Cell {
  readonly transform: Transform;
  /** The cursor ring, one size up and drawn beneath. */
  readonly ring: Transform;
  readonly params: InstanceParams & { tint: RGBA; emissive: number; order: number };
  /** 0 = face down, 1 = face up; animated toward `isFaceUp`. */
  flip: number;
}

export function createBoardScene(ctx: GameCtx): Scene<GameCtx, Frame> {
  const cells: Cell[] = [];
  const boardRect: CameraRect = { x: 0, y: 0, width: 0, height: 0 };
  /** The board padded by half a tile, so the cursor ring is never cut off. */
  const paddedRect: CameraRect = { x: 0, y: 0, width: 0, height: 0 };
  const ringParams = { tint: CURSOR, emissive: 0.6, order: -1 };
  const tap: CameraPoint = { x: 0, y: 0, z: 0 };
  // The scene's clock: a mismatch turns back on its own `MISMATCH_S` after it is dealt.
  const timers = createScheduler();
  let settling: TimerHandle = 0;
  const settleNow = () => {
    settling = 0;
    apply(settle(ctx.game.board));
  };
  /** The seed the cells were built for; a different `board.seed` means a new deal. */
  let builtSeed = Number.NaN;
  let unsubscribe: (() => void)[] = [];

  /** Rebuilds the cells for the current board (new size or a new game). */
  const build = (b: Board) => {
    cells.length = 0;
    const w = b.cols * PITCH;
    const hgt = b.rows * PITCH;
    boardRect.x = (ctx.design.width - w) / 2;
    boardRect.y = (ctx.design.height - hgt) / 2;
    boardRect.width = w;
    boardRect.height = hgt;
    const pad = PITCH / 2;
    paddedRect.x = boardRect.x - pad;
    paddedRect.y = boardRect.y - pad;
    paddedRect.width = w + 2 * pad;
    paddedRect.height = hgt + 2 * pad;
    for (let i = 0; i < b.faces.length; i++) {
      const col = i % b.cols;
      const row = Math.floor(i / b.cols);
      const x = boardRect.x + col * PITCH + PITCH / 2;
      const y = boardRect.y + row * PITCH + PITCH / 2;
      cells.push({
        transform: new Transform({ x, y, scaleX: TILE, scaleY: TILE }),
        ring: new Transform({ x, y, scaleX: TILE + 24, scaleY: TILE + 24 }),
        params: { tint: BACK.slice() as RGBA, emissive: 0, order: 0 },
        flip: 0,
      });
    }
    timers.cancel(settling);
    settling = 0;
    builtSeed = b.seed;
  };

  /** Fits the camera to the board inside the layout's free rect (the camera converts CSS px). */
  const frameBoard = () => {
    ctx.camera.fitFreeRect(paddedRect, ctx.ui.layout.freeRect, ctx.surface);
  };

  /** The cell under a point in camera screen units (design px), or -1. */
  const cellAt = (sx: number, sy: number): number => {
    ctx.camera.screenToWorld(sx, sy, 0, tap);
    const col = Math.floor((tap.x - boardRect.x) / PITCH);
    const row = Math.floor((tap.y - boardRect.y) / PITCH);
    const b = ctx.game.board;
    if (col < 0 || row < 0 || col >= b.cols || row >= b.rows) return -1;
    return row * b.cols + col;
  };

  const apply = (next: Board) => {
    const g = ctx.game;
    if (next === g.board) return;
    const wasWon = phase(g.board) === 'won';
    g.board = next;
    timers.cancel(settling);
    settling = phase(next) === 'mismatch' ? timers.after(MISMATCH_S, settleNow) : 0;
    if (!wasWon && phase(next) === 'won') {
      ctx.save.update((d) => recordWin(d, next.moves));
      ctx.ui.toasts.show(`Solved in ${next.moves} moves`, { tone: 'success', duration: 3000 });
      ctx.analytics?.emit('level_complete', {
        level: `${next.cols}x${next.rows}`,
        ms: Date.now() - g.dealtAt,
        moves: next.moves,
      });
    }
    ctx.refreshHud();
  };

  const moveCursor = (dc: number, dr: number) => {
    const b = ctx.game.board;
    const col = ((((ctx.game.cursor % b.cols) + dc) % b.cols) + b.cols) % b.cols;
    const row = (((Math.floor(ctx.game.cursor / b.cols) + dr) % b.rows) + b.rows) % b.rows;
    ctx.game.cursor = row * b.cols + col;
  };

  /** A new deal (the HUD button, the key, or a select after a win) rebuilds the cells. */
  const syncCells = () => {
    const b = ctx.game.board;
    if (b.seed === builtSeed && b.faces.length === cells.length) return;
    build(b);
    frameBoard();
  };

  return {
    name: 'board',
    enter() {
      syncCells();
      unsubscribe = [ctx.ui.layout.onChange(frameBoard), ctx.surface.onResize(frameBoard)];
    },
    exit() {
      for (const u of unsubscribe) u();
      unsubscribe = [];
    },
    update(dt) {
      const { input, gestures, game } = ctx;
      if (input.pressed('newGame')) ctx.newGame();
      syncCells();

      if (input.pressed('select')) {
        const t = gestures.tap;
        const i = t ? cellAt(t.x, t.y) : -1;
        if (phase(game.board) === 'won') ctx.newGame();
        else if (i >= 0) {
          game.cursor = i;
          apply(reveal(game.board, i));
        }
      }
      if (input.pressed('left')) moveCursor(-1, 0);
      if (input.pressed('right')) moveCursor(1, 0);
      if (input.pressed('up')) moveCursor(0, -1);
      if (input.pressed('down')) moveCursor(0, 1);
      if (input.pressed('confirm')) {
        if (phase(game.board) === 'won') ctx.newGame();
        else apply(reveal(game.board, game.cursor));
      }
      syncCells();

      // A mismatch turns back on its own after a moment.
      timers.update(dt);

      // Flip animation toward the rules' truth.
      const b = game.board;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]!;
        const target = isFaceUp(b, i) ? 1 : 0;
        if (c.flip !== target) {
          c.flip =
            target > c.flip
              ? Math.min(1, c.flip + dt * FLIP_RATE)
              : Math.max(0, c.flip - dt * FLIP_RATE);
        }
      }
    },
    render(frame) {
      frame.clear(0.04, 0.05, 0.08);
      const b = ctx.game.board;
      const hover = ctx.input.pointer;
      const hoverCell =
        hover.inside && ctx.input.lastDevice === 'mouse' ? cellAt(hover.x, hover.y) : -1;
      const showCursor = ctx.input.lastDevice === 'keyboard' || ctx.input.lastDevice === 'gamepad';
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]!;
        const face = c.flip > 0.5;
        const src = face ? FACES[b.faces[i]! % FACES.length]! : i === hoverCell ? BACK_HOVER : BACK;
        const tint = c.params.tint;
        tint[0] = src[0];
        tint[1] = src[1];
        tint[2] = src[2];
        tint[3] = src[3];
        c.params.emissive = b.matched[i] ? 0.5 : 0;
        // A flip is a squeeze along x: 1 → 0 → 1 as the card turns.
        c.transform.setScale(TILE * Math.abs(c.flip * 2 - 1), TILE);
        if (showCursor && i === ctx.game.cursor) frame.sprite(null, c.ring, ringParams);
        frame.sprite(null, c.transform, c.params);
      }
    },
  };
}
