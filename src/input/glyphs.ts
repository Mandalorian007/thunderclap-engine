/**
 * Prompt glyphs (ws/input-3): the label a game shows for a binding ("Space", "A", "Cross", "Tap"),
 * chosen for the device the player last used. Pure tables, no DOM; `Input.glyphFor(action,
 * device?)` picks the binding and calls `glyphForBinding`. The engine draws nothing: `kind` says
 * which icon set a game's UI should reach for, `label` is the text.
 */
import type { Binding, InputDevice, PointerButton, XrButton } from './types';

/** What a glyph stands for. */
export type GlyphKind = 'key' | 'button' | 'axis' | 'pointer' | 'gesture' | 'xr';

/** A prompt glyph: `kind` picks the icon set, `label` is the text. */
export interface Glyph {
  kind: GlyphKind;
  label: string;
}

/** Button naming families. `guessPadLayout(gamepad.id)` picks one; `InputOptions.padLayout` overrides. */
export type PadLayout = 'xbox' | 'playstation' | 'nintendo' | 'generic';

/** The pad layout for a `Gamepad.id` (vendor words and USB vendor ids), `'generic'` when unknown. */
export function guessPadLayout(id: string | undefined): PadLayout {
  if (!id) return 'generic';
  const s = id.toLowerCase();
  if (/xbox|xinput|microsoft|045e/.test(s)) return 'xbox';
  if (/playstation|dualshock|dualsense|sony|wireless controller|054c/.test(s)) return 'playstation';
  if (/nintendo|switch|joy-con|pro controller|057e/.test(s)) return 'nintendo';
  return 'generic';
}

const PAD_BUTTONS: Record<PadLayout, readonly string[]> = {
  xbox: [
    'A',
    'B',
    'X',
    'Y',
    'LB',
    'RB',
    'LT',
    'RT',
    'View',
    'Menu',
    'LS',
    'RS',
    '↑',
    '↓',
    '←',
    '→',
    'Xbox',
  ],
  playstation: [
    'Cross',
    'Circle',
    'Square',
    'Triangle',
    'L1',
    'R1',
    'L2',
    'R2',
    'Share',
    'Options',
    'L3',
    'R3',
    '↑',
    '↓',
    '←',
    '→',
    'PS',
  ],
  nintendo: [
    'B',
    'A',
    'Y',
    'X',
    'L',
    'R',
    'ZL',
    'ZR',
    '-',
    '+',
    'LS',
    'RS',
    '↑',
    '↓',
    '←',
    '→',
    'Home',
  ],
  generic: [],
};

/** Standard-mapping pad button `index` in `layout` (`'Button 7'` past the table or for `'generic'`). */
export function padButtonLabel(index: number, layout: PadLayout = 'generic'): string {
  return PAD_BUTTONS[layout][index] ?? `Button ${index}`;
}

const AXES = ['LS', 'LS', 'RS', 'RS'];

/** Standard-mapping pad axis `axis` pushed in `dir`: `'LS →'`, `'RS ↑'`, or `'Axis 4 +'` past the sticks. */
export function padAxisLabel(axis: number, dir: 1 | -1): string {
  const stick = AXES[axis];
  if (!stick) return `Axis ${axis} ${dir > 0 ? '+' : '-'}`;
  const vertical = axis % 2 === 1;
  const arrow = vertical ? (dir > 0 ? '↓' : '↑') : dir > 0 ? '→' : '←';
  return `${stick} ${arrow}`;
}

const KEY_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  CapsLock: 'Caps',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  ContextMenu: 'Menu',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
};

/**
 * Display text for a `KeyboardEvent.code`: `'KeyA'` → `'A'`, `'Digit1'` → `'1'`, `'Numpad1'` →
 * `'Num 1'`, `'F5'` → `'F5'`, arrows as arrows, modifiers without their side; unknown codes are
 * split at their capitals (`'AudioVolumeUp'` → `'Audio Volume Up'`).
 */
export function keyLabel(code: string): string {
  const known = KEY_LABELS[code];
  if (known) return known;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad') && code.length === 7) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const POINTER_LABELS: Record<PointerButton, string> = { select: 'Select', secondary: 'Secondary' };
const XR_LABELS: Record<XrButton, string> = {
  trigger: 'Trigger',
  squeeze: 'Squeeze',
  pinch: 'Pinch',
};
const GESTURE_LABELS: Record<string, string> = {
  tap: 'Tap',
  doubleTap: 'Double tap',
  longPress: 'Hold',
  pan: 'Drag',
  drag: 'Drag',
  pinch: 'Pinch',
};
const MOUSE_LABELS = ['Left click', 'Middle click', 'Right click', 'Back', 'Forward'];

/**
 * The glyph for one binding. A chord joins its members with ` + ` and takes the first member's
 * kind; `trigger: 'hold'` prefixes `Hold `, `'doubleTap'` prefixes `Double-tap `.
 */
export function glyphForBinding(b: Binding, layout: PadLayout = 'generic'): Glyph {
  const g = sourceGlyph(b, layout);
  if (b.trigger === 'hold') g.label = `Hold ${g.label}`;
  else if (b.trigger === 'doubleTap') g.label = `Double-tap ${g.label}`;
  return g;
}

function sourceGlyph(b: Binding, layout: PadLayout): Glyph {
  if ('key' in b) return { kind: 'key', label: keyLabel(b.key) };
  if ('mouse' in b) return { kind: 'pointer', label: MOUSE_LABELS[b.mouse] ?? `Mouse ${b.mouse}` };
  if ('wheel' in b) return { kind: 'pointer', label: b.wheel < 0 ? 'Wheel up' : 'Wheel down' };
  if ('padButton' in b) return { kind: 'button', label: padButtonLabel(b.padButton, layout) };
  if ('padAxis' in b) return { kind: 'axis', label: padAxisLabel(b.padAxis, b.dir) };
  if ('gesture' in b) return { kind: 'gesture', label: GESTURE_LABELS[b.gesture] ?? b.gesture };
  if ('pointer' in b) return { kind: 'pointer', label: POINTER_LABELS[b.pointer] };
  if ('xr' in b) return { kind: 'xr', label: XR_LABELS[b.xr] };
  const parts = b.chord.map((m) => glyphForBinding(m, layout));
  const first = parts[0];
  return { kind: first?.kind ?? 'key', label: parts.map((p) => p.label).join(' + ') };
}

/** True when `b` is what `device` produces, so its glyph is the one to show for that device. */
export function bindingMatchesDevice(b: Binding, device: InputDevice): boolean {
  if ('chord' in b) return b.chord.some((m) => bindingMatchesDevice(m, device));
  switch (device) {
    case 'keyboard':
      return 'key' in b;
    case 'mouse':
    case 'pen':
      return 'mouse' in b || 'wheel' in b || 'pointer' in b;
    case 'touch':
      return 'gesture' in b || 'pointer' in b || 'mouse' in b;
    case 'gamepad':
      return 'padButton' in b || 'padAxis' in b;
    case 'xr':
      return 'xr' in b || 'pointer' in b;
  }
}
