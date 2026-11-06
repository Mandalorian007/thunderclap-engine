// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from './dom';
import { type CellItem, ensureInventoryStyles, INVENTORY_CSS } from './inventory';
import { card, placeCard } from './inventory-card';
import { contextList } from './inventory-context';
import { createDragContext, slotsTarget } from './inventory-drag';
import { type Grid, grid } from './inventory-grid';
import { type RadialItem, radial } from './inventory-radial';
import { createOverlay, type Overlay } from './overlay';
import { button } from './widgets';

const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const down = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(down);
  if (!init.repeat)
    el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, ...init }));
  return down;
};
const hold = (el: Element, k: string) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, repeat: true }),
  );
  el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
};
const item = (id: string, extra: Partial<CellItem> = {}): CellItem => ({
  id,
  icon: id[0]!,
  ...extra,
});
const cellAt = (g: Grid, col: number, row: number) =>
  g.element.querySelector<HTMLElement>(`.tc-cell[data-col="${col}"][data-row="${row}"]`)!;

describe('inventory', () => {
  let parent: HTMLElement;
  let ui: Overlay;
  beforeEach(() => {
    document.body.innerHTML = '';
    for (const s of document.head.querySelectorAll('style')) s.remove();
    parent = h('div');
    document.body.append(parent);
    ui = createOverlay({ parent, caption: { reducedMotion: true } });
  });
  afterEach(() => ui.destroy());

  it('injects INVENTORY_CSS once, in tokens only', () => {
    ensureInventoryStyles(document);
    ensureInventoryStyles(document);
    expect(document.querySelectorAll('#tc-ui-inventory').length).toBe(1);
    expect(document.getElementById('tc-ui-inventory')?.textContent).toBe(INVENTORY_CSS);
    // Colours are tokens only (the `#000` in mask gradients is alpha, not a colour).
    expect(INVENTORY_CSS.replace(/mask: [^;]*;/g, '')).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    for (const cls of [
      '.tc-grid',
      '.tc-cell-count',
      '.tc-drag-ghost',
      '.tc-inv-card',
      '.tc-radial',
      '.tc-context',
    ])
      expect(INVENTORY_CSS).toContain(cls);
  });

  describe('placeCard', () => {
    const frame = { x: 0, y: 0, width: 1000, height: 600 };
    const size = { width: 200, height: 100 };
    it('goes right when it fits, flips left near the right edge, clamps', () => {
      const a = { x: 100, y: 100, width: 50, height: 50 };
      expect(placeCard(a, size, frame)).toEqual({ x: 150, y: 100, placement: 'right' });
      const b = { x: 900, y: 100, width: 50, height: 50 };
      expect(placeCard(b, size, frame)).toEqual({ x: 700, y: 100, placement: 'left' });
      expect(placeCard(b, size, frame, 'right')).toEqual({ x: 700, y: 100, placement: 'left' });
      const low = { x: 100, y: 560, width: 50, height: 50 };
      expect(placeCard(low, size, frame).y).toBe(500);
    });
    it('falls through to below and above, then to the side with the most room', () => {
      const wide = { x: 0, y: 100, width: 1000, height: 50 };
      expect(placeCard(wide, size, frame).placement).toBe('below');
      const lowWide = { x: 0, y: 540, width: 1000, height: 50 };
      expect(placeCard(lowWide, size, frame).placement).toBe('above');
      const huge = { x: 0, y: 0, width: 1000, height: 600 };
      expect(placeCard(huge, size, frame).placement).toBe('right');
      expect(placeCard(wide, size, frame, 'below', 10)).toEqual({
        x: 0,
        y: 160,
        placement: 'below',
      });
    });
  });

  describe('grid', () => {
    it('builds a role=grid of gridcells with a roving tabindex and renders items', () => {
      const g = grid({ cols: 4, rows: 2, label: 'Bag' });
      ui.layers.hud.append(g.element);
      expect(g.element.getAttribute('role')).toBe('grid');
      expect(g.element.getAttribute('aria-label')).toBe('Bag');
      expect(g.element.getAttribute('aria-rowcount')).toBe('2');
      expect(g.element.getAttribute('aria-colcount')).toBe('4');
      const cells = g.element.querySelectorAll('[role=gridcell]');
      expect(cells.length).toBe(8);
      expect(cells[0]?.getAttribute('tabindex')).toBe('0');
      expect(cells[1]?.getAttribute('tabindex')).toBe('-1');
      expect(
        g.set({ col: 1, row: 0 }, item('potion', { label: 'Potion', count: 3, tone: 'info' })),
      ).toBe(true);
      const c = cellAt(g, 1, 0);
      expect(c.getAttribute('aria-label')).toBe('Potion, 3');
      expect(c.querySelector('.tc-cell-count')?.textContent).toBe('3');
      expect(c.querySelector('.tc-cell-item')?.getAttribute('data-tone')).toBe('info');
      expect(g.get({ col: 1, row: 0 })?.id).toBe('potion');
      expect(g.items).toEqual([
        { col: 1, row: 0, item: expect.objectContaining({ id: 'potion' }) },
      ]);
      // A 2×1 span covers its second cell, which refuses another item.
      expect(g.set({ col: 2, row: 0 }, item('bow', { span: { w: 2, h: 1 } }))).toBe(true);
      expect(cellAt(g, 3, 0).hasAttribute('data-covered')).toBe(true);
      expect(g.get({ col: 3, row: 0 })?.id).toBe('bow');
      expect(g.set({ col: 3, row: 1 }, item('long', { span: { w: 2, h: 1 } }))).toBe(false);
      expect(g.find(g.get({ col: 3, row: 0 })!)).toEqual({ col: 2, row: 0 });
      // Setting over a covered cell replaces what covered it.
      expect(g.set({ col: 3, row: 0 }, item('x'))).toBe(true);
      expect(g.get({ col: 2, row: 0 })).toBeNull();
      expect(cellAt(g, 3, 0).hasAttribute('data-covered')).toBe(false);
      g.set({ col: 3, row: 0 }, null);
      expect(g.get({ col: 3, row: 0 })).toBeNull();
    });

    it('arrows clamp without wrapping; Home and End; Enter activates on release', () => {
      const onActivate = vi.fn();
      const onFocus = vi.fn();
      const g = grid({ cols: 3, rows: 2, onActivate, onFocus });
      ui.layers.hud.append(g.element);
      g.set({ col: 2, row: 0 }, item('a'));
      g.focus({ col: 0, row: 0 });
      key(cellAt(g, 0, 0), 'ArrowLeft');
      expect(g.focused).toEqual({ col: 0, row: 0 });
      key(cellAt(g, 0, 0), 'ArrowRight');
      key(cellAt(g, 1, 0), 'ArrowRight');
      key(cellAt(g, 2, 0), 'ArrowRight');
      expect(g.focused).toEqual({ col: 2, row: 0 });
      expect(document.activeElement).toBe(cellAt(g, 2, 0));
      expect(cellAt(g, 2, 0).tabIndex).toBe(0);
      expect(cellAt(g, 0, 0).tabIndex).toBe(-1);
      key(cellAt(g, 2, 0), 'ArrowDown');
      expect(g.focused).toEqual({ col: 2, row: 1 });
      key(cellAt(g, 2, 1), 'Home');
      expect(g.focused).toEqual({ col: 0, row: 1 });
      key(cellAt(g, 0, 1), 'End');
      expect(g.focused).toEqual({ col: 2, row: 1 });
      key(cellAt(g, 2, 1), 'ArrowUp');
      const e = key(cellAt(g, 2, 0), 'Enter');
      expect(e.defaultPrevented).toBe(true);
      expect(onActivate).toHaveBeenCalledWith(
        { col: 2, row: 0 },
        expect.objectContaining({ id: 'a' }),
      );
      expect(onFocus).toHaveBeenCalled();
    });

    it('reports onFocus when the focus enters the grid at its current cell', () => {
      const onFocus = vi.fn();
      const g = grid({ cols: 2, rows: 1, onFocus });
      ui.layers.hud.append(g.element);
      // The default cell (0, 0) is the entry point: no index change, still a focus change.
      cellAt(g, 0, 0).focus();
      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onFocus).toHaveBeenLastCalledWith({ col: 0, row: 0 });
      key(cellAt(g, 0, 0), 'ArrowRight');
      expect(onFocus).toHaveBeenCalledTimes(2);
      cellAt(g, 1, 0).focus();
      expect(onFocus).toHaveBeenCalledTimes(2);
    });

    it('a held Enter picks up, the next Enter drops, Escape puts it back; locked items stay', () => {
      const onMove = vi.fn();
      const g = grid({ cols: 3, rows: 1, onMove });
      ui.layers.hud.append(g.element);
      const a = item('a');
      g.set({ col: 0, row: 0 }, a);
      g.set({ col: 2, row: 0 }, item('lock', { locked: true }));
      g.focus({ col: 0, row: 0 });
      hold(cellAt(g, 0, 0), 'Enter');
      expect(g.held).toBe(a);
      expect(cellAt(g, 0, 0).getAttribute('aria-grabbed')).toBe('true');
      key(cellAt(g, 0, 0), 'ArrowRight');
      expect(cellAt(g, 1, 0).hasAttribute('data-over')).toBe(true);
      key(cellAt(g, 1, 0), 'Escape');
      expect(g.held).toBeNull();
      expect(g.get({ col: 0, row: 0 })).toBe(a);
      expect(cellAt(g, 0, 0).hasAttribute('aria-grabbed')).toBe(false);
      expect(onMove).not.toHaveBeenCalled();
      // Pad: select, right, select.
      g.focus({ col: 0, row: 0 });
      expect(g.act('select')).toBe(true);
      g.act('right');
      g.act('select');
      expect(g.get({ col: 1, row: 0 })).toBe(a);
      expect(g.get({ col: 0, row: 0 })).toBeNull();
      expect(onMove).toHaveBeenCalledWith(
        expect.objectContaining({ col: 0, row: 0 }),
        expect.objectContaining({ col: 1, row: 0 }),
        a,
      );
      g.focus({ col: 2, row: 0 });
      expect(g.act('select')).toBe(false);
      expect(g.held).toBeNull();
      const live = g.element.querySelector('[aria-live]');
      expect(live?.textContent).toContain('Dropped');
    });

    it('canDrop refuses: the cell shows data-reject and the drop leaves items unchanged', () => {
      const onMove = vi.fn();
      const g = grid({ cols: 2, rows: 1, onMove, canDrop: (_f, to) => to.col !== 1 });
      ui.layers.hud.append(g.element);
      const a = item('a');
      g.set({ col: 0, row: 0 }, a);
      g.focus({ col: 0, row: 0 });
      g.act('select');
      g.act('right');
      expect(cellAt(g, 1, 0).hasAttribute('data-reject')).toBe(true);
      g.act('select');
      expect(g.get({ col: 0, row: 0 })).toBe(a);
      expect(g.held).toBe(a);
      expect(onMove).not.toHaveBeenCalled();
      g.act('back');
      expect(g.held).toBeNull();
    });

    it('opens the context hook on Shift+F10, ContextMenu, contextmenu and pad secondary', () => {
      const onContext = vi.fn();
      const g = grid({ cols: 2, rows: 1, onContext });
      ui.layers.hud.append(g.element);
      g.set({ col: 1, row: 0 }, item('a'));
      g.focus({ col: 0, row: 0 });
      key(cellAt(g, 0, 0), 'F10', { shiftKey: true });
      expect(onContext).not.toHaveBeenCalled();
      g.focus({ col: 1, row: 0 });
      key(cellAt(g, 1, 0), 'F10', { shiftKey: true });
      key(cellAt(g, 1, 0), 'ContextMenu');
      const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      cellAt(g, 1, 0).dispatchEvent(cm);
      expect(cm.defaultPrevented).toBe(true);
      g.act('secondary');
      expect(onContext).toHaveBeenCalledTimes(4);
      expect(onContext).toHaveBeenLastCalledWith(
        { col: 1, row: 0 },
        expect.objectContaining({ id: 'a' }),
        cellAt(g, 1, 0),
      );
    });

    it('shows the card on focus and hides it on blur and Escape', () => {
      const c = card(ui, { title: '', rows: [] });
      const g = grid({ cols: 2, rows: 1, card: c, describe: (it) => ({ title: it.id, rows: [] }) });
      ui.layers.hud.append(g.element);
      g.set({ col: 1, row: 0 }, item('sword'));
      g.focus({ col: 1, row: 0 });
      expect(c.visible).toBe(true);
      expect(c.element.querySelector('.tc-inv-card-title')?.textContent).toBe('sword');
      expect(cellAt(g, 1, 0).getAttribute('aria-describedby')).toBe(c.element.id);
      key(cellAt(g, 1, 0), 'Escape');
      expect(c.visible).toBe(false);
      expect(cellAt(g, 1, 0).hasAttribute('aria-describedby')).toBe(false);
      g.focus({ col: 1, row: 0 });
      g.focus({ col: 0, row: 0 });
      expect(c.visible).toBe(false);
    });
  });

  describe('drag context', () => {
    it('walks a pad carry across grids in reading order and commits through both ends', () => {
      const moves: string[] = [];
      const a = grid({
        cols: 2,
        rows: 2,
        onMove: (f, t, it) => moves.push(`a:${it.id}:${f.col},${f.row}>${t.col},${t.row}`),
      });
      const b = grid({
        cols: 2,
        rows: 1,
        onMove: (f, t, it) => moves.push(`b:${it.id}:${f.col},${f.row}>${t.col},${t.row}`),
        canDrop: (_f, _t, it) => it.tone === 'accent',
      });
      ui.layers.hud.append(a.element, b.element);
      const drag = createDragContext(ui);
      drag.register(a);
      drag.register(b);
      expect(drag.targets).toEqual([a, b]);
      const sword = item('sword', { tone: 'accent' });
      a.set({ col: 1, row: 1 }, sword);
      a.focus({ col: 1, row: 1 });
      a.act('select');
      expect(drag.dragging?.item).toBe(sword);
      a.act('right');
      expect(b.focused).toEqual({ col: 0, row: 0 });
      expect(document.activeElement).toBe(cellAt(b, 0, 0));
      expect(cellAt(b, 0, 0).hasAttribute('data-over')).toBe(true);
      expect(b.held).toBe(sword);
      // Back to the left edge of a (its right column, last row).
      b.act('left');
      expect(a.focused).toEqual({ col: 1, row: 1 });
      a.act('right');
      b.act('select');
      expect(b.get({ col: 0, row: 0 })).toBe(sword);
      expect(a.get({ col: 1, row: 1 })).toBeNull();
      expect(moves).toEqual(['a:sword:1,1>0,0', 'b:sword:1,1>0,0']);
      expect(drag.dragging).toBeNull();
      expect(a.held).toBeNull();
      expect(b.held).toBeNull();
      // Rejected by b's rule: the plain item stays in a; cancel puts the carry down.
      const rock = item('rock');
      a.set({ col: 0, row: 0 }, rock);
      a.focus({ col: 0, row: 0 });
      a.act('select');
      a.act('right');
      a.act('right');
      expect(b.focused).toEqual({ col: 0, row: 0 });
      expect(cellAt(b, 0, 0).hasAttribute('data-reject')).toBe(true);
      b.act('select');
      expect(a.get({ col: 0, row: 0 })).toBe(rock);
      drag.cancel();
      expect(drag.dragging).toBeNull();
      expect(cellAt(b, 0, 0).hasAttribute('data-over')).toBe(false);
      drag.unregister(b);
      expect(b.link).toBeNull();
      a.focus({ col: 1, row: 0 });
      drag.destroy();
    });

    it('a pointer press on an item starts a drag after the move threshold and drops with the mouse', () => {
      vi.useFakeTimers();
      try {
        const a = grid({ cols: 2, rows: 1 });
        ui.layers.hud.append(a.element);
        const drag = createDragContext(ui);
        drag.register(a);
        const sword = item('sword');
        a.set({ col: 0, row: 0 }, sword);
        const down = new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: 10,
          clientY: 10,
        });
        cellAt(a, 0, 0).dispatchEvent(down);
        expect(drag.dragging).toBeNull();
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            pointerType: 'mouse',
            clientX: 20,
            clientY: 10,
          }),
        );
        expect(drag.dragging?.item).toBe(sword);
        const ghost = ui.layers.hud.querySelector<HTMLElement>('.tc-drag-ghost');
        expect(ghost).not.toBeNull();
        expect(ghost?.getAttribute('aria-hidden')).toBe('true');
        expect(ghost?.querySelector('.tc-cell-item')).not.toBeNull();
        // Released over nothing (no layout here): the ghost goes at once under reduced motion.
        document.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 1,
            pointerType: 'mouse',
            clientX: 20,
            clientY: 10,
          }),
        );
        expect(drag.dragging).toBeNull();
        expect(a.get({ col: 0, row: 0 })).toBe(sword);
        vi.runAllTimers();
        // A touch press is a pan until the long press.
        const touch = new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 2,
          pointerType: 'touch',
          clientX: 10,
          clientY: 10,
        });
        cellAt(a, 0, 0).dispatchEvent(touch);
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 2,
            pointerType: 'touch',
            clientX: 10,
            clientY: 40,
          }),
        );
        vi.advanceTimersByTime(200);
        expect(drag.dragging).toBeNull();
        cellAt(a, 0, 0).dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 3,
            pointerType: 'touch',
            clientX: 10,
            clientY: 10,
          }),
        );
        vi.advanceTimersByTime(159);
        expect(drag.dragging).toBeNull();
        vi.advanceTimersByTime(2);
        expect(drag.dragging?.item).toBe(sword);
        document.dispatchEvent(
          new PointerEvent('pointercancel', { pointerId: 3, pointerType: 'touch' }),
        );
        expect(drag.dragging).toBeNull();
        drag.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('slotsTarget assigns a copy on drop and marks the hovered slot', () => {
      const strip = ui.slots({ count: 3 });
      const onAssign = vi.fn();
      const t = slotsTarget(strip, onAssign, { canAssign: (i) => i !== 2 });
      const a = grid({ cols: 1, rows: 1 });
      ui.layers.hud.append(a.element);
      const drag = createDragContext(ui);
      drag.register(a);
      drag.register(t);
      const potion = item('potion');
      a.set({ col: 0, row: 0 }, potion);
      const pick = a.pickAt?.(0, 0) ?? {
        item: potion,
        from: { grid: a, col: 0, row: 0 },
        source: a,
      };
      const spots = t.spots();
      expect(spots.length).toBe(3);
      t.hover(spots[1]!, false);
      expect(spots[1]!.el.hasAttribute('data-over')).toBe(true);
      expect(t.canDrop(spots[2]!, pick)).toBe(false);
      expect(t.link!.commit(t, spots[2]!, pick)).toBe(false);
      expect(t.link!.commit(t, spots[1]!, pick)).toBe(true);
      expect(onAssign).toHaveBeenCalledWith(1, potion, expect.objectContaining({ col: 0, row: 0 }));
      expect(a.get({ col: 0, row: 0 })).toBe(potion);
      t.remove();
      drag.destroy();
    });
  });

  describe('card', () => {
    it('renders rows with tones and compare arrows, shows at a rect and hides', () => {
      const c = card(ui, {
        title: 'Blade',
        subtitle: 'Rare',
        tone: 'accent',
        rows: [{ label: 'Power', value: '12', compare: 'up', tone: 'success' }],
        footer: 'Hold to compare',
      });
      expect(c.element.parentElement).toBe(ui.layers.hud);
      expect(c.element.getAttribute('role')).toBe('tooltip');
      expect(c.element.hidden).toBe(true);
      expect(c.element.dataset.tone).toBe('accent');
      const dd = c.element.querySelector('dd');
      expect(dd?.getAttribute('data-compare')).toBe('up');
      expect(dd?.getAttribute('data-tone')).toBe('success');
      expect(c.element.querySelector('dt')?.textContent).toBe('Power');
      c.set({ title: 'Blade', rows: [{ label: 'Power', value: '13' }] });
      expect(c.element.querySelector('dd')?.textContent).toBe('13');
      expect(c.element.querySelector('dd')?.hasAttribute('data-compare')).toBe(false);
      expect(c.element.dataset.tone).toBeUndefined();
      c.show({ x: 10, y: 10, width: 20, height: 20 }, 'below');
      expect(c.visible).toBe(true);
      // No layout here (every rect is 0), so the side is whichever fits; it is reported both ways.
      expect(['below', 'above']).toContain(c.placement);
      expect(c.element.dataset.placement).toBe(c.placement);
      c.hide();
      expect(c.visible).toBe(false);
      expect(c.placement).toBeNull();
      c.remove();
      expect(c.element.isConnected).toBe(false);
    });
  });

  describe('radial', () => {
    const items = (n: number): RadialItem[] =>
      Array.from({ length: n }, (_, i) => ({ id: `i${i}`, icon: String(i), label: `Item ${i}` }));
    it('highlights by aim with sector 0 east, rotates with the arrows, picks and cancels', () => {
      const onPick = vi.fn();
      const onCancel = vi.fn();
      const r = radial(ui, { items: items(8), onPick, onCancel });
      expect(r.element.getAttribute('role')).toBe('menu');
      expect(r.element.querySelectorAll('[role=menuitem]').length).toBe(8);
      expect(r.visible).toBe(false);
      r.open();
      expect(r.visible).toBe(true);
      expect(document.activeElement).toBe(r.element);
      r.aim(0.1, 0.1);
      expect(r.highlighted).toBe(-1);
      r.aim(1, 0);
      expect(r.highlighted).toBe(0);
      expect(r.element.querySelector('[data-active]')?.getAttribute('aria-label')).toBe('Item 0');
      r.aim(0, 1);
      expect(r.highlighted).toBe(2);
      r.aim(-1, 0);
      expect(r.highlighted).toBe(4);
      r.aim(0.7, -0.7);
      expect(r.highlighted).toBe(7);
      key(r.element, 'ArrowRight');
      expect(r.highlighted).toBe(0);
      key(r.element, 'ArrowLeft');
      key(r.element, 'ArrowLeft');
      expect(r.highlighted).toBe(6);
      key(r.element, 'Enter');
      expect(onPick).toHaveBeenCalledWith('i6');
      expect(r.visible).toBe(false);
      r.open({ x: 100, y: 50 });
      expect(r.element.style.left).toBe('100px');
      key(r.element, 'Escape');
      expect(onCancel).toHaveBeenCalled();
      expect(r.visible).toBe(false);
      r.remove();
    });
    it('clamps to eight items, refuses a disabled pick and hides under a modal', () => {
      const onPick = vi.fn();
      const list = items(10);
      list[0]!.disabled = true;
      const r = radial(ui, { items: list, onPick, radius: 90, deadzone: 0.5 });
      expect(r.element.querySelectorAll('[role=menuitem]').length).toBe(8);
      expect(r.element.style.getPropertyValue('--tc-radial-sweep')).toBe('45deg');
      r.open();
      r.aim(0.4, 0);
      expect(r.highlighted).toBe(-1);
      r.aim(1, 0);
      expect(r.pick()).toBe(false);
      expect(onPick).not.toHaveBeenCalled();
      expect(r.visible).toBe(true);
      ui.stack.push({ title: 'Pause', content: button('OK', () => {}) });
      expect(r.element.hasAttribute('data-modal')).toBe(true);
      expect(r.visible).toBe(false);
      ui.stack.pop();
      expect(r.element.hasAttribute('data-modal')).toBe(false);
      r.remove();
    });
  });

  describe('context list', () => {
    it('focuses the first item, wraps over enabled items, picks and returns focus', () => {
      const opener = button('Open', () => {});
      ui.layers.hud.append(opener);
      opener.focus();
      const onPick = vi.fn();
      const onCancel = vi.fn();
      const list = contextList(
        ui,
        [
          { id: 'use', label: 'Use', hint: 'E' },
          { id: 'split', label: 'Split', disabled: true },
          { id: 'drop', label: 'Drop', danger: true },
        ],
        { at: opener, onPick, onCancel },
      );
      expect(list.element.parentElement).toBe(ui.layers.toasts);
      expect(list.element.getAttribute('role')).toBe('menu');
      const items = list.element.querySelectorAll<HTMLElement>('[role=menuitem]');
      expect(items.length).toBe(3);
      expect(document.activeElement).toBe(items[0]);
      expect(items[1]?.getAttribute('aria-disabled')).toBe('true');
      expect(items[2]?.hasAttribute('data-danger')).toBe(true);
      expect(items[0]?.querySelector('.tc-context-hint')?.textContent).toBe('E');
      key(list.element, 'ArrowDown');
      expect(document.activeElement).toBe(items[2]);
      key(list.element, 'ArrowDown');
      expect(document.activeElement).toBe(items[0]);
      key(list.element, 'ArrowUp');
      expect(document.activeElement).toBe(items[2]);
      key(list.element, 'Enter');
      expect(onPick).toHaveBeenCalledWith('drop');
      expect(list.open).toBe(false);
      expect(list.element.isConnected).toBe(false);
      expect(document.activeElement).toBe(opener);
      // Escape cancels and returns the focus; an outside press cancels too.
      const l2 = contextList(ui, [{ id: 'a', label: 'A' }], {
        at: { x: 5, y: 5 },
        onPick,
        onCancel,
      });
      expect(document.activeElement).not.toBe(opener);
      key(l2.element, 'Escape');
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(opener);
      const l3 = contextList(ui, [{ id: 'a', label: 'A' }], {
        at: { x: 5, y: 5 },
        onPick,
        onCancel,
      });
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(l3.open).toBe(false);
      expect(onCancel).toHaveBeenCalledTimes(2);
    });
  });

  it('is reachable from the overlay, and ui.grid registers with ui.drag', () => {
    const g = ui.grid({ cols: 2, rows: 1 });
    expect(ui.drag.targets).toEqual([g]);
    expect(g.link).not.toBeNull();
    expect(ui.card({ title: 'x', rows: [] }).element.parentElement).toBe(ui.layers.hud);
    expect(ui.radial({ items: [], onPick: () => {} }).element.parentElement).toBe(ui.layers.hud);
    const l = ui.contextList([{ id: 'a', label: 'A' }], { at: { x: 0, y: 0 }, onPick: () => {} });
    expect(l.element.parentElement).toBe(ui.layers.toasts);
    l.close();
    expect(document.querySelectorAll('#tc-ui-inventory').length).toBe(1);
  });
});
