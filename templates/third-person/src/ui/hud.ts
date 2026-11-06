/**
 * The HUD: a health meter and a kill count in the layout's top region, three cosmetic buttons in
 * the bottom region (one per socket slot, each showing the option worn) and a prompt per input
 * device. The enemy name plates live in `enemies/` (`ui.anchors`), not here. Nothing here changes
 * game state: the buttons call back into the scene.
 */
import { button, createMeter, h, type Meter } from '@thunderclap/engine/ui';
import { COSMETICS, type SlotName } from '../character/cosmetics';
import type { GameCtx } from '../ctx';

export interface Hud {
  setHealth(value: number, max: number): void;
  setKills(n: number): void;
  /** Show the option worn in a slot. */
  setCosmetic(slot: SlotName, option: string): void;
  remove(): void;
}

const PROMPTS = {
  mouse: 'WASD moves · Shift runs · Space attacks · drag orbits · wheel zooms · 1 2 3 cosmetics',
  keyboard: 'WASD moves · Shift runs · Space attacks · drag orbits · wheel zooms · 1 2 3 cosmetics',
  touch: 'Left half moves · right half orbits · pinch zooms · tap attacks',
  gamepad: 'Left stick moves · right stick orbits · A attacks · L3 runs · X Y B cosmetics',
} as const;

export function createHud(ctx: GameCtx, onCosmetic: (slot: number) => void): Hud {
  const { layout } = ctx.ui;
  const health: Meter = createMeter(ctx.ui, {
    label: 'Health',
    max: ctx.player.maxHealth,
    value: ctx.player.health,
    region: 'top',
    tone: 'danger',
    width: 220,
    format: (v, m) => `${v}/${m}`,
  });

  const text = (id: string) =>
    h('div', {
      id,
      style: {
        fontFamily: 'var(--tc-font-display)',
        fontSize: 'var(--tc-font-size-l)',
        color: 'var(--tc-color-text)',
        textShadow: '0 1px 2px rgba(0, 0, 0, 0.6)',
      },
    });
  const kills = text('hud-kills');
  const prompt = text('hud-prompt');
  prompt.style.fontSize = 'var(--tc-font-size-m)';

  const slotButtons = COSMETICS.map((slot, i) =>
    button(`${slot.slot}: ${slot.options[0].name}`, () => onCosmetic(i), { variant: 'default' }),
  );
  const slots = h(
    'div',
    { id: 'hud-cosmetics', style: { display: 'flex', gap: '8px', pointerEvents: 'auto' } },
    ...slotButtons,
  );

  const handles = [
    layout.add(kills, { place: { default: 'top' }, order: 2 }),
    layout.add(slots, { place: { default: 'bottom' }, order: 1 }),
    layout.add(prompt, { place: { default: 'bottom', 'phone-portrait': 'hidden' }, order: 2 }),
  ];

  const refreshPrompt = () => {
    const device = ctx.input.lastDevice;
    prompt.textContent = PROMPTS[device in PROMPTS ? (device as keyof typeof PROMPTS) : 'mouse'];
  };
  refreshPrompt();
  const timer = setInterval(refreshPrompt, 1000);

  const hud: Hud = {
    setHealth(value, max) {
      health.set(value, max);
    },
    setKills(n) {
      const next = `Kills: ${n}`;
      if (kills.textContent !== next) kills.textContent = next;
    },
    setCosmetic(slot, option) {
      const i = COSMETICS.findIndex((s) => s.slot === slot);
      if (i >= 0) slotButtons[i]!.textContent = `${slot}: ${option}`;
    },
    remove() {
      clearInterval(timer);
      health.remove();
      for (const hnd of handles) hnd.remove();
    },
  };
  hud.setKills(0);
  return hud;
}
