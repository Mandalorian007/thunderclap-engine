/**
 * The drag context (ws/ui-inventory): one per overlay, it moves items between registered
 * `DropTarget`s (grids, and `ui.slots` strips through `slotsTarget`).
 *
 * - Pointer: a mouse or pen drags once it moves `moveThreshold` (4 CSS px) from the press; a
 *   touch waits `longPressMs` (160) and a pan before that is left to the page. A ghost (a clone
 *   of the item's box) follows the pointer on the host's `hud` layer, `pointer-events: none`;
 *   the spot under the pointer gets `data-over`, and `data-reject` when the target refuses. A
 *   drop commits through both ends (`release` on the source, `drop` on the target); a refused
 *   drop or a release over nothing snaps the ghost back over `--tc-duration-fast`, at once when
 *   motion is reduced.
 * - Keyboard and pad: a grid's pick-up (`carryStart`) is held here as `dragging`; at a grid's
 *   left or right edge the carry walks to the neighbouring target in reading order (`cross`),
 *   `commit` drops, `cancelCarry` puts it back.
 *
 * Per pointer move it writes one transform and runs the targets' `spotAt`, which return stored
 * objects: nothing is allocated on the move path.
 */
import type { Slots } from './hud';
import type {
  CellItem,
  CellRef,
  DragLink,
  DragPick,
  DropSpot,
  DropTarget,
  InventoryHost,
} from './inventory';
import { ensureInventoryStyles } from './inventory';
import type { Card, CardOptions } from './inventory-card';
import { prefersReducedMotion } from './styles';

export interface DragContextOptions {
  /** Touch hold before a drag starts, ms. Default 160. */
  longPressMs?: number;
  /** Mouse or pen travel that starts a drag, CSS px. Default 4. */
  moveThreshold?: number;
  /** Touch travel before the hold that leaves the touch to the page (a pan), CSS px. Default 10. */
  panThreshold?: number;
  /** Snap-back time, ms, when `--tc-duration-fast` cannot be read. Default 120. */
  returnMs?: number;
}

export interface DragContext {
  register(target: DropTarget): void;
  unregister(target: DropTarget): void;
  /** The item in flight (pointer or keyboard), or null. */
  readonly dragging: DragPick | null;
  /** Abort a drag or a carry; the item stays where it was. */
  cancel(): void;
  /** Registered targets in reading order (top to bottom, then left to right). A fresh array. */
  readonly targets: DropTarget[];
  destroy(): void;
}

interface Pending {
  pick: DragPick;
  id: number;
  type: string;
  x0: number;
  y0: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A drag context over `host.layers.hud`. See the module comment. */
export function createDragContext(host: InventoryHost, opts: DragContextOptions = {}): DragContext {
  const layer = host.layers.hud;
  const doc = layer.ownerDocument;
  ensureInventoryStyles(doc);
  const longPressMs = opts.longPressMs ?? 160;
  const moveThreshold = opts.moveThreshold ?? 4;
  const panThreshold = opts.panThreshold ?? 10;
  const returnMs = opts.returnMs ?? 120;

  const targets: DropTarget[] = [];
  let pending: Pending | null = null;
  let drag: DragPick | null = null;
  let carry: { pick: DragPick; target: DropTarget } | null = null;
  let ghost: HTMLElement | null = null;
  let ghostDx = 0;
  let ghostDy = 0;
  let layerX = 0;
  let layerY = 0;
  let overTarget: DropTarget | null = null;
  let overSpot: DropSpot | null = null;
  let active = false;

  const link: DragLink = {
    pointerStart,
    carryStart(pick) {
      if (drag || carry) cancel();
      carry = { pick, target: pick.source };
    },
    cross(from, dir, pick) {
      const order = sorted();
      const i = order.indexOf(from);
      if (i < 0) return false;
      const step = dir === 'right' ? 1 : -1;
      for (let j = i + step; j >= 0 && j < order.length; j += step) {
        const next = order[j]!;
        if (!next.carryIn) continue;
        if (carry && carry.target !== pick.source) carry.target.carryEnd?.();
        carry = { pick, target: next };
        next.carryIn(pick, dir === 'right' ? 'left' : 'right');
        return true;
      }
      return false;
    },
    commit(target, spot, pick) {
      if (!target.canDrop(spot, pick)) return false;
      land(target, spot, pick);
      endCarry();
      return true;
    },
    cancelCarry() {
      endCarry();
    },
    pointerActive: () => active,
  };

  function sorted(): DropTarget[] {
    return [...targets].sort((a, b) => {
      const ra = a.element.getBoundingClientRect();
      const rb = b.element.getBoundingClientRect();
      // Same band (overlapping vertically): left to right; else top to bottom.
      const overlap = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      return overlap > 0 ? ra.left - rb.left : ra.top - rb.top;
    });
  }

  function land(target: DropTarget, spot: DropSpot, pick: DragPick): void {
    if (target !== pick.source && target.grid && pick.source.release) {
      const to: CellRef = { grid: target.grid, col: spot.col, row: spot.row };
      pick.source.release(pick, to);
    }
    target.drop(spot, pick);
  }

  function endCarry(): void {
    if (!carry) return;
    const c = carry;
    carry = null;
    c.pick.source.carryEnd?.();
    if (c.target !== c.pick.source) c.target.carryEnd?.();
  }

  // ---------------------------------------------------------------- pointer

  function pointerStart(pick: DragPick, e: PointerEvent): void {
    if (pending || drag) return;
    if (carry) endCarry();
    pending = {
      pick,
      id: e.pointerId,
      type: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      timer: null,
    };
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    if (e.pointerType === 'touch') {
      pending.timer = setTimeout(() => {
        if (pending) begin(pending, pending.x0, pending.y0);
      }, longPressMs);
    }
  }

  function begin(p: Pending, x: number, y: number): void {
    if (p.timer !== null) clearTimeout(p.timer);
    pending = null;
    drag = p.pick;
    active = true;
    const srcEl =
      p.pick.from.grid.spots()[p.pick.from.row * p.pick.from.grid.cols + p.pick.from.col]!.el;
    const box = srcEl.querySelector<HTMLElement>('.tc-cell-item');
    const rect = (box ?? srcEl).getBoundingClientRect();
    const lr = layer.getBoundingClientRect();
    layerX = lr.left;
    layerY = lr.top;
    ghostDx = p.x0 - rect.left;
    ghostDy = p.y0 - rect.top;
    ghost = doc.createElement('div');
    ghost.className = 'tc-drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    if (box) {
      const clone = box.cloneNode(true) as HTMLElement;
      clone.style.removeProperty('--tc-span-w');
      ghost.append(clone);
    }
    layer.append(ghost);
    doc.addEventListener('touchmove', preventTouch, { passive: false, capture: true });
    track(x, y);
  }

