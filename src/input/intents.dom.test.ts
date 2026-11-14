// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../render/camera';
import { Input } from './input';
import { createIntents, type IntentAim } from './intents';
import { createPointerDispatcher } from './pointer-dispatch';

const ptr = (type: string, id: number, x: number, y: number, pointerType = 'touch') =>
  new PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType,
    isPrimary: id === 1,
    button: 0,
    bubbles: true,
  });

describe('intents through the dispatcher', () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
  });
  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it('captures mice and pens explicitly, never a finger (WebKit keeps a finger capture past its lift)', () => {
    const cap = vi.spyOn(el, 'setPointerCapture').mockImplementation(() => {});
    const d = createPointerDispatcher(el);
    el.dispatchEvent(ptr('pointerdown', 1, 10, 10, 'touch'));
    expect(cap).not.toHaveBeenCalled();
    el.dispatchEvent(ptr('pointerdown', 2, 10, 10, 'mouse'));
    el.dispatchEvent(ptr('pointerdown', 3, 10, 10, 'pen'));
    expect(cap.mock.calls.map((c) => c[0])).toEqual([2, 3]);
    d.destroy();
  });

  it("an attached input's touches tap and hold; the stick zone's touches do not tap", () => {
    let t = 0;
    const input = new Input({ use: [{ pointer: 'select' }] });
    input.attach({ pointerTarget: el });
    const camera = new Camera();
    const log: string[] = [];
    const intents = createIntents(
      { use: { kind: 'tap', actions: ['use'] }, act: { kind: 'hold' } },
      {
        use: (aim: IntentAim) => log.push(`tap ${aim?.screen?.join(',')}`),
        act: {
          start: (aim) => log.push(`hold ${aim?.screen?.join(',')}`),
          end: () => log.push('end'),
        },
      },
      { input, camera, now: () => t, stickZone: 'left' },
    );
    const step = (ms: number) => {
      t += ms;
      input.update();
      intents.update();
    };
    // Right half: a tap, once (the pointer binding's own press is the touch's).
    el.dispatchEvent(ptr('pointerdown', 1, 600, 100));
    step(16);
    el.dispatchEvent(ptr('pointerup', 1, 600, 100));
    step(16);
    // Left half (the move stick): no tap.
    el.dispatchEvent(ptr('pointerdown', 2, 100, 100));
    step(16);
    el.dispatchEvent(ptr('pointerup', 2, 100, 100));
    step(16);
    // Right half, held still: a hold.
    el.dispatchEvent(ptr('pointerdown', 3, 500, 200));
    step(16);
    step(400);
    el.dispatchEvent(ptr('pointerup', 3, 500, 200));
    step(16);
    expect(log).toEqual(['tap 600,100', 'hold 500,200', 'end']);
    intents.dispose();
    input.detach();
  });
});
