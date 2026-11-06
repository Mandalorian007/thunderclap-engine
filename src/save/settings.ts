/**
 * A settings store: `createSaveStore` in the `settings` slot, written synchronously, kept apart
 * from progress, with `bind` for wiring menu controls.
 */
import { createSaveStore, type SaveStore, type SaveStoreOptions } from './store';

export interface SettingsStoreOptions<T>
  extends Omit<SaveStoreOptions<T>, 'slot' | 'debounceMs' | 'version' | 'meta'> {
  /** Default `settings`. */
  slot?: string;
  /** Default 1. */
  version?: number;
}

/** A control `bind` can drive: an `<input>`, `<select>`, or any `{ value }` object (tests). */
export type BindTarget =
  | HTMLInputElement
  | HTMLSelectElement
  | {
      value: string;
      checked?: boolean;
      type?: string;
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };

export interface SettingsStore<T> extends SaveStore<T> {
  /**
   * Sets the control from `get()[key]`, writes the control's value to the store on `input` and
   * `change` (coerced to the key's current type: number, boolean or string; a checkbox uses
   * `checked`), and updates the control when the store changes elsewhere. Returns unbind.
   */
  bind<K extends keyof T & string>(input: BindTarget, key: K): () => void;
}

export function createSettingsStore<T>(opts: SettingsStoreOptions<T>): SettingsStore<T> {
  const store = createSaveStore<T>({
    ...opts,
    slot: opts.slot ?? 'settings',
    version: opts.version ?? 1,
    debounceMs: 0,
  });

  const bind = <K extends keyof T & string>(input: BindTarget, key: K): (() => void) => {
    const checkbox = input.type === 'checkbox';
    const read = (): unknown => {
      const current = store.get()[key];
      if (typeof current === 'boolean') return checkbox ? !!input.checked : input.value === 'true';
      if (typeof current === 'number') {
        const n = Number(input.value);
        return Number.isFinite(n) ? n : current;
      }
      return input.value;
    };
    const show = () => {
      const v = store.get()[key];
      if (checkbox) input.checked = !!v;
      else input.value = String(v);
    };
    let writing = false;
    const onInput = () => {
      const next = read();
      if (Object.is(next, store.get()[key])) return;
      writing = true;
      const ok = store.update((d) => {
        (d as Record<string, unknown>)[key] = next;
      });
      writing = false;
      if (!ok) show();
    };
    show();
    input.addEventListener?.('input', onInput);
    input.addEventListener?.('change', onInput);
    const unsubscribe = store.subscribe(() => {
      if (!writing) show();
    });
    return () => {
      input.removeEventListener?.('input', onInput);
      input.removeEventListener?.('change', onInput);
      unsubscribe();
    };
  };

  return Object.assign(store, { bind });
}
