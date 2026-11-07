/**
 * The HUD: coins, lives and the clock as DOM lines in layout regions, and the engine's `ui.meter`
 * for the dash cooldown. The engine moves them between regions when the form factor changes.
 * Nothing here draws on the canvas or changes game state.
 */
import { h } from '@thunderclap-engine/engine/ui';
import type { GameCtx } from '../ctx';
import { DASH_COOLDOWN } from '../physics/player';

export interface Hud {
  setCoins(got: number, total: number): void;
  setLives(lives: number): void;
  setTime(ms: number): void;
  /** Seconds of cooldown left (0 = ready). */
  setDash(cooldownLeft: number): void;
  remove(): void;
}

const line = (id: string) =>
  h('div', {
    id,
    style: {
      fontFamily: 'var(--tc-font-display)',
      fontSize: 'var(--tc-font-size-l)',
      color: 'var(--tc-color-text)',
      fontVariantNumeric: 'tabular-nums',
    },
  });

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const frac = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s % 60).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
}

export function createHud(ctx: GameCtx): Hud {
  const coins = line('hud-coins');
  const lives = line('hud-lives');
  const time = line('hud-time');
  const { layout } = ctx.ui;
  const handles = [
    layout.add(coins, { place: { default: 'top' }, order: 0 }),
    layout.add(lives, { place: { default: 'top' }, order: 1 }),
    layout.add(time, { place: { default: 'top', 'phone-portrait': 'hidden' }, order: 2 }),
  ];
  const dash = ctx.ui.meter({
    label: 'Dash',
    max: DASH_COOLDOWN,
    value: DASH_COOLDOWN,
    region: 'bottom',
    tone: 'accent',
    width: 200,
  });
  let lastCoins = '';
  let lastLives = -1;
  let lastSecond = -1;
  let lastDash = -1;
  return {
    setCoins(got, total) {
      const text = `${got} / ${total} coins`;
      if (text !== lastCoins) coins.textContent = lastCoins = text;
    },
    setLives(n) {
      if (n !== lastLives) {
        lastLives = n;
        lives.textContent = `${n} ${n === 1 ? 'life' : 'lives'}`;
      }
    },
    setTime(ms) {
      // Hundredths tick fast; the DOM only hears about tenths.
      const tenth = Math.floor(ms / 100);
      if (tenth !== lastSecond) {
        lastSecond = tenth;
        time.textContent = formatTime(ms);
      }
    },
    setDash(left) {
      const v = Math.round((DASH_COOLDOWN - left) * 30) / 30;
      if (v !== lastDash) {
        lastDash = v;
        dash.set(v);
      }
    },
    remove() {
      for (const hnd of handles) hnd.remove();
      dash.remove();
    },
  };
}
