// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceMode, type DeviceModeController } from './device-mode';

let mode: DeviceModeController | null = null;
afterEach(() => {
  mode?.destroy();
  mode = null;
  document.body.replaceChildren();
});

function setup(opts?: Parameters<typeof createDeviceMode>[1]) {
  const root = document.createElement('div');
  document.body.append(root);
  mode = createDeviceMode(root, opts);
  let changes = 0;
  mode.onChange(() => changes++);
  const v = (name: string) => root.style.getPropertyValue(name);
  return { root, mode, v, changes: () => changes };
}

describe('device mode', () => {
  it('desktop and tablet scales are not phones and carry no phone tokens', () => {
    const { root, mode, v, changes } = setup();
    mode.setScale(0.6667, 0);
    expect(mode.phone).toBe(false);
    expect(root.hasAttribute('data-phone')).toBe(false);
    expect(v('--tc-text-min')).toBe('');
    expect(v('--tc-tap-min')).toBe('');
    expect(v('--tc-crop-t')).toBe('0px');
    expect(changes()).toBe(0);
  });

  it('a phone scale sets data-phone and the bar tokens in CSS px', () => {
    const { root, mode, v, changes } = setup();
    // 844×390 landscape: the 1920×1080 design at 0.36, 40 CSS px bars.
    mode.setScale(0.36, 40);
    expect(mode.phone).toBe(true);
    expect(root.hasAttribute('data-phone')).toBe(true);
    // The density tokens belong to the overlay's layout.
    expect(v('--tc-text-min')).toBe('');
    expect(v('--tc-tap-min')).toBe('');
    expect(v('--tc-bar')).toBe('40px');
    expect(v('--tc-third')).not.toBe('');
    expect(mode.cssPx).toBeCloseTo(1 / 0.36, 6);
    expect(mode.bar).toBe(Math.round(40 / 0.36));
    expect(changes()).toBe(1);

    // Back to a desktop scale: everything is cleared.
    mode.setScale(0.5);
    expect(mode.phone).toBe(false);
    expect(root.hasAttribute('data-phone')).toBe(false);
    expect(v('--tc-bar')).toBe('');
    expect(changes()).toBe(2);
  });

  it('a phone that fills the width reports its crop; the fit scale decides phone-ness', () => {
    const { root, mode, v } = setup();
    mode.setScale(0.44, 0, { fitScale: 0.36, top: 30, bottom: 20 });
    expect(mode.phone).toBe(true);
    expect(mode.cropT).toBe(Math.round(30 / 0.44));
    expect(mode.cropB).toBe(Math.round(20 / 0.44));
    expect(v('--tc-crop-t')).toBe('30px');
    expect(root.hasAttribute('data-fill')).toBe(true);
    // Filling never flips a phone to desktop: a big fill scale with a small fit is still a phone.
    mode.setScale(0.5, 0, { fitScale: 0.36, top: 0, bottom: 0 });
    expect(mode.phone).toBe(true);
    expect(root.hasAttribute('data-fill')).toBe(false);
  });

  it('options change the thresholds', () => {
    const { mode } = setup({ phoneScale: 0.3 });
    mode.setScale(0.36);
    expect(mode.phone).toBe(false);
    mode.setScale(0.25);
    expect(mode.phone).toBe(true);
  });

  it('data-touch follows the last input: a finger sets it, a mouse press clears it', () => {
    const { root, mode, changes } = setup();
    expect(root.hasAttribute('data-touch')).toBe(mode.touch);
    const down = (pointerType: string) =>
      document.dispatchEvent(new PointerEvent('pointerdown', { pointerType, bubbles: true }));
    down('touch');
    expect(mode.touch).toBe(true);
    expect(root.hasAttribute('data-touch')).toBe(true);
    down('mouse');
    expect(mode.touch).toBe(false);
    expect(root.hasAttribute('data-touch')).toBe(false);
    expect(changes()).toBeGreaterThanOrEqual(1);
  });
});
