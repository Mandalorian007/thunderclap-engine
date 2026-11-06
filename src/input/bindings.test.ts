import { afterEach, describe, expect, it, vi } from 'vitest';
import { findConflicts, isBinding, parseBindings, serializeBindings } from './bindings';
import type { Binding, Bindings } from './types';

type A = 'jump' | 'fire' | 'crouch';

const defaults: Bindings<A> = {
  jump: [{ key: 'Space' }, { padButton: 0 }],
  fire: [{ mouse: 0 }, { padButton: 2 }],
  crouch: [{ key: 'KeyC', trigger: 'hold', holdMs: 500 }],
};

describe('serializeBindings / parseBindings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('round-trips a map through JSON', () => {
    const text = serializeBindings(defaults);
    expect(JSON.parse(text)).toEqual(defaults);
    expect(parseBindings(text, defaults)).toEqual(defaults);
  });

  it('drops unknown actions with a warning and fills missing ones from the defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = JSON.stringify({ jump: [{ key: 'KeyJ' }], dash: [{ key: 'KeyD' }] });
    const map = parseBindings(saved, defaults);
    expect(map).toEqual({ jump: [{ key: 'KeyJ' }], fire: defaults.fire, crouch: defaults.crouch });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/dash/);
  });

  it('drops malformed bindings and keeps the rest; bad text yields the defaults', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = JSON.stringify({
      jump: [{ key: 'KeyJ' }, { bogus: 1 }, { padAxis: 0 }, { key: 'KeyK', trigger: 'nope' }],
      fire: 'nope',
    });
    const map = parseBindings(saved, defaults);
    expect(map.jump).toEqual([{ key: 'KeyJ' }]);
    expect(map.fire).toBe(defaults.fire);
    expect(parseBindings('{not json', defaults)).toBe(defaults);
    expect(parseBindings('[1]', defaults)).toBe(defaults);
    expect(parseBindings({ jump: [] }, defaults).jump).toEqual([]);
  });

  it('accepts every binding shape, including chords and triggers', () => {
    const all: Binding[] = [
      { key: 'KeyA', trigger: 'doubleTap', doubleTapMs: 250 },
      { mouse: 2 },
      { wheel: 1 },
      { padButton: 3, pad: 1, threshold: 0.2 },
      { padAxis: 1, dir: -1 },
      { gesture: 'longPress' },
      { pointer: 'secondary' },
      { xr: 'pinch', hand: 'left' },
      { chord: [{ key: 'ShiftLeft' }, { mouse: 0 }] },
    ];
    for (const b of all) expect(isBinding(b), JSON.stringify(b)).toBe(true);
    expect(isBinding({ chord: [{ nope: 1 }] })).toBe(false);
    expect(isBinding({ xr: 'pinch', hand: 'both' })).toBe(false);
    expect(isBinding({ wheel: 2 })).toBe(false);
    expect(isBinding(null)).toBe(false);
  });
});

describe('findConflicts', () => {
  it('lists each input bound to more than one action, once', () => {
    const map: Bindings<A> = {
      jump: [{ key: 'Space' }, { padButton: 0 }],
      fire: [{ key: 'Space' }, { padButton: 0 }, { mouse: 0 }],
      crouch: [
        { key: 'Space', trigger: 'press' },
        { key: 'KeyC', trigger: 'hold' },
      ],
    };
    const conflicts = findConflicts(map);
    expect(conflicts).toEqual([
      { binding: { key: 'Space' }, actions: ['jump', 'fire', 'crouch'] },
      { binding: { padButton: 0 }, actions: ['jump', 'fire'] },
    ]);
  });

  it('treats different triggers, different fields and different chords as different inputs', () => {
    const map = {
      a: [{ key: 'KeyC', trigger: 'hold' as const }, { chord: [{ key: 'KeyA' }, { key: 'KeyB' }] }],
      b: [{ key: 'KeyC' }, { chord: [{ key: 'KeyB' }, { key: 'KeyA' }] }],
      c: [{ chord: [{ key: 'KeyA' }, { key: 'KeyB' }] }],
    };
    const conflicts = findConflicts(map);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.actions).toEqual(['a', 'c']);
    expect(findConflicts(defaults)).toEqual([]);
  });
});
