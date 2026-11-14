/**
 * A panel's model (ws/ui-spec, from Forge Wilds' `ui/spec/model.ts`): the keyed values its words
 * bind (`b`), a dirty set, and a relayout flag. Game code sets values; a set that changes nothing
 * is a compare and nothing more. A presenter reads what changed once a frame and writes only the
 * words bound to it (the key-to-words index is the compiled spec's).
 *
 * A list's rows are held by row key (`SpecRow`): each row's values live on its own row, found by
 * the row key the game already holds, so a list that resorts touches no row's values, and no key
 * is ever built from a template string. After warm-up (every key and row seen once) sets
 * allocate nothing.
 */

import { maxRowsAt } from './boxes';
import type { CompiledSpec } from './compile';

/** A model value. */
export type SpecValue = string | number | boolean;

/** One row of a list: its values by field, held under its row key. */
export class SpecRow {
  readonly key: string;
  /** Its values, by the list's field index (null until set). */
  readonly vals: (SpecValue | null)[];
  /** Which fields changed (a bit each) since the presenters last drew. */
  dirty = 0;
  /** Its place in the list now (-1: not in it). */
  index = -1;
  /** The list's generation it was last listed in. */
  gen = 0;
  /** In the list's dirty rows. */
  queued = false;
  private readonly list: SpecListState;

  constructor(list: SpecListState, key: string) {
    this.list = list;
    this.key = key;
    this.vals = new Array<SpecValue | null>(list.fields.length).fill(null);
  }

  /** Sets field `field` (a `b("row.<field>")` of the list's row). */
  set(field: string, v: SpecValue): boolean {
    const i = this.list.fieldIndex.get(field);
    if (i === undefined) throw new Error(`no field ${field} in list ${this.list.id}`);
    return this.setAt(i, v);
  }

  /** Sets field number `i` (`SpecListState.fieldIndex`). */
  setAt(i: number, v: SpecValue): boolean {
    if (this.vals[i] === v) return false;
    this.vals[i] = v;
    this.dirty |= 1 << i;
    this.list.rowChanged(this);
    return true;
  }

  /** Field `field`'s value. */
  get(field: string): SpecValue | null {
    const i = this.list.fieldIndex.get(field);
    return i === undefined ? null : (this.vals[i] ?? null);
  }
}

/** How a list's scroll follows a change of its keys (`SpecListState.how`). */
export type SpecListMove = 'keep' | 'top' | 'slide';

/** A list's keys and rows. */
export class SpecListState {
  readonly id: string;
  /** The list's node (layout.ts). */
  readonly node: number;
  /** Its rows' fields, and each one's index. */
  readonly fields: readonly string[];
  readonly fieldIndex: ReadonlyMap<string, number>;
  /** Its row keys, in order. */
  readonly keys: string[] = [];
  /** Every listed row, by key. */
  readonly rows = new Map<string, SpecRow>();
  /** Rows whose values changed since the presenters drew (the first `dirtyN`). */
  readonly dirtyRows: SpecRow[] = [];
  dirtyN = 0;
  /** The keys (their order or number) changed since the presenters drew. */
  order = false;
  /** Bumped by each change of keys (rows not listed in the last one are dropped). */
  gen = 0;
  /**
   * How the scroll follows the last change of keys, until the presenters
   * draw it: "keep" (where it was), "top" (back to the top: a new search),
   * or "slide" (the row that was first in view stays where it was on the
   * screen, the rows around it slide: a resort under a finger).
   */
  how: SpecListMove = 'keep';
  private readonly model: SpecModel;
  private readonly prune = (row: SpecRow, key: string): void => {
    if (row.gen !== this.gen) {
      row.index = -1;
      this.rows.delete(key);
      this.removed.push(row);
    }
  };
  /** Rows dropped since the presenters drew: their pooled rows are free again. */
  readonly removed: SpecRow[] = [];

