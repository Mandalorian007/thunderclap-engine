// @vitest-environment happy-dom
// ws/input-fit through the DOM: chorded mouse buttons reach the dispatcher's consumers and an
// attached Input's actions; a free mouse's right click taps and its still press holds; the wheel
// reaches only the intents its modifiers open; Look's move zone takes its share.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../render/camera';
import { mouseStill } from './gestures-hold';
import { Input } from './input';
import { createIntents } from './intents';
import { Look } from './look';
import { buttonBit, createPointerDispatcher, type PointerRecord } from './pointer-dispatch';

const mouse = (type: string, x: number, y: number, button: number, buttons: number) =>
  new PointerEvent(type, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    pointerType: 'mouse',
    isPrimary: true,
    button,
    buttons,
    bubbles: true,
  });

describe('ws/input-fit through the DOM', () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
    vi.spyOn(el, 'setPointerCapture').mockImplementation(() => {});
  });
  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it('buttonBit maps PointerEvent.button to its buttons bit', () => {
    expect([0, 1, 2, 3, 4].map(buttonBit)).toEqual([1, 4, 2, 8, 16]);
  });

  it('a chord (a second button while one is held) reaches pointerButton; plain moves and touches do not', () => {
    const d = createPointerDispatcher(el);
    const got: string[] = [];
    d.add({
      pointerButton: (p: PointerRecord, down: boolean) => got.push(`${p.button} ${down}`),
      pointerMove: (p) => got.push(`move ${p.button}`),
    });
    el.dispatchEvent(mouse('pointerdown', 10, 10, 0, 1));
    el.dispatchEvent(mouse('pointermove', 12, 10, -1, 1)); // a plain move
    el.dispatchEvent(mouse('pointermove', 12, 10, 2, 3)); // right down while left held
    el.dispatchEvent(mouse('pointermove', 12, 10, 0, 2)); // left up while right held
    el.dispatchEvent(mouse('pointerup', 12, 10, 2, 0));
    el.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 9,
        pointerType: 'touch',
        button: 0,
        buttons: 1,
      }),
    );
    expect(got).toEqual(['move 0', '2 true', 'move 0', '0 false', 'move 0', 'move 0']);
    d.destroy();
  });

  it("an attached Input's actions see the chorded button", () => {
    const input = new Input({ fire: [{ mouse: 0 }], dig: [{ mouse: 2 }] });
    input.attach({ pointerTarget: el });
    el.dispatchEvent(mouse('pointerdown', 10, 10, 0, 1));
    input.update();
    expect(input.held('fire')).toBe(true);
    el.dispatchEvent(mouse('pointermove', 10, 10, 2, 3));
    input.update();
    expect(input.pressed('dig')).toBe(true);
    expect(input.held('fire')).toBe(true);
    el.dispatchEvent(mouse('pointermove', 10, 10, 0, 2));
    input.update();
    expect(input.held('fire')).toBe(false);
    expect(input.held('dig')).toBe(true);
    el.dispatchEvent(mouse('pointerup', 10, 10, 2, 0));
    input.update();
    expect(input.held('dig')).toBe(false);
    input.detach();
  });

  it("a free mouse's right click taps, its still right press holds, and Alt+wheel reaches the speed intent", () => {
    let t = 0;
    const input = new Input({ dig: [{ mouse: 2 }], place: [{ mouse: 2 }] });
    input.attach({ pointerTarget: el });
    const log: string[] = [];
    const intents = createIntents(
      {
        dig: { kind: 'hold', actions: ['dig'], mouse: mouseStill({ button: 2 }) },
        place: { kind: 'tap', actions: ['place'], mouse: mouseStill({ button: 2 }) },
        speed: { kind: 'wheel', modifiers: { alt: true }, steps: false },
      },
      {
        dig: {
          start: (aim, _at, id) => log.push(`dig ${aim?.screen?.join(',')} ${id}`),
          end: () => log.push('dig end'),
        },
        place: (aim) => log.push(`place ${aim?.screen?.join(',')}`),
        speed: (d) => log.push(`speed ${d}`),
      },
      { input, camera: new Camera(), now: () => t },
    );
    const step = (ms: number) => {
      t += ms;
      input.update();
      intents.update();
    };
    el.dispatchEvent(mouse('pointerdown', 300, 100, 2, 2));
    step(16);
    el.dispatchEvent(mouse('pointerup', 300, 100, 2, 0));
    step(16);
    el.dispatchEvent(mouse('pointerdown', 500, 200, 2, 2));
    step(16);
    step(300);
    el.dispatchEvent(mouse('pointerup', 500, 200, 2, 0));
    step(16);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    // happy-dom's WheelEvent drops the modifier keys; a browser's carries them.
    const alt = new WheelEvent('wheel', { deltaY: 30, altKey: true, bubbles: true });
    Object.defineProperty(alt, 'altKey', { value: true });
    el.dispatchEvent(alt);
    step(16);
    expect(log).toEqual(['place 300,100', 'dig 500,200 1', 'dig end', 'speed 30']);
    intents.dispose();
    input.detach();
  });

  it("Look's move zone takes its share of the width", () => {
    const look = new Look({ getGamepads: () => [], touch: { moveZoneShare: 0.4 } });
    look.attach(el);
    const touch = (type: string, id: number, x: number) =>
      new PointerEvent(type, { pointerId: id, clientX: x, clientY: 200, pointerType: 'touch' });
    el.dispatchEvent(touch('pointerdown', 1, 350)); // past 40%: looks
    expect(look.stick.active).toBe(false);
    el.dispatchEvent(touch('pointerup', 1, 350));
    el.dispatchEvent(touch('pointerdown', 2, 300)); // inside: moves
    expect(look.stick.active).toBe(true);
    el.dispatchEvent(touch('pointerup', 2, 300));
    look.moveZone = 'right';
    el.dispatchEvent(touch('pointerdown', 3, 470)); // under 60% from the left: looks
    expect(look.stick.active).toBe(false);
    el.dispatchEvent(touch('pointerup', 3, 470));
    el.dispatchEvent(touch('pointerdown', 4, 480)); // the right 40%: moves
    expect(look.stick.active).toBe(true);
    look.detach();
  });
});
