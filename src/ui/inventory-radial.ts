/**
 * The radial menu (ws/ui-inventory): four to eight sectors on a ring on the `hud` layer, centred
 * where it is opened (the frame's centre by default). `aim(x, y)` from a stick or a drag picks the
 * sector (nothing inside the dead zone), `pick()` fires `onPick`; the keyboard rotates the
 * highlight with the arrows, Enter picks, Escape cancels. `role="menu"` of `menuitem`s; hidden
 * under a modal like the reticle (`data-modal` from `stack.onChange`).
 *
 * Sector 0 is east and the sectors go clockwise (screen y down): `aim(1, 0)` highlights sector 0
 * and `aim(0, 1)` the one a quarter turn on.
 */
import { h } from './dom';
import { themePx } from './hud';
import { ensureInventoryStyles, type InventoryHost, iconNode } from './inventory';

export interface RadialItem {
  id: string;
  icon: string | HTMLElement | HTMLCanvasElement;
  label: string;
  disabled?: boolean;
}

export interface RadialOptions {
  /** Four to eight items; fewer or more are clamped. */
  items: RadialItem[];
  /** Ring radius, theme px. Default 110. */
  radius?: number;
  /** Aim length under which nothing is highlighted (0..1). Default 0.35. */
  deadzone?: number;
  onPick: (id: string) => void;
  onCancel?: () => void;
  /** Accessible name. Default `Radial menu`. */
  label?: string;
}

export interface Radial {
  readonly element: HTMLElement;
  /** Show, centred at `at` (client CSS px) or at the frame's centre; takes the focus. */
  open(at?: { x: number; y: number }): void;
  /** Hide without picking; the focus returns to where it was. */
  close(): void;
  /** Aim from a stick or a drag, -1..1 on both axes; outside the dead zone the sector is highlighted. */
  aim(x: number, y: number): void;
  /** The highlighted sector, or -1. */
  readonly highlighted: number;
  /** Fire `onPick` for the highlighted item (if any, and enabled) and close. */
  pick(): boolean;
  readonly visible: boolean;
  remove(): void;
}

/** A radial menu on the host's `hud` layer. See the module comment. */
export function radial(host: InventoryHost, opts: RadialOptions): Radial {
  const layer = host.layers.hud;
  const doc = layer.ownerDocument;
  ensureInventoryStyles(doc);
  const items = opts.items.slice(0, 8);
  const n = Math.max(1, items.length);
  const step = 360 / n;
  const deadzone = opts.deadzone ?? 0.35;

  const buttons = items.map((it, i) =>
    h(
      'button',
      {
        type: 'button',
        class: 'tc-radial-item',
        role: 'menuitem',
        tabindex: '-1',
        'aria-label': it.label,
        'aria-disabled': it.disabled ? 'true' : undefined,
        dataset: { index: String(i), id: it.id },
        style: { '--tc-radial-angle': `${i * step}deg` },
      },
      iconNode(it.icon, doc),
    ),
  );
  const sector = h('div', { class: 'tc-radial-sector' });
  const label = h('div', { class: 'tc-radial-label', 'aria-live': 'polite' });
  const element = h(
    'div',
    {
      class: 'tc-radial',
      role: 'menu',
      tabindex: '-1',
      'aria-label': opts.label ?? 'Radial menu',
      hidden: true,
      style: {
        '--tc-radial-radius': themePx(opts.radius ?? 110),
        '--tc-radial-sweep': `${step}deg`,
      },
    },
    h('div', { class: 'tc-radial-ring' }),
    sector,
    ...buttons,
    label,
  );
  layer.append(element);

  let highlighted = -1;
  let opener: HTMLElement | null = null;

  function highlight(i: number): void {
    if (i === highlighted) return;
    if (highlighted >= 0) buttons[highlighted]?.removeAttribute('data-active');
    highlighted = i;
    if (i >= 0) {
      buttons[i]!.setAttribute('data-active', '');
      element.setAttribute('data-active', '');
      // The sector is centred on the item: conic gradients start at 12 o'clock, so east is +90°.
      element.style.setProperty('--tc-radial-from', `${90 + i * step - step / 2}deg`);
      label.textContent = items[i]!.label;
    } else {
      element.removeAttribute('data-active');
      label.textContent = '';
    }
  }

  function aim(x: number, y: number): void {
    if (Math.hypot(x, y) < deadzone) {
      highlight(-1);
      return;
    }
    const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    highlight(Math.round(deg / step) % n);
  }

  function pick(): boolean {
    if (highlighted < 0 || items[highlighted]?.disabled) return false;
    const id = items[highlighted]!.id;
    close();
    opts.onPick(id);
    return true;
  }

  function open(at?: { x: number; y: number }): void {
    if (at) {
      const r = layer.getBoundingClientRect();
      element.style.left = `${at.x - r.left}px`;
      element.style.top = `${at.y - r.top}px`;
    } else {
      element.style.removeProperty('left');
      element.style.removeProperty('top');
    }
    if (!element.hidden) return;
    opener = doc.activeElement as HTMLElement | null;
    element.hidden = false;
    highlight(-1);
    element.focus({ preventScroll: true });
  }

  function close(): void {
    if (element.hidden) return;
    element.hidden = true;
    highlight(-1);
    if (opener?.isConnected && doc.activeElement === element) opener.focus({ preventScroll: true });
    opener = null;
  }

  element.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        highlight(highlighted < 0 ? 0 : (highlighted + 1) % n);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        highlight(highlighted < 0 ? n - 1 : (highlighted - 1 + n) % n);
        break;
      case 'Enter':
      case ' ':
        pick();
        break;
      case 'Escape':
        close();
        opts.onCancel?.();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  element.addEventListener('pointermove', (e) => {
    const r = element.getBoundingClientRect();
    const rad = r.width / 2;
    if (rad <= 0) return;
    aim((e.clientX - r.left - rad) / rad, (e.clientY - r.top - rad) / rad);
  });
  element.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.tc-radial-item');
    if (!b) return;
    highlight(Number(b.dataset.index));
    pick();
  });

  const offStack = host.stack?.onChange((s) => element.toggleAttribute('data-modal', s.hasModal));
  if (host.stack?.hasModal) element.setAttribute('data-modal', '');

  return {
    element,
    open,
    close,
    aim,
    get highlighted() {
      return highlighted;
    },
    pick,
    get visible() {
      return !element.hidden && !element.hasAttribute('data-modal');
    },
    remove() {
      close();
      offStack?.();
      element.remove();
    },
  };
}