  /** How many rows high it stands for a count (-1: a fixed height, or a tabs' fixed width: a count never moves a box). */
  private readonly tall: (count: number) => number;

  constructor(
    model: SpecModel,
    id: string,
    node: number,
    fields: readonly string[],
    tall: (count: number) => number,
  ) {
    this.model = model;
    this.id = id;
    this.node = node;
    this.fields = fields;
    this.tall = tall;
    const index = new Map<string, number>();
    for (let i = 0; i < fields.length; i++) index.set(fields[i]!, i);
    this.fieldIndex = index;
  }

  /** SpecRow `key` (made on first use: a row may be filled before it is listed). */
  row(key: string): SpecRow {
    let r = this.rows.get(key);
    if (!r) {
      r = new SpecRow(this, key);
      this.rows.set(key, r);
    }
    return r;
  }

  /** The list is `keys` now (false: it already was), its scroll following as `how` says. */
  set(keys: readonly string[], how: SpecListMove = 'keep'): boolean {
    const held = this.keys;
    const n = keys.length;
    if (held.length === n) {
      let same = true;
      for (let i = 0; i < n; i++) {
        if (held[i] !== keys[i]) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    // A list as tall as its rows (up to its maxRows), or tabs as wide as their options: the boxes move.
    if (held.length !== n && this.tall(held.length) !== this.tall(n)) this.model.relayout = true;
    this.gen++;
    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      held[i] = k;
      const r = this.row(k);
      r.gen = this.gen;
      r.index = i;
    }
    held.length = n;
    this.rows.forEach(this.prune);
    // Two changes before a draw: a move to the top wins, then a slide.
    if (how === 'top' || (how === 'slide' && this.how === 'keep')) this.how = how;
    this.order = true;
    this.model.changed();
    return true;
  }

  /** @internal A row's values changed. */
  rowChanged(r: SpecRow): void {
    if (!r.queued) {
      r.queued = true;
      this.dirtyRows[this.dirtyN++] = r;
    }
    this.model.changed();
  }

  /** @internal After the presenters drew. */
  clean(): void {
    for (let i = 0; i < this.dirtyN; i++) {
      const r = this.dirtyRows[i]!;
      r.dirty = 0;
      r.queued = false;
    }
    this.dirtyN = 0;
    this.order = false;
    this.how = 'keep';
    this.removed.length = 0;
  }
}

/** A panel's keyed values. */
export class SpecModel {
  readonly spec: CompiledSpec;
  /** Each key's value, by the compiled spec's key index (null until set). */
  readonly vals: (SpecValue | null)[];
  /** Keys changed since the presenters drew: the first `dirtyN`. */
  readonly dirtyKeys: Int32Array;
  dirtyN = 0;
  private readonly marked: Uint8Array;
  /** A change that moves boxes (a `show`, a list's length): the layout runs again before drawing. */
  relayout = false;
  /** The lists, in the compiled spec's list order. */
  readonly lists: SpecListState[] = [];
  private readonly byList = new Map<string, SpecListState>();
  /** Something changed since the presenters drew. */
  pending = false;
  /** Called when the model first changes after the presenters drew (a host schedules a frame). */
  onChange: (() => void) | null = null;
  /** Sets made (changed or not), for the budgets. */
  sets = 0;
  /**
   * A focus asked for, drawn at the next apply: a field's id (its cursor
   * goes there), null (the keyboard goes away: no field keeps focus), or
   * undefined (none asked).
   */
  focusing: string | null | undefined = undefined;
  /** Told of each `follow` (a field typed in on one surface: the other presenters show it too). */
  readonly followers: ((i: number, v: SpecValue) => void)[] = [];