  function preventTouch(e: TouchEvent): void {
    if (e.cancelable) e.preventDefault();
  }

  function track(x: number, y: number): void {
    if (!ghost || !drag) return;
    ghost.style.transform = `translate(${x - ghostDx - layerX}px, ${y - ghostDy - layerY}px)`;
    let t: DropTarget | null = null;
    let s: DropSpot | null = null;
    for (let i = 0; i < targets.length; i++) {
      s = targets[i]!.spotAt(x, y);
      if (s) {
        t = targets[i]!;
        break;
      }
    }
    if (t === overTarget && s === overSpot) return;
    if (overTarget && overTarget !== t) overTarget.hover(null, false);
    overTarget = t;
    overSpot = s;
    if (t && s) t.hover(s, !t.canDrop(s, drag));
  }

  function onMove(e: PointerEvent): void {
    if (pending) {
      if (e.pointerId !== pending.id) return;
      const dx = e.clientX - pending.x0;
      const dy = e.clientY - pending.y0;
      const d = Math.hypot(dx, dy);
      if (pending.type === 'touch') {
        if (d > panThreshold) stop();
      } else if (d >= moveThreshold) begin(pending, e.clientX, e.clientY);
      return;
    }
    if (drag) track(e.clientX, e.clientY);
  }

  function onUp(e: PointerEvent): void {
    if (pending) {
      if (e.pointerId === pending.id) stop();
      return;
    }
    if (!drag) return;
    const pick = drag;
    track(e.clientX, e.clientY);
    if (overTarget && overSpot && overTarget.canDrop(overSpot, pick)) {
      land(overTarget, overSpot, pick);
      finish(false);
    } else {
      finish(true);
    }
  }

  function onCancel(): void {
    if (pending) stop();
    else if (drag) finish(true);
  }

  /** Stop listening (a pending press ended without a drag). */
  function stop(): void {
    if (pending?.timer !== null && pending?.timer !== undefined) clearTimeout(pending.timer);
    pending = null;
    detach();
  }

  function detach(): void {
    doc.removeEventListener('pointermove', onMove, true);
    doc.removeEventListener('pointerup', onUp, true);
    doc.removeEventListener('pointercancel', onCancel, true);
    doc.removeEventListener('touchmove', preventTouch, true);
  }

