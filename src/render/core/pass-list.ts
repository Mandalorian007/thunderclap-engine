/**
 * The pass list (D1 §3.6): named passes in a declared order, not a graph. Each pass encodes only
 * when its `when` holds and something joined it, and the depth attachment exists only when a
 * pass that runs has a set that tests depth (D1 §3.7, "targets from use").
 */

/** How a pass uses depth: writes it, tests against it without writing, or has none. */
export type PassDepth = 'write' | 'read' | 'none';

export interface PassDesc {
  id: string;
  /** Insert after this pass (default: at the end). */
  after?: string;
  /** Default `'write'`. */
  depth?: PassDepth;
  /** Checked each view; the pass is skipped when it returns false. */
  when?: () => boolean;
}

/** A pass in the list; draw sets join it by id. */
export interface CorePass {
  readonly id: string;
  readonly depth: PassDepth;
  readonly when: (() => boolean) | null;
}

/**
 * The view passes built in, in order. `shadow` is not a view pass and arrives with the shadow
 * work; `depthPre` is there for sets that want a depth-only prepass.
 */
export const CORE_PASSES: readonly PassDesc[] = [
  { id: 'depthPre', depth: 'write' },
  { id: 'opaque', depth: 'write' },
  { id: 'cutout', depth: 'write' },
  { id: 'transparent', depth: 'read' },
  { id: 'overlay', depth: 'none' },
];

/** The ordered list of view passes. */
export class PassList {
  /** Passes in encode order. */
  readonly passes: CorePass[] = [];
  private readonly after = new Map<CorePass, string>();

  constructor(builtIn: readonly PassDesc[] = CORE_PASSES) {
    for (const p of builtIn) this.define(p);
  }

  /** Add a pass after `desc.after` (or at the end). Throws on a duplicate id or unknown `after`. */
  define(desc: PassDesc): CorePass {
    if (this.get(desc.id)) throw new Error(`pass ${desc.id} is already defined`);
    const pass: CorePass = { id: desc.id, depth: desc.depth ?? 'write', when: desc.when ?? null };
    if (desc.after === undefined) {
      this.passes.push(pass);
    } else {
      const i = this.passes.findIndex((p) => p.id === desc.after);
      if (i < 0) throw new Error(`pass ${desc.id}: no pass ${desc.after} to follow`);
      // After `after` and after anything already inserted after it, so definitions keep order.
      let at = i + 1;
      while (at < this.passes.length && this.after.get(this.passes[at]!) === desc.after) at++;
      this.passes.splice(at, 0, pass);
      this.after.set(pass, desc.after);
    }
    return pass;
  }

  get(id: string): CorePass | undefined {
    return this.passes.find((p) => p.id === id);
  }

  /** Pass ids in encode order. */
  get order(): string[] {
    return this.passes.map((p) => p.id);
  }
}
