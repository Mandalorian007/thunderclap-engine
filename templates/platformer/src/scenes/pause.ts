/**
 * The pause menu: a transparent scene that pushes one modal panel. The engine walks the panel
 * with Tab and the arrows, `ctx.padNav` walks it with the pad, the buttons take touch; Esc, the
 * pad's back button or the Resume button close it, and the scene pops itself. Nothing else
 * updates while it is on top (only the top scene gets `update`, and actions are blocked while a
 * modal is open).
 */
import type { Scene } from '@thunderclap/engine/core';
import type { Frame } from '@thunderclap/engine/render';
import { button, h } from '@thunderclap/engine/ui';
import type { GameCtx } from '../ctx';
import type { Level } from '../levels/format';

export function createPauseScene(ctx: GameCtx, level: Level): Scene<GameCtx, Frame> {
  let handle: { close(): void } | null = null;
  let popped = false;
  const pop = () => {
    if (popped) return;
    popped = true;
    ctx.stack.pop();
  };
  return {
    name: 'pause',
    transparent: true,
    enter() {
      ctx.loop.paused = false; // the sim keeps ticking the stack; this scene just does nothing
      const resume = button('Resume', () => handle?.close(), { variant: 'primary' });
      resume.id = 'pause-resume';
      const restart = button('Restart level', () => {
        handle?.close();
        ctx.startLevel(level);
      });
      restart.id = 'pause-restart';
      const quit = button('Quit to title', () => {
        handle?.close();
        ctx.toTitle();
      });
      quit.id = 'pause-quit';
      const content = h(
        'div',
        { style: { display: 'grid', gap: '8px', minWidth: '240px' } },
        resume,
        restart,
        quit,
      );
      handle = ctx.ui.stack.push({
        title: 'Paused',
        content,
        onClose: () => {
          handle = null;
          pop();
        },
      });
    },
    exit() {
      const hnd = handle;
      handle = null;
      hnd?.close();
    },
    update() {},
    render() {},
  };
}
