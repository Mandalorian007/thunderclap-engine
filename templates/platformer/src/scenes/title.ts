/**
 * The title: the parallax drifting behind a panel with one button per level, each showing the
 * saved best time and coins. The panel is the engine's (arrows, Tab, pad through `ctx.padNav`,
 * touch on the buttons); it is not dismissible, so the game always has something on top.
 */
import type { Scene } from '@thunderclap-engine/engine/core';
import type { Frame } from '@thunderclap-engine/engine/render';
import { button, h } from '@thunderclap-engine/engine/ui';
import type { GameCtx } from '../ctx';
import { LEVELS } from '../levels';
import { TILE } from '../levels/format';
import { formatTime } from '../ui/hud';
import { createParallax, type Parallax } from '../world/parallax';

export function createTitleScene(ctx: GameCtx): Scene<GameCtx, Frame> {
  let parallax: Parallax | null = null;
  let handle: { close(): void } | null = null;
  let drift = 0;
  return {
    name: 'title',
    enter() {
      parallax = createParallax(
        ctx.renderer,
        ctx.atlas,
        ctx.design.width,
        ctx.design.height,
        17 * TILE,
      );
      ctx.camera.x = 0;
      ctx.camera.y = 0;
      const progress = ctx.save.get();
      const rows = LEVELS.map((level, i) => {
        const rec = progress.levels[level.id];
        const stats = rec
          ? `${rec.bestMs === null ? '--' : formatTime(rec.bestMs)} · ${rec.coins}/${level.coins.length} coins`
          : 'not yet cleared';
        const b = button(
          `${i + 1}. ${level.name}  (${stats})`,
          () => {
            ctx.run.levelIndex = i;
            handle?.close();
            ctx.startLevel(level);
          },
          { variant: i === 0 ? 'primary' : undefined },
        );
        b.id = `title-level-${level.id}`;
        return b;
      });
      const hint = h(
        'p',
        { style: { opacity: '0.75', margin: '0 0 8px', fontSize: 'var(--tc-font-size-s)' } },
        'Arrows / A D run, Space jumps, Shift dashes. Pad: stick, A, B. Touch: left half steers, right half jumps, top-right dashes.',
      );
      handle = ctx.ui.stack.push({
        title: 'Skyline',
        content: h(
          'div',
          { style: { display: 'grid', gap: '8px', minWidth: '320px' } },
          hint,
          ...rows,
        ),
        dismissible: false,
        onClose: () => {
          handle = null;
        },
      });
    },
    exit() {
      const hnd = handle;
      handle = null;
      hnd?.close();
      parallax?.destroy();
      parallax = null;
    },
    update(dt) {
      drift += dt * 80;
    },
    render(frame) {
      frame.clear(0.36, 0.56, 0.86);
      parallax?.update(drift, 0);
      parallax?.draw(frame);
    },
  };
}
