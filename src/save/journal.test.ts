import { describe, expect, it } from 'vitest';
import { createJournal } from './journal';
import { type Infer, s } from './schema';
import { MemoryStorage } from './storage';
import { createSaveStore } from './store';

const Data = s.object({ n: s.number(), tiles: s.bytes() });
type Data = Infer<typeof Data>;

function store() {
  return createSaveStore<Data>({
    game: 'g',
    version: 1,
    defaults: () => ({ n: 0, tiles: new Uint8Array(4) }),
    schema: Data,
    storage: new MemoryStorage(),
    autoFlush: false,
    debounceMs: 0,
    now: () => 1,
  });
}

describe('journal', () => {
  it('checkpoint style: push before a change, undo and redo chain through store.update', () => {
    const st = store();
    const j = createJournal(st);
    expect(j.canUndo).toBe(false);
    expect(j.undo()).toBe(false);
    for (let i = 1; i <= 3; i++) {
      j.push(`step ${i}`);
      st.update((d) => {
        d.n = i;
        d.tiles[i] = i;
      });
    }
    expect(j.length).toBe(3);
    expect(j.canUndo).toBe(true);
    expect(j.canRedo).toBe(false);
    expect(j.undoLabel).toBe('step 3');

    expect(j.undo()).toBe(true);
    expect(st.get().n).toBe(2);
    expect([...st.get().tiles]).toEqual([0, 1, 2, 0]);
    expect(st.get().tiles).toBeInstanceOf(Uint8Array);
    expect(j.canRedo).toBe(true);
    expect(j.undo()).toBe(true);
    expect(j.undo()).toBe(true);
    expect(st.get().n).toBe(0);
    expect(j.undo()).toBe(false);
    expect(j.canUndo).toBe(false);

    expect(j.redo()).toBe(true);
    expect(st.get().n).toBe(1);
    expect(j.redo()).toBe(true);
    expect(j.redo()).toBe(true);
    expect(st.get().n).toBe(3);
    expect(j.redo()).toBe(false);
    expect(j.canRedo).toBe(false);
    expect(j.length).toBe(3);

    // A new change after an undo drops the redo branch.
    j.undo();
    j.push();
    st.update((d) => {
      d.n = 20;
    });
    expect(j.canRedo).toBe(false);
    expect(j.redo()).toBe(false);
    j.undo();
    expect(st.get().n).toBe(2);
  });

  it('commit style: push after each change works the same', () => {
    const st = store();
    const j = createJournal(st);
    j.push('start');
    for (let i = 1; i <= 2; i++) {
      st.update((d) => {
        d.n = i;
      });
      j.push(`set ${i}`);
    }
    expect(j.length).toBe(2);
    expect(j.undoLabel).toBe('set 1');
    expect(j.undo()).toBe(true);
    expect(st.get().n).toBe(1);
    expect(j.redoLabel).toBe('set 2');
    expect(j.undo()).toBe(true);
    expect(st.get().n).toBe(0);
    expect(j.undo()).toBe(false);
    expect(j.redo()).toBe(true);
    expect(j.redo()).toBe(true);
    expect(st.get().n).toBe(2);
    expect(j.redo()).toBe(false);
    expect(j.length).toBe(2);
  });

  it('collapses identical consecutive snapshots and honours the limit', () => {
    const st = store();
    const j = createJournal(st, { limit: 3 });
    j.push();
    j.push();
    j.push('same');
    expect(j.length).toBe(0); // a snapshot of the current data is not yet a step back
    st.update((d) => {
      d.n = 100;
    });
    expect(j.length).toBe(1);
    expect(j.undoLabel).toBe('same');
    for (let i = 1; i <= 10; i++) {
      j.push();
      st.update((d) => {
        d.n = i;
      });
    }
    expect(j.length).toBe(3);
    expect(j.undo()).toBe(true);
    expect(j.undo()).toBe(true);
    expect(j.undo()).toBe(true);
    expect(st.get().n).toBe(7);
    expect(j.undo()).toBe(false);
    expect(() => createJournal(st, { limit: 0 })).toThrow();
  });

  it('snapshots are independent of later mutation and set writes through', () => {
    const st = store();
    const j = createJournal(st);
    j.push();
    const before = st.get();
    st.update((d) => {
      d.n = 5;
    });
    before.n = 99; // a game mutating a stale reference does not touch the snapshot
    expect(j.undo()).toBe(true);
    expect(st.get().n).toBe(0);
    expect(st.status.dirty).toBe(false);
    expect(st.savedAt).toBe(1);
    j.clear();
    expect(j.canUndo).toBe(false);
    expect(j.canRedo).toBe(false);
    expect(j.redo()).toBe(false);
  });
});
