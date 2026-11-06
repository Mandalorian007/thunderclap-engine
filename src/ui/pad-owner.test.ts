// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCursor } from './cursor';
import { h } from './dom';
import { createOverlay, type Overlay } from './overlay';
import { type PadLike, PadNav } from './padnav';
import type { PadOwner } from './stack';

describe('pad owner (ws/ui-4)', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  let pad: { buttons: { pressed: boolean }[]; axes: number[] };
  const pads = (): readonly (PadLike | null)[] => [pad];
  const press = (i: number, down = true) => {
    pad.buttons[i]!.pressed = down;
  };
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
    pad = { buttons: Array.from({ length: 17 }, () => ({ pressed: false })), axes: [0, 0, 0, 0] };
  });
  afterEach(() => ov.destroy());

  it('flips once per open and once per close, not per panel; the remover unsubscribes', () => {
    const seen: PadOwner[] = [];
    const off = ov.stack.onPadOwnerChange((o) => seen.push(o));
    expect(ov.padOwner).toBe('game');
    const a = ov.stack.push({ title: 'A', content: h('button', null, 'a') });
    expect(ov.padOwner).toBe('stack');
    expect(seen).toEqual(['stack']);
    const b = ov.stack.push({ title: 'B', content: h('button', null, 'b') });
    expect(seen).toEqual(['stack']); // a second modal is no transition
    b.close();
    expect(seen).toEqual(['stack']);
    expect(ov.padOwner).toBe('stack');
    a.close();
    expect(seen).toEqual(['stack', 'game']);
    expect(ov.padOwner).toBe('game');
    off();
    ov.stack.push({ title: 'C', content: h('button', null, 'c') });
    expect(seen).toEqual(['stack', 'game']);
  });

  it('a modal resets the cursor latch; the pad comes back primed, without a stale press', () => {
    const steps: [number, number][] = [];
    const c = createCursor(ov, {
      mode: 'grid',
      step: (dx, dy) => steps.push([dx, dy]),
      getGamepads: pads,
    });
    press(13);
    c.update(0);
    expect(steps).toEqual([[0, 1]]);
    expect(c.latched).toBe(true);
    const p = ov.stack.push({ title: 'Menu', content: h('button', null, 'ok') });
    expect(c.latched).toBe(false); // reset on the transition, not on the next update
    c.update(100);
    c.update(600);
    expect(steps.length).toBe(1); // nothing read while the stack has the pad
    p.close();
    c.update(700);
    expect(steps.length).toBe(1); // still held from before: primed, not fresh
    press(13, false);
    c.update(800);
    press(13);
    c.update(900);
    expect(steps.length).toBe(2);
    c.dispose();
  });

  it('a press survives a no-op owner change (non-modal panels, a second modal, onClose re-push)', () => {
    const seen: PadOwner[] = [];
    ov.stack.onPadOwnerChange((o) => seen.push(o));
    const steps: [number, number][] = [];
    const c = createCursor(ov, {
      mode: 'grid',
      step: (dx, dy) => steps.push([dx, dy]),
      getGamepads: pads,
      repeat: { delay: 10_000, interval: 10_000 },
    });
    // A press already edge-detected this tick, then a non-modal panel opens and closes.
    press(15);
    c.update(0);
    expect(steps).toEqual([[1, 0]]);
    const hud = ov.stack.push({ title: 'HUD', modal: false, content: h('button', null, 'x') });
    expect(c.latched).toBe(true); // no transition, no reset
    c.update(10);
    hud.close();
    c.update(20);
    expect(seen).toEqual([]);
    expect(steps).toEqual([[1, 0]]); // still the one press: neither eaten nor doubled
    press(15, false);
    c.update(30);
    // A fresh press lands on the tick a non-modal panel opens.
    press(12);
    ov.stack.push({ title: 'HUD 2', modal: false, content: h('button', null, 'y') });
    c.update(40);
    expect(steps).toEqual([
      [1, 0],
      [0, -1],
    ]);
    press(12, false);
    c.update(50);
    // A modal whose onClose opens another: owner stays 'stack', one event each way only.
    let second: { close(): void } | null = null;
    const first = ov.stack.push({
      title: 'A',
      content: h('button', null, 'a'),
      onClose: () => {
        second = ov.stack.push({ title: 'B', content: h('button', null, 'b') });
      },
    });
    first.close();
    expect(seen).toEqual(['stack']);
    (second as { close(): void } | null)?.close();
    expect(seen).toEqual(['stack', 'game']);
    press(13);
    c.update(60);
    expect(steps.at(-1)).toEqual([0, 1]);
    c.dispose();
  });

  it('two cursors share one transition, and PadNav ignores the press that opened the menu', () => {
    const a = createCursor(ov, { mode: 'grid', step: () => {}, getGamepads: pads });
    const b = createCursor(ov, { mode: 'grid', step: () => {}, getGamepads: pads });
    let clicks = 0;
    const nav = new PadNav(ov.stack, { getGamepads: pads });
    press(13);
    a.update(0);
    b.update(0);
    expect(a.latched && b.latched).toBe(true);
    press(13, false);
    press(0); // A, held across the open
    a.update(10);
    b.update(10);
    nav.update();
    const ok = h('button', { on: { click: () => clicks++ } }, 'ok');
    const p = ov.stack.push({ title: 'Menu', content: ok });
    expect(a.latched).toBe(false);
    expect(b.latched).toBe(false);
    nav.update(); // A was down when the menu opened: not a fresh press
    expect(clicks).toBe(0);
    press(0, false);
    nav.update();
    press(0);
    nav.update();
    expect(clicks).toBe(1);
    p.close();
    expect(ov.padOwner).toBe('game');
    nav.dispose();
    a.dispose();
    b.dispose();
  });
});
