/**
 * A tiny runtime schema guard for save data. Not a general validation library:
 * just enough to reject corrupt or hand-edited saves before the game sees them.
 *
 * ```ts
 * const Settings = s.object({ volume: s.number({ min: 0, max: 1 }), name: s.optional(s.string()) });
 * type Settings = Infer<typeof Settings>;
 * Settings.validate(json); // null when valid, else "$.volume: expected number ≤ 1"
 * ```
 */

import { TYPED_CTORS, type TypedArrayOf, type TypedKind } from './codec';

export interface Schema<T> {
  /** Returns `null` if `value` matches, else a message naming the first failing path. */
  validate(value: unknown, path?: string): string | null;
  /** Type guard form of `validate`. */
  is(value: unknown): value is T;
  /** Phantom field carrying the inferred type. Never set at runtime. */
  readonly _type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function make<T>(validate: (value: unknown, path: string) => string | null): Schema<T> {
  return {
    validate: (value, path = '$') => validate(value, path),
    is: (value): value is T => validate(value, '$') === null,
  };
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (ArrayBuffer.isView(v)) return v.constructor.name;
  return typeof v;
}

/** `s.number(opts)`: an inclusive range and an integer check. */
export interface NumberOptions {
  min?: number;
  max?: number;
  int?: boolean;
}

/** Optional-key marker used by `s.object`. */
const OPTIONAL = Symbol('optional');
type OptionalSchema<T> = Schema<T | undefined> & { [OPTIONAL]: true };

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { [OPTIONAL]: true } ? K : never;
}[keyof S];
type ObjectOf<S extends Shape> = {
  [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & { [K in OptionalKeys<S>]?: Infer<S[K]> };

export const s = {
  unknown(): Schema<unknown> {
    return make(() => null);
  },

  boolean(): Schema<boolean> {
    return make((v, p) =>
      typeof v === 'boolean' ? null : `${p}: expected boolean, got ${typeName(v)}`,
    );
  },

  string(opts: { maxLength?: number } = {}): Schema<string> {
    return make((v, p) => {
      if (typeof v !== 'string') return `${p}: expected string, got ${typeName(v)}`;
      if (opts.maxLength !== undefined && v.length > opts.maxLength)
        return `${p}: string longer than ${opts.maxLength}`;
      return null;
    });
  },

  number(opts: NumberOptions = {}): Schema<number> {
    return make((v, p) => {
      if (typeof v !== 'number' || !Number.isFinite(v))
        return `${p}: expected finite number, got ${typeName(v)}`;
      if (opts.int && !Number.isInteger(v)) return `${p}: expected integer`;
      if (opts.min !== undefined && v < opts.min) return `${p}: expected number ≥ ${opts.min}`;
      if (opts.max !== undefined && v > opts.max) return `${p}: expected number ≤ ${opts.max}`;
      return null;
    });
  },

  literal<const L extends string | number | boolean | null>(...values: L[]): Schema<L> {
    return make((v, p) =>
      values.includes(v as L) ? null : `${p}: expected one of ${JSON.stringify(values)}`,
    );
  },

  array<T>(item: Schema<T>, opts: { maxLength?: number } = {}): Schema<T[]> {
    return make((v, p) => {
      if (!Array.isArray(v)) return `${p}: expected array, got ${typeName(v)}`;
      if (opts.maxLength !== undefined && v.length > opts.maxLength)
        return `${p}: array longer than ${opts.maxLength}`;
      for (let i = 0; i < v.length; i++) {
        const err = item.validate(v[i], `${p}[${i}]`);
        if (err) return err;
      }
      return null;
    });
  },

  /** String-keyed map with uniform values. */
  record<T>(value: Schema<T>): Schema<Record<string, T>> {
    return make((v, p) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        return `${p}: expected object, got ${typeName(v)}`;
      for (const [k, val] of Object.entries(v)) {
        const err = value.validate(val, `${p}.${k}`);
        if (err) return err;
      }
      return null;
    });
  },

  /** Fixed-shape object. Extra keys are allowed (forward compatibility) unless `strict`. */
  object<S extends Shape>(shape: S, opts: { strict?: boolean } = {}): Schema<ObjectOf<S>> {
    return make((v, p) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        return `${p}: expected object, got ${typeName(v)}`;
      const obj = v as Record<string, unknown>;
      for (const [k, schema] of Object.entries(shape)) {
        const optional = OPTIONAL in schema;
        if (!(k in obj) || obj[k] === undefined) {
          if (optional) continue;
          return `${p}.${k}: missing`;
        }
        const err = schema.validate(obj[k], `${p}.${k}`);
        if (err) return err;
      }
      if (opts.strict) {
        for (const k of Object.keys(obj)) if (!(k in shape)) return `${p}.${k}: unexpected key`;
      }
      return null;
    });
  },

  optional<T>(inner: Schema<T>): OptionalSchema<T> {
    const base = make<T | undefined>((v, p) => (v === undefined ? null : inner.validate(v, p)));
    return Object.assign(base, { [OPTIONAL]: true as const });
  },

  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return make((v, p) => (v === null ? null : inner.validate(v, p)));
  },

  /** A `Uint8Array` (stored as base64url, not a number array). */
  bytes(opts: { maxLength?: number } = {}): Schema<Uint8Array> {
    return make((v, p) => {
      if (!(v instanceof Uint8Array)) return `${p}: expected Uint8Array, got ${typeName(v)}`;
      if (opts.maxLength !== undefined && v.length > opts.maxLength)
        return `${p}: bytes longer than ${opts.maxLength}`;
      return null;
    });
  },

  /** One of the eight typed arrays by kind, e.g. `s.typed('f32')` for a `Float32Array`. */
  typed<K extends TypedKind>(kind: K, opts: { maxLength?: number } = {}): Schema<TypedArrayOf<K>> {
    const Ctor = TYPED_CTORS[kind];
    return make((v, p) => {
      if (!(v instanceof Ctor)) return `${p}: expected ${Ctor.name}, got ${typeName(v)}`;
      const len = (v as ArrayBufferView).byteLength / Ctor.BYTES_PER_ELEMENT;
      if (opts.maxLength !== undefined && len > opts.maxLength)
        return `${p}: typed array longer than ${opts.maxLength}`;
      return null;
    });
  },

  union<T extends Schema<unknown>[]>(...options: T): Schema<Infer<T[number]>> {
    return make((v, p) => {
      const errors: string[] = [];
      for (const o of options) {
        const err = o.validate(v, p);
        if (err === null) return null;
        errors.push(err);
      }
      return errors.join(' | ') || `${p}: no union options`;
    });
  },
};
