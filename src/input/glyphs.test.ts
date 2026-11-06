import { describe, expect, it } from 'vitest';
import {
  bindingMatchesDevice,
  glyphForBinding,
  guessPadLayout,
  keyLabel,
  padAxisLabel,
  padButtonLabel,
} from './glyphs';
import { Input } from './input';
import type { GamepadLike } from './types';

describe('glyph tables', () => {
  it('guesses the pad layout from the gamepad id', () => {
    expect(
      guessPadLayout('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
    ).toBe('xbox');
    expect(guessPadLayout('DualSense Wireless Controller (Vendor: 054c)')).toBe('playstation');
    expect(guessPadLayout('Wireless Controller')).toBe('playstation');
    expect(guessPadLayout('Pro Controller (Vendor: 057e Product: 2009)')).toBe('nintendo');
    expect(guessPadLayout('Generic USB Joystick')).toBe('generic');
    expect(guessPadLayout(undefined)).toBe('generic');
  });

  it('labels pad buttons per layout and falls back to the index', () => {
    expect(padButtonLabel(0, 'xbox')).toBe('A');
    expect(padButtonLabel(0, 'playstation')).toBe('Cross');
    expect(padButtonLabel(0, 'nintendo')).toBe('B');
    expect(padButtonLabel(9, 'xbox')).toBe('Menu');
    expect(padButtonLabel(0)).toBe('Button 0');
    expect(padButtonLabel(20, 'xbox')).toBe('Button 20');
  });

  it('labels axes as sticks with arrows', () => {
    expect(padAxisLabel(0, 1)).toBe('LS →');
    expect(padAxisLabel(1, -1)).toBe('LS ↑');
    expect(padAxisLabel(3, 1)).toBe('RS ↓');
    expect(padAxisLabel(5, -1)).toBe('Axis 5 -');
  });

  it('labels key codes for display', () => {
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('KeyA')).toBe('A');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('Numpad7')).toBe('Num 7');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('ShiftLeft')).toBe('Shift');
    expect(keyLabel('F5')).toBe('F5');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('AudioVolumeUp')).toBe('Audio Volume Up');
  });

  it('builds a glyph per binding kind, with trigger prefixes and chords joined', () => {
    expect(glyphForBinding({ key: 'Space' })).toEqual({ kind: 'key', label: 'Space' });
    expect(glyphForBinding({ mouse: 0 })).toEqual({ kind: 'pointer', label: 'Left click' });
    expect(glyphForBinding({ wheel: -1 })).toEqual({ kind: 'pointer', label: 'Wheel up' });
    expect(glyphForBinding({ padButton: 1 }, 'playstation')).toEqual({
      kind: 'button',
      label: 'Circle',
    });
    expect(glyphForBinding({ padAxis: 0, dir: -1 })).toEqual({ kind: 'axis', label: 'LS ←' });
    expect(glyphForBinding({ gesture: 'pan' })).toEqual({ kind: 'gesture', label: 'Drag' });
    expect(glyphForBinding({ gesture: 'tap' })).toEqual({ kind: 'gesture', label: 'Tap' });
    expect(glyphForBinding({ gesture: 'pinch' })).toEqual({ kind: 'gesture', label: 'Pinch' });
    expect(glyphForBinding({ pointer: 'select' })).toEqual({ kind: 'pointer', label: 'Select' });
    expect(glyphForBinding({ xr: 'squeeze' })).toEqual({ kind: 'xr', label: 'Squeeze' });
    expect(glyphForBinding({ key: 'KeyC', trigger: 'hold' })).toEqual({
      kind: 'key',
      label: 'Hold C',
    });
    expect(glyphForBinding({ padButton: 0, trigger: 'doubleTap' }, 'xbox')).toEqual({
      kind: 'button',
      label: 'Double-tap A',
    });
    expect(glyphForBinding({ chord: [{ key: 'ShiftLeft' }, { key: 'KeyK' }] })).toEqual({
      kind: 'key',
      label: 'Shift + K',
    });
  });

  it('matches bindings to devices', () => {
    expect(bindingMatchesDevice({ key: 'KeyA' }, 'keyboard')).toBe(true);
    expect(bindingMatchesDevice({ key: 'KeyA' }, 'gamepad')).toBe(false);
    expect(bindingMatchesDevice({ padButton: 0 }, 'gamepad')).toBe(true);
    expect(bindingMatchesDevice({ mouse: 0 }, 'mouse')).toBe(true);
    expect(bindingMatchesDevice({ gesture: 'tap' }, 'touch')).toBe(true);
    expect(bindingMatchesDevice({ xr: 'trigger' }, 'xr')).toBe(true);
    expect(bindingMatchesDevice({ chord: [{ padButton: 0 }, { key: 'KeyA' }] }, 'gamepad')).toBe(
      true,
    );
  });
});

function pad(id: string): GamepadLike {
  return { connected: true, id, buttons: [], axes: [] };
}

describe('Input.glyphFor', () => {
  const bindings = {
    jump: [{ key: 'Space' }, { padButton: 0 }, { gesture: 'tap' as const }],
    none: [],
  };

  it('picks the binding for the last device and follows device switches', () => {
    let pads: GamepadLike[] = [];
    const input = new Input(bindings, { getGamepads: () => pads });
    expect(input.glyphFor('jump')).toEqual({ kind: 'key', label: 'Space' });
    input.pointerAt(1, 1, 'touch');
    expect(input.lastDevice).toBe('touch');
    expect(input.glyphFor('jump')).toEqual({ kind: 'gesture', label: 'Tap' });
    pads = [pad('Xbox Wireless Controller')];
    input.update();
    expect(input.glyphFor('jump', 'gamepad')).toEqual({ kind: 'button', label: 'A' });
    input.padLayout = 'playstation';
    expect(input.glyphFor('jump', 'gamepad')).toEqual({ kind: 'button', label: 'Cross' });
    // A device with no binding of its own falls back to the first binding.
    expect(input.glyphFor('jump', 'mouse')).toEqual({ kind: 'key', label: 'Space' });
    expect(input.glyphFor('none')).toBeNull();
  });

  it('exposes device changes as an event', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    const seen: string[] = [];
    const off = input.on('device', (d) => seen.push(d));
    input.keyDown('Space');
    input.pointerAt(0, 0, 'mouse');
    input.pointerAt(1, 0, 'mouse');
    input.keyDown('KeyA');
    off();
    input.pointerAt(1, 0, 'pen');
    expect(seen).toEqual(['mouse', 'keyboard']);
    expect(input.lastDevice).toBe('pen');
  });
});
