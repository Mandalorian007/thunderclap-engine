/**
 * ws/input-12: the base map may leave out actions a context adds, typed over the full action
 * union; the pointer router is covariant in its target; overlay controls ride the recording's
 * `ui` lane and replay through `replayControl` before the tick's update.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Input } from './input';
import type { PointerRouter } from './pointer-router';
import { createInputPlayback, createInputRecorder, parseRecording } from './record';
import type { Bindings } from './types';

type Action = 'jump' | 'back';

const pads = { getGamepads: () => [] };

describe('typed context actions (ws/input-12)', () => {
  it('a base map may leave out actions of the union; a context binds them', () => {
    const input = new Input<Action>({ jump: [{ key: 'Space' }] }, pads);
    expect(input.pressed('back')).toBe(false);
    const pop = input.pushContext('menu', { bindings: { back: [{ key: 'Escape' }] } });
    input.keyDown('Escape');
    input.update();
    expect(input.pressed('back')).toBe(true);
    pop();
    input.setBindings({ jump: [{ key: 'KeyJ' }] });
    expect(input.bindings().jump).toEqual([{ key: 'KeyJ' }]);
  });

  it('types: context bindings take Partial<Bindings<A>> over the full union', () => {
    const input = new Input<Action>({ jump: [] }, pads);
    expectTypeOf(input.pushContext)
      .parameter(1)
      .toEqualTypeOf<import('./input').ContextOptions<Action> | undefined>();
    expectTypeOf<NonNullable<import('./input').ContextOptions<Action>['bindings']>>().toEqualTypeOf<
      Partial<Bindings<Action>>
    >();
    input.pushContext('menu', { bindings: { back: [] } });
    // @ts-expect-error `nope` is not an action
    input.pushContext('menu', { bindings: { nope: [] } });
    // @ts-expect-error `nope` is not an action
    expect(() => input.pressed('nope')).not.toThrow();
  });

  it('types: a full map still infers the action union, and a typed map still checks', () => {
    const inferred = new Input({ jump: [{ key: 'Space' }], fire: [] }, pads);
    expectTypeOf(inferred).toEqualTypeOf<Input<'jump' | 'fire'>>();
    const full: Bindings<Action> = { jump: [], back: [] };
    expectTypeOf(new Input(full, pads)).toEqualTypeOf<Input<Action>>();
    // @ts-expect-error `nope` is not an action of the union
    new Input<Action>({ jump: [], nope: [] }, pads);
  });

  it('types: a PointerRouter<T> is a PointerRouter<unknown> (covariant target)', () => {
    expectTypeOf<PointerRouter<{ id: number }>>().toMatchTypeOf<PointerRouter<unknown>>();
    expectTypeOf<PointerRouter<{ id: number }>>().not.toMatchTypeOf<PointerRouter<string>>();
  });
});

describe('overlay controls in recordings (ws/input-12)', () => {
  it('control(id) is recorded on its tick in the ui lane, and replays before that update', () => {
    const live = new Input<Action>({ jump: [{ key: 'Space' }] }, pads);
    const rec = createInputRecorder(live);
    live.update();
    live.update();
    live.control('menu/Start');
    live.control('menu/Quit');
    live.update();
    live.update();
    const recording = rec.stop();
    expect(recording.ticks).toEqual([
      { t: 0, n: 2 },
      { t: 2, ui: ['menu/Start', 'menu/Quit'] },
      { t: 3, n: 1 },
    ]);
    // A live control emits nothing: its handler already ran.
    const heard: string[] = [];
    live.on('control', (id) => heard.push(id));
    live.control('x');
    expect(heard).toEqual([]);

    const again = new Input<Action>({ jump: [{ key: 'Space' }] }, pads);
    const fired: [string, number][] = [];
    let updates = 0;
    again.on('control', (id) => fired.push([id, updates]));
    const pb = createInputPlayback(again, parseRecording(JSON.stringify(recording)));
    while (pb.step()) {
      again.update();
      updates++;
    }
    expect(fired).toEqual([
      ['menu/Start', 2],
      ['menu/Quit', 2],
    ]);
  });

  it('a replayed control is recorded again by a recorder on the replaying input', () => {
    const input = new Input<Action>({ jump: [] }, pads);
    const rec = createInputRecorder(input);
    input.on('control', (id) => input.control(id));
    input.replayControl('a');
    input.update();
    expect(rec.stop().ticks).toEqual([{ t: 0, ui: ['a'] }]);
  });

  it('parseRecording rejects a malformed ui lane', () => {
    expect(() => parseRecording({ version: 3, ticks: [{ t: 0, ui: [1] }] })).toThrow(/bad ui/);
    expect(() => parseRecording({ version: 3, ticks: [{ t: 0, ui: 'a' }] })).toThrow(/bad ui/);
    expect(parseRecording({ version: 1, ticks: [{ t: 0, ui: ['a'] }] }).ticks).toHaveLength(1);
  });
});
