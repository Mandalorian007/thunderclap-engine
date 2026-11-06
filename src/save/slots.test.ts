import { describe, expect, it } from 'vitest';
import { type Infer, s } from './schema';
import { createSlotManager, slotName } from './slots';
import { MemoryStorage } from './storage';
import { saveKey } from './store';

const Data = s.object({ level: s.number({ int: true }), playMs: s.number(), name: s.string() });
type Data = Infer<typeof Data>;
const defaults = (): Data => ({ level: 1, playMs: 0, name: 'new' });

function manager(mem: MemoryStorage, clock: { t: number }, slots = 3) {
  return createSlotManager<Data>({
    game: 'g',
    version: 2,
    migrations: { 1: (d) => ({ ...(d as object), name: 'old' }) },
    defaults,
    schema: Data,
    slots,
    storage: mem,
    debounceMs: 0,
    autoFlush: false,
    now: () => clock.t,
    meta: (d) => ({ label: d.name, playMs: d.playMs, thumbnail: `thumb-${d.level}` }),
  });
}

describe('slot manager', () => {
  it('lists saved slots from sidecars without touching data, and finds the most recent', () => {
    const mem = new MemoryStorage();
    const clock = { t: 100 };
    const m = manager(mem, clock);
    expect(m.slots).toBe(3);
    expect(m.list()).toEqual([]);
    expect(m.mostRecent()).toBeNull();

    const two = m.open(2);
    two.update((d) => {
      d.name = 'Second';
      d.playMs = 5;
    });
    clock.t = 200;
    m.open(1).update((d) => {
      d.level = 3;
    });
    expect(m.open(1)).toBe(m.open(1));

    const key2 = saveKey('g', slotName(2));
    const sidecar = JSON.parse(mem.getItem(`${key2}:meta`)!);
    expect(sidecar).toEqual({
      v: 2,
      t: 100,
      size: mem.getItem(key2)!.length,
      label: 'Second',
      playMs: 5,
      thumbnail: 'thumb-1',
    });

    // Corrupt the data: list still works from the sidecar alone.
    const data2 = mem.getItem(key2)!;
    mem.setItem(key2, 'not json');
    const list = m.list();
    expect(list.map((i) => i.slot)).toEqual([1, 2]);
    expect(list[1]).toEqual({
      slot: 2,
      label: 'Second',
      savedAt: 100,
      version: 2,
      playMs: 5,
      thumbnail: 'thumb-1',
      size: data2.length,
    });
    expect(list[0]).toMatchObject({ slot: 1, label: 'new', savedAt: 200, playMs: 0 });
    expect(m.mostRecent()?.slot).toBe(1);
    mem.setItem(key2, data2);
    clock.t = 300;
    two.update((d) => {
      d.level = 9;
    });
    expect(m.mostRecent()).toMatchObject({ slot: 2, savedAt: 300, thumbnail: 'thumb-9' });
  });

  it('lists a legacy slot without a sidecar from the data envelope', () => {
    const mem = new MemoryStorage();
    const key = saveKey('g', slotName(3));
    const raw = JSON.stringify({ v: 1, t: 42, d: { level: 2, playMs: 1 } });
    mem.setItem(key, raw);
    const m = manager(mem, { t: 500 });
    expect(m.list()).toEqual([
      { slot: 3, label: 'Slot 3', savedAt: 42, version: 1, size: raw.length },
    ]);
    expect(m.rename(3, 'Old run')).toBe(true);
    expect(m.list()[0]).toMatchObject({ label: 'Old run', version: 1 });
    // Opening migrates it; the flush writes a real sidecar at the new version.
    const st = m.open(3);
    expect(st.status.loadResult).toBe('migrated');
    st.flush();
    expect(m.list()[0]).toMatchObject({ slot: 3, version: 2, savedAt: 500, label: 'old' });
  });

  it('copies both keys and removes data, sidecar and backup', () => {
    const mem = new MemoryStorage();
    const clock = { t: 1 };
    const m = manager(mem, clock);
    expect(m.copy(1, 2)).toBe(false);
    const one = m.open(1);
    one.update((d) => {
      d.name = 'A';
    });
    const three = m.open(3);
    three.update((d) => {
      d.name = 'C';
    });
    expect(m.copy(1, 3)).toBe(true);
    expect(m.copy(1, 1)).toBe(false);
    const k1 = saveKey('g', slotName(1));
    const k3 = saveKey('g', slotName(3));
    expect(mem.getItem(k3)).toBe(mem.getItem(k1));
    expect(mem.getItem(`${k3}:meta`)).toBe(mem.getItem(`${k1}:meta`));
    // The replaced open store was dropped; the next open loads the copy.
    const reopened = m.open(3);
    expect(reopened).not.toBe(three);
    expect(reopened.get().name).toBe('A');
    expect(m.list().map((i) => [i.slot, i.label])).toEqual([
      [1, 'A'],
      [3, 'A'],
    ]);

    mem.setItem(`${k1}:backup`, 'x');
    m.remove(1);
    expect(mem.getItem(k1)).toBeNull();
    expect(mem.getItem(`${k1}:meta`)).toBeNull();
    expect(mem.getItem(`${k1}:backup`)).toBeNull();
    expect(one.get()).toEqual(defaults());
    expect(one.status.loadResult).toBe('fresh');
    expect(m.list().map((i) => i.slot)).toEqual([3]);
  });

  it('keeps a renamed label through flushes when meta gives none, and bounds slot numbers', () => {
    const mem = new MemoryStorage();
    const m = createSlotManager<Data>({
      game: 'g',
      version: 1,
      defaults,
      schema: Data,
      slots: 2,
      storage: mem,
      debounceMs: 0,
      autoFlush: false,
      now: () => 1,
    });
    const st = m.open(1);
    st.update((d) => {
      d.level = 2;
    });
    expect(m.list()[0]?.label).toBe('Slot 1');
    expect(m.rename(1, 'Mine')).toBe(true);
    st.update((d) => {
      d.level = 3;
    });
    expect(m.list()[0]?.label).toBe('Mine');
    expect(m.rename(2, 'Empty')).toBe(false);
    expect(() => m.open(0)).toThrow(RangeError);
    expect(() => m.open(3)).toThrow(RangeError);
    expect(() => m.list()).not.toThrow();
  });

  it('is memory-only without storage', () => {
    const m = createSlotManager<Data>({
      game: 'g',
      version: 1,
      defaults,
      schema: Data,
      storage: null,
      debounceMs: 0,
      autoFlush: false,
    });
    const st = m.open(1);
    st.update((d) => {
      d.level = 5;
    });
    expect(st.persistent).toBe(false);
    expect(m.list()).toEqual([]);
    expect(m.copy(1, 2)).toBe(false);
    expect(m.rename(1, 'x')).toBe(false);
    m.remove(1);
    expect(st.get().level).toBe(1);
  });
});
