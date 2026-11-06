/**
 * An undo journal over a save store: snapshots of the store's validated data, restored through
 * `store.set`. Call `push()` before a change (a checkpoint) or after one (a commit); both work.
 */
import { saveReplacer } from './codec';
import type { SaveStore } from './store';

export interface JournalOptions {
  /** Most undo steps kept. Default 50. */
  limit?: number;
}

export interface Journal {
  /** Snapshot the current data. Identical to the last snapshot: no-op. Clears redo. */
  push(label?: string): void;
  /** Restore the previous snapshot (the current data becomes the redo step). False when none. */
  undo(): boolean;
  /** Restore the next snapshot after an undo. False when none. */
  redo(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Undo steps available. */
  readonly length: number;
  /** The label of the step `undo` would restore, if `push` gave one. */
  readonly undoLabel: string | undefined;
  /** The label of the step `redo` would restore. */
  readonly redoLabel: string | undefined;
  /** Drop every snapshot. */
  clear(): void;
}

interface Snapshot<T> {
  data: T;
  text: string;
  label?: string;
}

export function createJournal<T>(store: SaveStore<T>, opts: JournalOptions = {}): Journal {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('journal limit must be ≥ 1');
  const past: Snapshot<T>[] = [];
  const future: Snapshot<T>[] = [];

  // The JSON text of the current data, cached by identity (`set` replaces the reference).
  let cachedRef: T | undefined;
  let cachedText = '';
  const currentText = (): string => {
    const d = store.get();
    if (d !== cachedRef) {
      cachedRef = d;
      cachedText = JSON.stringify(d, saveReplacer);
    }
    return cachedText;
  };
  const snapshot = (label?: string): Snapshot<T> => {
    const text = currentText();
    const snap: Snapshot<T> = { data: structuredClone(store.get()), text };
    if (label !== undefined) snap.label = label;
    return snap;
  };
  const top = (stack: Snapshot<T>[]): Snapshot<T> | undefined => stack[stack.length - 1];
  /** Steps in `stack` not equal to the current data (the top may be a commit of it). */
  const steps = (stack: Snapshot<T>[]): number =>
    stack.length - (stack.length && top(stack)!.text === currentText() ? 1 : 0);
  const trim = () => {
    while (past.length > limit) past.shift();
  };

  /** Move from one stack to the other, with the current data as the return step. */
  const step = (from: Snapshot<T>[], to: Snapshot<T>[]): boolean => {
    const cur = snapshot();
    while (from.length && top(from)!.text === cur.text) {
      // A commit of the current data: carry its label to the return step.
      cur.label = from.pop()!.label;
    }
    const target = from.pop();
    if (!target) return false;
    const toTop = top(to);
    if (toTop && toTop.text === cur.text) toTop.label ??= cur.label;
    else to.push(cur);
    store.set(structuredClone(target.data));
    return true;
  };

  return {
    push(label) {
      const snap = snapshot(label);
      future.length = 0;
      const last = top(past);
      if (last && last.text === snap.text) {
        if (label !== undefined) last.label = label;
        return;
      }
      past.push(snap);
      trim();
    },
    undo: () => step(past, future),
    redo() {
      const ok = step(future, past);
      trim();
      return ok;
    },
    get canUndo() {
      return steps(past) > 0;
    },
    get canRedo() {
      return steps(future) > 0;
    },
    get length() {
      return steps(past);
    },
    get undoLabel() {
      const t = currentText();
      for (let i = past.length - 1; i >= 0; i--) if (past[i]!.text !== t) return past[i]!.label;
      return undefined;
    },
    get redoLabel() {
      const t = currentText();
      for (let i = future.length - 1; i >= 0; i--)
        if (future[i]!.text !== t) return future[i]!.label;
      return undefined;
    },
    clear() {
      past.length = 0;
      future.length = 0;
    },
  };
}
