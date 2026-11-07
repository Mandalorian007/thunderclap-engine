// @vitest-environment happy-dom
/**
 * `PointerRouter.mute()` with a playback (ws/input-11): live DOM pointers on the attached target
 * are dropped, while the pointers a playback dispatches (`Input.replayPointer`, marked
 * `PointerRecord.synthetic`) still route, hit and select.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { Input } from './input';
import type { PointerRecord } from './pointer-dispatch';
import { createPointerRouter, type PointerRouter } from './pointer-router';
import { aabbTester } from './rays';
import { createInputPlayback, type InputRecording } from './record';

function ptr(type: string, x: number, y: number, id = 1) {
  return new PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    bubbles: true,
  });
}

describe('PointerRouter.mute with a playback', () => {
  let el: HTMLElement;
  let input: Input<'select'>;
  let router: PointerRouter<string>;
  let selects: string[];

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    router = createPointerRouter<string>({
      camera: Camera.ortho2d(800, 600),
      testers: [aabbTester([{ min: [0, 0, 0], max: [100, 100, 0], target: 'q' }])],
    });
    input = new Input(
      { select: [{ pointer: 'select' }] },
      { getGamepads: () => [], pointers: router },
    );
    input.setPointerTransform((x, y) => ({ x, y }));
    input.attach({ pointerTarget: el });
    selects = [];
    router.on('select', (e) => selects.push(`${e.pointer.key}:${e.hit?.target ?? '-'}`));
  });

  afterEach(() => {
    input.detach();
    el.remove();
  });

  it('marks replayed records synthetic and live ones not', () => {
    const seen: boolean[] = [];
    input.dispatcher!.add({ pointerMove: (p: PointerRecord) => seen.push(p.synthetic) });
    el.dispatchEvent(ptr('pointermove', 10, 10));
    input.replayPointer('move', 2, 'mouse', 10, 10, 0, true);
    expect(seen).toEqual([false, true]);
  });

  it('live pointers are muted; the playback pointers still select', () => {
    router.mute();
    // A live click on the target: nothing routes.
    el.dispatchEvent(ptr('pointermove', 50, 50));
    el.dispatchEvent(ptr('pointerdown', 50, 50));
    input.update();
    expect(router.pointers.length).toBe(0);
    expect(input.pressed('select')).toBe(false);
    // A recorded click (pointer 5) on the same target, fed by a playback.
    const rec: InputRecording = {
      version: 2,
      ticks: [
        { t: 0, ptr: [[1, 5, 'mouse', 40, 40, 0, 1]] },
        { t: 1, ptr: [[0, 5, 'mouse', 40, 40, 0, 1]] },
        { t: 2, ptr: [[2, 5, 'mouse', 40, 40, 0, 1]] },
      ],
    };
    const pb = createInputPlayback(input, rec);
    const pressedAt: number[] = [];
    for (let i = 0; pb.step(); i++) {
      input.update();
      if (input.pressed('select')) pressedAt.push(i);
    }
    expect(selects).toEqual(['5:q']);
    expect(pressedAt).toEqual([1]);
    expect(router.primary?.key).toBe(5);
    pb.detach();
  });
});