  constructor(spec: CompiledSpec) {
    this.spec = spec;
    this.vals = new Array<SpecValue | null>(spec.keys.length).fill(null);
    this.dirtyKeys = new Int32Array(spec.keys.length);
    this.marked = new Uint8Array(spec.keys.length);
    for (let i = 0; i < spec.listNodes.length; i++) {
      const node = spec.listNodes[i]!;
      const def = spec.nodes[node]!;
      // A list of fixed height (or growing into what its stack leaves), or tabs of fixed width: a count never moves a box.
      const fixed =
        def.k === 'list'
          ? !Number.isNaN(spec.fh[node]) || spec.grow[node]! > 0
          : !Number.isNaN(spec.fw[node]);
      const cols = def.k === 'list' ? (def.cols ?? 1) : 1;
      // Its maxRows now (a bound one is read at each change of keys: a change of it lays out again by itself).
      const tall = fixed
        ? (): number => -1
        : def.k === 'list'
          ? (count: number): number =>
              Math.min(maxRowsAt(spec, this, node), Math.ceil(count / cols))
          : (count: number): number => count;

      const l = new SpecListState(this, spec.listIds[i]!, node, spec.fields[i]!, tall);
      this.lists.push(l);
      this.byList.set(l.id, l);
    }
  }

  /** Key `key`'s index (throws on a key no word binds: a typo). */
  index(key: string): number {
    const i = this.spec.keyIndex.get(key);
    if (i === undefined) throw new Error(`no key ${key} in panel ${this.spec.id}`);
    return i;
  }

  /** Sets key `key` (false: it already was `v`). */
  set(key: string, v: SpecValue): boolean {
    return this.setAt(this.index(key), v);
  }

  /** Sets key number `i` (`index`). */
  setAt(i: number, v: SpecValue): boolean {
    this.sets++;
    if (this.vals[i] === v) return false;
    this.vals[i] = v;
    if (this.marked[i] === 0) {
      this.marked[i] = 1;
      this.dirtyKeys[this.dirtyN++] = i;
    }
    if (this.spec.keyLayout[i] === 1) this.relayout = true;
    this.changed();
    return true;
  }

  /**
   * Key number `i` is `v` already, on the page (a field the player typed
   * in): the model's copy follows it without a write, so a later set of
   * "" from the game clears it.
   */
  follow(i: number, v: SpecValue): void {
    this.vals[i] = v;
    for (let f = 0; f < this.followers.length; f++) this.followers[f]!(i, v);
  }

  /** Puts the cursor in field `id` (null: in no field, the keyboard away) at the next apply. */
  focus(id: string | null): void {
    this.focusing = id;
    this.changed();
  }

  /** Sets every key of `rec` (a record from a pure function of the game's state): returns how many changed. */
  setAll(rec: Readonly<Record<string, SpecValue>>): number {
    let n = 0;
    for (const k in rec) if (this.set(k, rec[k]!)) n++;
    return n;
  }

  /** Key `key`'s value (null until set). */
  get(key: string): SpecValue | null {
    return this.vals[this.index(key)] ?? null;
  }

  /** List `id`'s state. */
  list(id: string): SpecListState {
    const l = this.byList.get(id);
    if (!l) throw new Error(`no list ${id} in panel ${this.spec.id}`);
    return l;
  }

  /** List `id` is `keys` now, in order (false: it already was). */
  setList(id: string, keys: readonly string[], how: SpecListMove = 'keep'): boolean {
    return this.list(id).set(keys, how);
  }

  /** List `id`'s row `key`. */
  row(id: string, key: string): SpecRow {
    return this.list(id).row(key);
  }

  /** @internal Something changed. */
  changed(): void {
    if (this.pending) return;
    this.pending = true;
    this.onChange?.();
  }

  /** After the presenters drew: nothing is dirty. */
  clean(): void {
    for (let i = 0; i < this.dirtyN; i++) this.marked[this.dirtyKeys[i]!] = 0;
    this.dirtyN = 0;
    for (let i = 0; i < this.lists.length; i++) this.lists[i]!.clean();
    this.relayout = false;
    this.focusing = undefined;
    this.pending = false;
  }
}
