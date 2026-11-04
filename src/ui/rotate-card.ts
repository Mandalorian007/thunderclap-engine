/**
 * The "turn it sideways" card for a landscape game on a phone held upright (interim API: Phase 2's
 * portrait layout regions retire it, D-041).
 *
 * The card covers the whole viewport, outside the scaled overlay (upright, the overlay is a thin
 * strip), and goes the moment the phone turns. Nothing is paused: the game underneath just waits
 * for input. All words are the game's, passed as options.
 *
 * It shows when the viewport is portrait and the device is a phone in hand: a handheld by
 * `deviceTraits()`, or a finger on a phone-scale screen by the device mode. A narrow desktop
 * window never gets it.
 */

import { isPortrait } from '../platform/device';
import type { DeviceMode } from '../platform/device-mode';
import { deviceTraits } from '../platform/environment';
import { h } from './dom';

const STYLE_ATTR = 'rotate-card';

const CSS = /* css */ `
.tc-rotate {
  position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 22px; padding: max(24px, env(safe-area-inset-top)) 28px;
  box-sizing: border-box; text-align: center; background: var(--tc-rotate-bg, #0b0d14);
  color: var(--tc-rotate-text, #ece6d8); font-family: var(--tc-rotate-font, Georgia, serif);
  touch-action: none; user-select: none; -webkit-user-select: none;
}
.tc-rotate[hidden] { display: none; }
.tc-rotate-phone {
  width: 54px; height: 92px; border: 3px solid var(--tc-rotate-accent, #e0b45a); border-radius: 12px;
  box-sizing: border-box; box-shadow: 0 0 24px var(--tc-rotate-glow, rgba(224,180,90,0.35));
  animation: tc-rotate-turn 2.4s ease-in-out infinite;
}
.tc-rotate-phone::after {
  content: ''; display: block; width: 14px; height: 3px; margin: 78px auto 0; border-radius: 2px;
  background: var(--tc-rotate-accent, #e0b45a);
}
@keyframes tc-rotate-turn { 0%, 25% { transform: rotate(0deg); } 55%, 100% { transform: rotate(-90deg); } }
@media (prefers-reduced-motion: reduce) { .tc-rotate-phone { animation: none; transform: rotate(-90deg); } }
.tc-rotate h2 { margin: 0; font-size: 24px; color: var(--tc-rotate-accent, #e0b45a); letter-spacing: 1px; font-weight: 600; }
.tc-rotate p { margin: 0; max-width: 300px; font-size: 17px; line-height: 1.45; }
.tc-rotate .tc-rotate-note { font-size: 16px; font-style: italic; color: var(--tc-rotate-muted, #a7a091); }
.tc-rotate .tc-rotate-note b {
  font-style: normal; color: var(--tc-rotate-accent, #e0b45a); letter-spacing: 1px; font-size: 13px; margin-right: 6px;
}
`;

/** The card's look. Each is a CSS value; omitted ones use neutral engine defaults. */
export interface RotateCardColors {
  /** Card background (any `background` value, gradients included). */
  background?: string;
  text?: string;
  /** Heading, phone outline and the note's tag. */
  accent?: string;
  /** The phone outline's glow. */
  glow?: string;
  /** The note line. */
  muted?: string;
  font?: string;
}

export interface RotateCardOptions {
  /** Heading, e.g. "Turn your phone sideways". Also the dialog's accessible name by default. */
  title: string;
  /** Body paragraphs under the heading. */
  lines?: readonly string[];
  /** An optional last line in italics, with a short bold tag before it (a speaker, say). */
  note?: { tag?: string; text: string };
  /** Accessible name. Default: `title`. */
  ariaLabel?: string;
  /** The device mode; a finger on a phone-scale screen counts as a phone in hand. */
  device?: Pick<DeviceMode, 'phone' | 'touch' | 'onChange'>;
  colors?: RotateCardColors;
  /** Document to mount into. Default: the global `document`. */
  doc?: Document;
}

export interface RotateCard {
  /** The card (`role=dialog`), appended to `<body>`. */
  readonly element: HTMLElement;
  /** True while the card shows. */
  readonly visible: boolean;
  /** Re-check orientation. It also runs on resize, orientation change and device-mode change. */
  update(): void;
  destroy(): void;
}

export function createRotateCard(opts: RotateCardOptions): RotateCard {
  const doc = opts.doc ?? document;
  const win = doc.defaultView ?? window;
  if (!doc.querySelector(`style[data-tc="${STYLE_ATTR}"]`)) {
    doc.head.append(h('style', { 'data-tc': STYLE_ATTR }, CSS));
  }
  const c = opts.colors ?? {};
  const style: Record<string, string> = {};
  const vars: [keyof RotateCardColors, string][] = [
    ['background', '--tc-rotate-bg'],
    ['text', '--tc-rotate-text'],
    ['accent', '--tc-rotate-accent'],
    ['glow', '--tc-rotate-glow'],
    ['muted', '--tc-rotate-muted'],
    ['font', '--tc-rotate-font'],
  ];
  for (const [k, v] of vars) if (c[k]) style[v] = c[k];
  const note = opts.note
    ? h(
        'p',
        { class: 'tc-rotate-note' },
        opts.note.tag ? h('b', null, opts.note.tag) : null,
        opts.note.text,
      )
    : null;
  const element = h(
    'div',
    {
      class: 'tc-rotate',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': opts.ariaLabel ?? opts.title,
      hidden: true,
      style,
    },
    h('div', { class: 'tc-rotate-phone', 'aria-hidden': 'true' }),
    h('h2', null, opts.title),
    ...(opts.lines ?? []).map((t) => h('p', null, t)),
    note,
  );
  doc.body.append(element);

  const device = opts.device;
  const update = () => {
    const phoneInHand = deviceTraits().handheld || (!!device?.touch && !!device?.phone);
    element.hidden = !(isPortrait(win) && phoneInHand);
  };
  const offDevice = device?.onChange(update);
  win.addEventListener('resize', update);
  win.addEventListener('orientationchange', update);
  update();

  return {
    element,
    get visible() {
      return !element.hidden;
    },
    update,
    destroy() {
      offDevice?.();
      win.removeEventListener('resize', update);
      win.removeEventListener('orientationchange', update);
      element.remove();
    },
  };
}
