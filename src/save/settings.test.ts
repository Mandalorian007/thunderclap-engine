import { describe, expect, it } from 'vitest';
import { type Infer, s } from './schema';
import { createSettingsStore } from './settings';
import { MemoryStorage } from './storage';

const Settings = s.object({
  volume: s.number({ min: 0, max: 1 }),
  muted: s.boolean(),
  name: s.string(),
});
type Settings = Infer<typeof Settings>;

/** A fake control: `value`, optional `checked`, and the two events `bind` listens for. */
class FakeInput {
  value = '';
  checked = false;
  type: string;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(type = 'range') {
    this.type = type;
  }
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    this.listeners.set(type, set);
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

function make(mem = new MemoryStorage()) {
  return createSettingsStore<Settings>({
    game: 'g',
    defaults: () => ({ volume: 0.8, muted: false, name: 'player' }),
    schema: Settings,
    storage: mem,
    autoFlush: false,
  });
}

describe('settings store', () => {
  it('lives in the settings slot, version 1, and writes synchronously', () => {
    const mem = new MemoryStorage();
    const st = make(mem);
    expect(st.key).toBe('thunderclap:g:settings');
    st.update((d) => {
      d.volume = 0.2;
    });
    expect(JSON.parse(mem.getItem(st.key)!)).toMatchObject({ v: 1, d: { volume: 0.2 } });
    expect(st.status.dirty).toBe(false);
    expect(mem.getItem(`${st.key}:meta`)).toBeNull();
    expect(make(mem).get().volume).toBe(0.2);
  });

  it('bind: sets the control, writes on input/change with the key type, unbinds', () => {
    const mem = new MemoryStorage();
    const st = make(mem);
    const slider = new FakeInput();
    const unbind = st.bind(slider, 'volume');
    expect(slider.value).toBe('0.8');
    slider.value = '0.3';
    slider.fire('input');
    expect(st.get().volume).toBe(0.3);
    expect(JSON.parse(mem.getItem(st.key)!).d.volume).toBe(0.3);
    slider.value = 'abc';
    slider.fire('change');
    expect(st.get().volume).toBe(0.3);
    // Invalid for the schema: rejected, control shows the kept value.
    slider.value = '7';
    slider.fire('change');
    expect(st.get().volume).toBe(0.3);
    expect(slider.value).toBe('0.3');

    // A store change elsewhere reaches the control.
    st.update((d) => {
      d.volume = 0.5;
    });
    expect(slider.value).toBe('0.5');

    unbind();
    expect(slider.count()).toBe(0);
    slider.value = '0.1';
    slider.fire('input');
    expect(st.get().volume).toBe(0.5);
    st.update((d) => {
      d.volume = 0.9;
    });
    expect(slider.value).toBe('0.1');
  });

  it('bind: booleans through a checkbox and strings through a text field', () => {
    const st = make();
    const box = new FakeInput('checkbox');
    st.bind(box, 'muted');
    expect(box.checked).toBe(false);
    box.checked = true;
    box.fire('change');
    expect(st.get().muted).toBe(true);
    const text = new FakeInput('text');
    st.bind(text, 'name');
    expect(text.value).toBe('player');
    text.value = 'Ada';
    text.fire('input');
    expect(st.get().name).toBe('Ada');
    // A plain { value } object (no events) is set once and never throws.
    const plain = { value: '' };
    const unbind = st.bind(plain, 'name');
    expect(plain.value).toBe('Ada');
    unbind();
  });
});