  /** End a drag: the ghost goes away, or flies back to the source cell first. */
  function finish(snapBack: boolean): void {
    const pick = drag;
    drag = null;
    detach();
    overTarget?.hover(null, false);
    overTarget = null;
    overSpot = null;
    const g = ghost;
    ghost = null;
    // The click that follows this release must not activate the cell.
    setTimeout(() => {
      active = false;
    }, 0);
    if (!g) return;
    if (!snapBack || !pick || prefersReducedMotion(doc.defaultView ?? undefined)) {
      g.remove();
      return;
    }
    const src = pick.from.grid.spots()[pick.from.row * pick.from.grid.cols + pick.from.col]?.el;
    const box = src?.querySelector<HTMLElement>('.tc-cell-item') ?? src;
    if (!box) {
      g.remove();
      return;
    }
    const r = box.getBoundingClientRect();
    g.setAttribute('data-return', '');
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      g.remove();
    };
    g.addEventListener('transitionend', end);
    setTimeout(end, returnMs + 80);
    // Next frame, so the transition sees a change.
    const win = doc.defaultView;
    const next = win?.requestAnimationFrame
      ? (fn: () => void) => win.requestAnimationFrame(fn)
      : (fn: () => void) => setTimeout(fn, 0);
    next(() => {
      g.style.transform = `translate(${r.left - layerX}px, ${r.top - layerY}px)`;
    });
  }

  function cancel(): void {
    if (pending) stop();
    if (drag) finish(true);
    if (carry) endCarry();
  }

  return {
    register(t) {
      if (targets.includes(t)) return;
      targets.push(t);
      t.link = link;
    },
    unregister(t) {
      const i = targets.indexOf(t);
      if (i < 0) return;
      targets.splice(i, 1);
      if (t.link === link) t.link = null;
      if (drag?.source === t || overTarget === t || carry?.pick.source === t || carry?.target === t)
        cancel();
    },
    get dragging() {
      return drag ?? carry?.pick ?? null;
    },
    cancel,
    get targets() {
      return sorted();
    },
    destroy() {
      cancel();
      for (const t of targets) if (t.link === link) t.link = null;
      targets.length = 0;
    },
  };
}

export interface SlotsTargetOptions {
  /** The game's rule; default: every slot takes every item. */
  canAssign?: (index: number, item: CellItem, from: CellRef) => boolean;
  /** A card shown while a pointer hovers a slot (after `hoverMs`), filled by `describe`. */
  card?: Card;
  describe?: (index: number) => CardOptions | null;
  hoverMs?: number;
}

export interface SlotsTarget extends DropTarget {
  readonly slots: Slots;
  /** Stop listening for hover. */
  remove(): void;
}

/**
 * A `ui.slots` strip as a `DropTarget`: a drag over a slot highlights it and a drop calls
 * `onAssign(index, item, from)`; the item stays in its grid (an assignment, not a move). Slots
 * are not focusable, so the pad walk skips the strip.
 */
export function slotsTarget(
  slots: Slots,
  onAssign: (index: number, item: CellItem, from: CellRef) => void,
  opts: SlotsTargetOptions = {},
): SlotsTarget {
  const els = [...slots.el.querySelectorAll<HTMLElement>('.tc-slot')];
  const spots: DropSpot[] = els.map((el, i) => ({ el, col: i, row: 0 }));
  const hoverMs = opts.hoverMs ?? 250;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown: HTMLElement | null = null;

  function spotAt(x: number, y: number): DropSpot | null {
    const r = slots.el.getBoundingClientRect();
    if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return null;
    for (let i = 0; i < els.length; i++) {
      const b = els[i]!.getBoundingClientRect();
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) return spots[i]!;
    }
    return null;
  }

  function slotIndex(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('.tc-slot') ?? null;
    return el ? els.indexOf(el) : -1;
  }

  function hideCard(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (shown) {
      opts.card?.hide();
      shown = null;
    }
  }

  const onOver = (e: PointerEvent) => {
    const i = slotIndex(e.target);
    if (i < 0 || !opts.card || !opts.describe || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const d = opts.describe?.(i);
      if (!d) return;
      opts.card?.set(d);
      shown = els[i]!;
      opts.card?.show(shown);
    }, hoverMs);
  };
  const onOut = (e: PointerEvent) => {
    if (slotIndex(e.relatedTarget) === slotIndex(e.target) && slotIndex(e.target) >= 0) return;
    hideCard();
  };
  // The strip is `pointer-events: none` by default; hovering needs it on.
  if (opts.card) {
    slots.el.style.pointerEvents = 'auto';
    slots.el.addEventListener('pointerover', onOver);
    slots.el.addEventListener('pointerout', onOut);
  }

  return {
    element: slots.el,
    slots,
    link: null,
    spotAt,
    spots: () => spots,
    canDrop: (spot, pick) => opts.canAssign?.(spot.col, pick.item, pick.from) ?? true,
    drop(spot, pick) {
      onAssign(spot.col, pick.item, pick.from);
    },
    hover(spot, reject) {
      for (const el of els) {
        el.removeAttribute('data-over');
        el.removeAttribute('data-reject');
      }
      if (!spot) return;
      spot.el.setAttribute('data-over', '');
      if (reject) spot.el.setAttribute('data-reject', '');
    },
    remove() {
      hideCard();
      slots.el.removeEventListener('pointerover', onOver);
      slots.el.removeEventListener('pointerout', onOut);
    },
  };
}
