/**
 * Saving, loading and checking bindings maps (ws/input-3). `serializeBindings` writes the map a
 * game got from `Input.bindings()` as JSON; `parseBindings` reads it back against the game's
 * defaults (unknown actions dropped with a warning, missing ones filled in, malformed bindings
 * dropped); `findConflicts` lists inputs bound to more than one action.
 */
import type { Binding, Bindings } from './types';

const GESTURES = new Set(['tap', 'doubleTap', 'longPress', 'pan', 'drag', 'pinch']);
const POINTER_BUTTONS = new Set(['select', 'secondary']);
const XR_BUTTONS = new Set(['trigger', 'squeeze', 'pinch']);
const TRIGGERS = new Set(['press', 'hold', 'doubleTap']);

/** Plain JSON of a bindings map, for saving. */
export function serializeBindings<A extends string>(map: Bindings<A>): string {
  return JSON.stringify(map);
}

/**
 * Read a bindings map saved by `serializeBindings` (text or an already-parsed object). Every
 * action in `defaults` is present in the result: from `text` when it has a well-formed list
 * there, else from `defaults`. Actions not in `defaults` are dropped with one `console.warn`
 * naming them; malformed bindings are dropped the same way. Unparseable text yields `defaults`.
 */
export function parseBindings<A extends string>(
  text: string | unknown,
  defaults: Bindings<A>,
): Bindings<A> {
  let raw: unknown;
  if (typeof text === 'string') {
    try {
      raw = JSON.parse(text);
    } catch {
      console.warn('[input] bindings: not JSON; using defaults');
      return defaults;
    }
  } else raw = text;
  if (!isObject(raw)) {
    console.warn('[input] bindings: not an object; using defaults');
    return defaults;
  }
  const out: Record<string, readonly Binding[]> = {};
  const unknown: string[] = [];
  const malformed: string[] = [];
  for (const action of Object.keys(raw)) {
    if (!(action in defaults)) unknown.push(action);
  }
  for (const action of Object.keys(defaults) as A[]) {
    const list = raw[action];
    if (list === undefined) {
      out[action] = defaults[action];
      continue;
    }
    if (!Array.isArray(list)) {
      malformed.push(action);
      out[action] = defaults[action];
      continue;
    }
    const good: Binding[] = [];
    for (const b of list) {
      if (isBinding(b)) good.push(b);
      else malformed.push(action);
    }
    out[action] = good;
  }
  if (unknown.length)
    console.warn(`[input] bindings: unknown actions dropped: ${unknown.join(', ')}`);
  if (malformed.length) {
    console.warn(
      `[input] bindings: malformed bindings dropped in: ${[...new Set(malformed)].join(', ')}`,
    );
  }
  return out as Bindings<A>;
}

/** One input bound to several actions. */
export interface BindingConflict {
  /** The binding (its first occurrence). */
  binding: Binding;
  /** The actions sharing it, in map order. */
  actions: string[];
}

/**
 * Inputs bound to more than one action. Two bindings conflict when their input and trigger
 * fields are equal (a `hold` and a `press` on the same key do not); chords conflict only with
 * identical chords.
 */
export function findConflicts<A extends string>(map: Bindings<A>): BindingConflict[] {
  const seen = new Map<string, BindingConflict>();
  for (const action of Object.keys(map) as A[]) {
    for (const b of map[action]) {
      const key = canonical(b);
      const c = seen.get(key);
      if (c) {
        if (!c.actions.includes(action)) c.actions.push(action);
      } else seen.set(key, { binding: b, actions: [action] });
    }
  }
  const out: BindingConflict[] = [];
  for (const c of seen.values()) if (c.actions.length > 1) out.push(c);
  return out;
}

/** A stable key for a binding: its fields sorted, defaults made explicit. */
function canonical(b: Binding): string {
  const o: Record<string, unknown> = { ...b };
  if (o.trigger === 'press') delete o.trigger;
  if ('chord' in b) o.chord = b.chord.map(canonical);
  return JSON.stringify(o, Object.keys(o).sort());
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Structural check of one binding (its input shape and optional trigger fields). */
export function isBinding(v: unknown): v is Binding {
  if (!isObject(v)) return false;
  if (v.trigger !== undefined && !TRIGGERS.has(v.trigger as string)) return false;
  if (v.holdMs !== undefined && !isNum(v.holdMs)) return false;
  if (v.doubleTapMs !== undefined && !isNum(v.doubleTapMs)) return false;
  if ('key' in v) return typeof v.key === 'string';
  if ('mouse' in v) return isNum(v.mouse);
  if ('wheel' in v) return v.wheel === 1 || v.wheel === -1;
  if ('padButton' in v) return isNum(v.padButton) && optNum(v.pad) && optNum(v.threshold);
  if ('padAxis' in v) {
    return (
      isNum(v.padAxis) && (v.dir === 1 || v.dir === -1) && optNum(v.pad) && optNum(v.threshold)
    );
  }
  if ('gesture' in v) return GESTURES.has(v.gesture as string);
  if ('pointer' in v) return POINTER_BUTTONS.has(v.pointer as string);
  if ('xr' in v) {
    return (
      XR_BUTTONS.has(v.xr as string) &&
      (v.hand === undefined || v.hand === 'left' || v.hand === 'right')
    );
  }
  if ('chord' in v) return Array.isArray(v.chord) && v.chord.every(isBinding);
  return false;
}

function optNum(v: unknown): boolean {
  return v === undefined || isNum(v);
}
