// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { CURSOR_CSS, createCursor, pickTarget, type WorldTarget } from './cursor';
import { h } from './dom';
import { createOverlay, type Overlay } from './overlay';
import type { PadLike } from './padnav';

/** The translate of an anchored element's transform. */
const xy = (el: HTMLElement): [number, number] => {
  const m = /translate(?:3d)?\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform)!;
  return [Number(m[1]), Number(m[2])];
};

const cell = (x: number, y: number): WorldTarget => ({ id: `${x},${y}`, x, y, world: [x, y, 0] });

describe('pickTarget', () => {
  const grid: WorldTarget[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.push(cell(x, y));

  it('picks the neighbour straight in the pressed direction', () => {
    const from = cell(1, 1);
    expect(pickTarget(from, grid, 'right')?.id).toBe('2,1');
    expect(pickTarget(from, grid, 'left')?.id).toBe('0,1');
    expect(pickTarget(from, grid, 'up')?.id).toBe('1,0');
    expect(pickTarget(from, grid, 'down')?.id).toBe('1,2');
    expect(pickTarget(cell(2, 1), grid, 'right')).toBeNull();
  });

  it('weights sideways drift: a nearer diagonal loses to one further but in line', () => {
    const targets = [cell(1, 1), cell(2, 0)];
    expect(pickTarget(cell(0, 0), targets, 'right')?.id).toBe('2,0');
    // Only drift available: the least cost wins, and nothing behind counts.
    expect(pickTarget(cell(0, 0), [cell(1, 2), cell(2, 1), cell(-1, 0)], 'right')?.id).toBe('2,1');
  });
});

describe('cursor', () => {
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

  it('grid mode steps on fresh presses, latches, repeats while held and selects on A', () => {
    const steps: [number, number][] = [];
    let selected = 0;
    const c = createCursor(ov, {
      mode: 'grid',
      step: (dx, dy) => steps.push([dx, dy]),
      onSelect: () => selected++,
      getGamepads: pads,
      repeat: { delay: 400, interval: 100 },
    });
    expect(document.getElementById('tc-ui-cursor')?.textContent).toBe(CURSOR_CSS);
    press(15); // right
    c.update(0);
    expect(steps).toEqual([[1, 0]]);
    c.update(100);
    c.update(399);
    expect(steps.length).toBe(1); // latched until the repeat delay
    c.update(400);
    expect(steps.length).toBe(2);
    c.update(450);
    expect(steps.length).toBe(2);
    c.update(500);
    expect(steps.length).toBe(3);
    press(15, false);
    c.update(600);
    expect(steps.length).toBe(3);
    press(15);
    c.update(700);
    expect(steps.length).toBe(4); // released and pressed again: fresh
    press(15, false);
    pad.axes[1] = -1; // stick up
    c.update(800);
    expect(steps.at(-1)).toEqual([0, -1]);
    pad.axes[1] = 0;
    press(0); // A
    c.update(900);
    c.update(1000);
    expect(selected).toBe(1);
    press(0, false);
    c.update(1050);
    c.press('activate'); // a press from the game's own input
    c.update(1100);
    expect(selected).toBe(2);
    c.dispose();
  });

  it('the arrow keys and Enter drive it, except from a control that uses them', () => {
    const steps: [number, number][] = [];
    let selected = 0;
    const c = createCursor(ov, {
      mode: 'grid',
      step: (dx, dy) => steps.push([dx, dy]),
      onSelect: () => selected++,
      getGamepads: () => [],
    });
    const key = (type: string, key: string) =>
      document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
    key('keydown', 'ArrowLeft');
    c.update(0);
    c.update(10);
    expect(steps).toEqual([[-1, 0]]);
    key('keyup', 'ArrowLeft');
    key('keydown', 'Enter');
    c.update(20);
    key('keyup', 'Enter');
    expect(selected).toBe(1);
    const input = h('input', { type: 'text' });
    ov.layers.hud.append(input);
    input.focus();
    key('keydown', 'ArrowLeft');
    c.update(30);
    expect(steps.length).toBe(1); // the text field keeps left/right
    key('keydown', 'ArrowDown');
    c.update(40);
    expect(steps.length).toBe(2);
    c.dispose();
  });

  it('yields to a modal panel and resumes after it, without a stale press', () => {
    const steps: [number, number][] = [];
    const c = createCursor(ov, {
      mode: 'grid',
      step: (dx, dy) => steps.push([dx, dy]),
      getGamepads: pads,
    });
    const p = ov.stack.push({ title: 'Menu', content: h('button', null, 'ok') });
    press(13); // down, while the panel has the pad
    c.update(0);
    c.update(500);
    expect(steps).toEqual([]);
    p.close();
    c.update(600);
    expect(steps).toEqual([]); // still held from before: not fresh
    press(13, false);
    c.update(700);
    press(13);
    c.update(800);
    expect(steps).toEqual([[0, 1]]);
    c.disable();
    press(13, false);
    c.update(900);
    press(13);
    c.update(1000);
    expect(steps.length).toBe(1);
    c.enable();
    press(13, false);
    c.update(1100);
    press(13);
    c.update(1200);
    expect(steps.length).toBe(2);
    c.dispose();
  });

  it('targets mode snaps between targets and anchors the cursor element', () => {
    ov.setFrame({ x: 0, y: 0, width: 960, height: 540 });
    const cam = Camera.ortho2d(1920, 1080);
    ov.anchors(() => cam);
    const targets = [
      { id: 'a', x: 0, y: 0, world: [100, 100, 0] },
      { id: 'b', x: 1, y: 0, world: [300, 100, 0] },
      { id: 'c', x: 1, y: 1, world: [300, 300, 0] },
    ];
    const moves: (string | number | undefined)[] = [];
    const c = createCursor(ov, {
      mode: 'targets',
      targets: () => targets,
      onMove: (t) => moves.push(t?.id),
      getGamepads: pads,
    });
    expect(c.element.hidden).toBe(true);
    c.setTarget(targets[0]!);
    expect(c.element.parentElement).toBe(ov.layers.hud);
    expect(c.element.hidden).toBe(false);
    ov.updateAnchors();
    expect(xy(c.element)[0]).toBeCloseTo(50, 3);
    expect(xy(c.element)[1]).toBeCloseTo(50, 3);
    press(15);
    c.update(0);
    expect(c.target?.id).toBe('b');
    expect(c.position).toBe(targets[1]!.world);
    press(15, false);
    press(13);
    c.update(100);
    expect(c.target?.id).toBe('c');
    ov.updateAnchors();
    expect(xy(c.element)[0]).toBeCloseTo(150, 3);
    expect(xy(c.element)[1]).toBeCloseTo(150, 3);
    press(13, false);
    press(12);
    c.update(200);
    press(12);
    c.update(300);
    expect(c.target?.id).toBe('b');
    expect(moves).toEqual(['a', 'b', 'c', 'b']);
    c.setTarget(null);
    expect(c.element.hidden).toBe(true);
    expect(c.position).toBeNull();
    c.dispose();
    expect(c.element.isConnected).toBe(false);
  });
});
