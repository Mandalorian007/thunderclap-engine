/**
 * The HUD: DOM widgets registered against layout regions. The engine moves them between regions
 * when the form factor changes (`place` names a region per form factor, `default` for the rest),
 * sizes them with the theme tokens and keeps them out of the board's way. Nothing here draws on
 * the canvas; nothing here changes game state except through `ctx.newGame()`.
 */
import { button, h } from '@thunderclap/engine/ui';
import type { GameCtx } from '../ctx';
import { pairsLeft, phase } from '../rules/board';

export interface Hud {
  /** Re-reads the game and the save. */
  refresh(): void;
  remove(): void;
}

const line = (id: string) =>
  h('div', {
    id,
    style: {
      fontFamily: 'var(--tc-font-display)',
      fontSize: 'var(--tc-font-size-l)',
      color: 'var(--tc-color-text)',
    },
  });

export function createHud(ctx: GameCtx): Hud {
  const moves = line('hud-moves');
  const best = line('hud-best');
  const newGame = button('New game', () => ctx.newGame(), { variant: 'primary' });
  newGame.id = 'hud-new-game';

  const { layout } = ctx.ui;
  const handles = [
    layout.add(moves, { place: { default: 'top', 'phone-landscape': 'right' }, order: 0 }),
    // Phones in portrait are narrow: the record line gives way to the move counter.
    layout.add(best, {
      place: { default: 'top', 'phone-landscape': 'right', 'phone-portrait': 'hidden' },
      order: 1,
    }),
    layout.add(newGame, { place: { default: 'bottom' } }),
  ];

  const refresh = () => {
    const b = ctx.game.board;
    const p = phase(b);
    moves.textContent =
      p === 'won' ? `Solved in ${b.moves} moves` : `${b.moves} moves · ${pairsLeft(b)} pairs left`;
    const s = ctx.save.get();
    best.textContent =
      s.bestMoves === null ? `${s.wins} solved` : `${s.wins} solved · best ${s.bestMoves}`;
  };
  refresh();

  return {
    refresh,
    remove() {
      for (const hnd of handles) hnd.remove();
    },
  };
}
