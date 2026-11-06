/**
 * The context list (ws/ui-inventory): a small `role="menu"` of actions at a point or beside an
 * element, placed by `placeCard` (below, flipping above), on the host's `toasts` layer (the top
 * one, never inert under a modal) or its `hud` layer without one. ArrowUp and ArrowDown wrap over
 * the enabled items, Enter or Space picks, Escape and a press outside cancel; the first item is
 * focused on open and the focus returns to the opener on close.
 */
import { h } from './dom';
import { ensureInventoryStyles, type InventoryHost } from './inventory';
import { placeCard } from './inventory-card';

export interface ContextItem {
  id: string;
  label: string;
  /** A key hint or a note at the right. */
  hint?: string;
  disabled?: boolean;
  /** Drawn in the danger colour. */
  danger?: boolean;
}

export interface ContextListOptions {
  /** A client point (CSS px) or the element to sit beside. */
  at: { x: number; y: number } | HTMLElement;
  onPick: (id: string) => void;
  onCancel?: () => void;
  /** Accessible name. Default `Actions`. */
  label?: string;
}

export interface ContextList {
  readonly element: HTMLElement;
  /** Close without picking (no `onCancel`). */
  close(): void;
  readonly open: boolean;
}

/** A context list. See the module comment. */
export function contextList(
  host: InventoryHost,
  items: ContextItem[],
  opts: ContextListOptions,
): ContextList {
  const layer = host.layers.toasts ?? host.layers.hud;
  const doc = layer.ownerDocument;
  ensureInventoryStyles(doc);
  const opener = doc.activeElement as HTMLElement | null;

  const buttons = items.map((it) =>
    h(
      'button',
      {
        type: 'button',
        class: 'tc-context-item',
        role: 'menuitem',
        tabindex: '-1',
        'aria-disabled': it.disabled ? 'true' : undefined,
        'data-danger': it.danger === true,
        dataset: { id: it.id },
      },
      h('span', { class: 'tc-context-label' }, it.label),
      it.hint ? h('span', { class: 'tc-context-hint', 'aria-hidden': 'true' }, it.hint) : null,
    ),
  );
  const element = h(
    'div',
    { class: 'tc-context', role: 'menu', tabindex: '-1', 'aria-label': opts.label ?? 'Actions' },
    ...buttons,
  );
  layer.append(element);

  let open = true;
  const enabled = () => buttons.filter((b) => b.getAttribute('aria-disabled') !== 'true');

  function focusItem(i: number): void {
    const list = enabled();
    if (list.length === 0) {
      element.focus({ preventScroll: true });
      return;
    }
    const b = list[((i % list.length) + list.length) % list.length]!;
    for (const x of buttons) x.tabIndex = -1;
    b.tabIndex = 0;
    b.focus({ preventScroll: true });
  }

  function close(): void {
    if (!open) return;
    open = false;
    doc.removeEventListener('pointerdown', onOutside, true);
    const hadFocus = element.contains(doc.activeElement);
    element.remove();
    if (hadFocus && opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function cancel(): void {
    close();
    opts.onCancel?.();
  }

  function pickEl(b: HTMLElement | null): void {
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    const id = b.dataset.id!;
    close();
    opts.onPick(id);
  }

  const onOutside = (e: PointerEvent) => {
    if (!element.contains(e.target as Node)) cancel();
  };
  doc.addEventListener('pointerdown', onOutside, true);

  element.addEventListener('keydown', (e) => {
    const list = enabled();
    const cur = list.indexOf(doc.activeElement as HTMLButtonElement);
    switch (e.key) {
      case 'ArrowDown':
        focusItem(cur < 0 ? 0 : cur + 1);
        break;
      case 'ArrowUp':
        focusItem(cur < 0 ? -1 : cur - 1);
        break;
      case 'Home':
        focusItem(0);
        break;
      case 'End':
        focusItem(-1);
        break;
      case 'Enter':
      case ' ':
        pickEl(doc.activeElement as HTMLElement);
        break;
      case 'Escape':
        cancel();
        break;
      case 'Tab':
        cancel();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  element.addEventListener('click', (e) => {
    pickEl((e.target as HTMLElement).closest<HTMLElement>('.tc-context-item'));
  });
  element.addEventListener('contextmenu', (e) => e.preventDefault());

  // Place it: measure, then put it below the anchor, flipping above when the frame ends.
  const lr = layer.getBoundingClientRect();
  let anchor: { x: number; y: number; width: number; height: number };
  if (opts.at instanceof HTMLElement) {
    const r = opts.at.getBoundingClientRect();
    anchor = { x: r.left - lr.left, y: r.top - lr.top, width: r.width, height: r.height };
  } else {
    anchor = { x: opts.at.x - lr.left, y: opts.at.y - lr.top, width: 0, height: 0 };
  }
  const p = placeCard(
    anchor,
    { width: element.offsetWidth, height: element.offsetHeight },
    { x: 0, y: 0, width: lr.width, height: lr.height },
    'below',
  );
  element.style.transform = `translate(${p.x}px, ${p.y}px)`;
  element.dataset.placement = p.placement;
  focusItem(0);

  return {
    element,
    close,
    get open() {
      return open;
    },
  };
}
