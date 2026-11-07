/**
 * The HUD: a crosshair at the centre of the frame (`ui.layers.hud`, the layer that sits on the
 * canvas), a prompt in the layout's bottom region that hides while the pointer is locked, and a
 * focus line in the top region naming the landmark under the crosshair. The world-anchored
 * landmark labels live in the scene (`ui.anchors`), not here. Nothing here changes game state.
 */
import type { Look } from '@thunderclap-engine/engine/input';
import { h } from '@thunderclap-engine/engine/ui';
import type { GameCtx } from '../ctx';
import type { Landmark } from '../world/terrain';

export interface Hud {
  /** The landmark in the crosshair, or none. */
  setFocus(landmark: Landmark | null): void;
  remove(): void;
}

const PROMPTS = {
  mouse: 'Click to look · WASD to walk · Shift to run · E to inspect · R to respawn',
  keyboard: 'Click to look · WASD to walk · Shift to run · E to inspect · R to respawn',
  touch: 'Left half: walk · right half: look · tap a marker to inspect',
  gamepad: 'Left stick walks · right stick looks · A inspects · Y respawns',
} as const;

export function createHud(ctx: GameCtx, look: Look): Hud {
  const crosshair = h('div', {
    id: 'hud-crosshair',
    style: {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '18px',
      height: '18px',
      marginLeft: '-9px',
      marginTop: '-9px',
      border: '2px solid var(--tc-color-text)',
      borderRadius: '50%',
      opacity: '0.7',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    },
  });
  ctx.ui.layers.hud.append(crosshair);

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
  const prompt = text('hud-prompt');
  const focus = text('hud-focus');
  const { layout } = ctx.ui;
  const handles = [
    layout.add(prompt, { place: { default: 'bottom' } }),
    layout.add(focus, { place: { default: 'top' } }),
  ];

  const refreshPrompt = () => {
    const device = ctx.input.lastDevice;
    prompt.textContent = PROMPTS[device in PROMPTS ? (device as keyof typeof PROMPTS) : 'mouse'];
    // Touch and pad never lock the pointer; the prompt only steps aside for a locked mouse.
    prompt.hidden = look.locked;
  };
  refreshPrompt();
  const offLock = look.onLockChange(() => {
    refreshPrompt();
    crosshair.style.opacity = look.locked ? '1' : '0.7';
  });
  // The device may change at any tick; cheap to re-read once a second.
  const timer = setInterval(refreshPrompt, 1000);

  return {
    setFocus(landmark) {
      const next = landmark ? `${landmark.name} · inspect to read` : '';
      if (focus.textContent !== next) focus.textContent = next;
    },
    remove() {
      clearInterval(timer);
      offLock();
      crosshair.remove();
      for (const hnd of handles) hnd.remove();
    },
  };
}
