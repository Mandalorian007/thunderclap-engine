import type { RenderView } from './view';

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
  /**
   * Work of the pass's own, encoded per view after its sets (ws/core-passes): a full-screen
   * draw such as the sky. A pass with `encode` runs even when no set joined it, and gets the
   * depth attachment unless its `depth` is `'none'`. It must not allocate.
   */
  encode?: (pass: GPURenderPassEncoder, ctx: CorePassContext) => void;
  /**
   * A resolve pass (ws/core-passes): instead of a render pass, encoded per view on the frame's
   * command encoder when the target has an `output`: post-processing from the target into
   * `CoreTarget.output`. Passes after it draw into the output, without depth. No sets join it.
   * It must not allocate.
   */
  resolve?: (encoder: GPUCommandEncoder, ctx: CoreResolveContext) => void;
  /**
   * Reversed-Z (ws/render-fit): depth is cleared to 0, not 1, when this pass clears it, and its
   * sets' depth test defaults to `'greater'` (`DrawSetShader.depthCompare`). Default: the
   * core's `RenderCoreOptions.reversedZ`.
   */
  reversedZ?: boolean;
  /**
   * The value depth is cleared to when this pass is the view's first depth pass (ws/render-fit).
   * Default 0 with `reversedZ`, else 1.
   */
  depthClear?: number;
}

/**
 * What a resolve pass gets for the view being drawn. One object, rewritten per call: read it
 * inside `resolve`, do not keep it.
 */
export interface CoreResolveContext {
  /** The view of the last `prepare` being drawn. */
  viewIndex: number;
  /** That view (its matrices: `viewProj`, `proj`, `view`, `position`). */
  view: RenderView;
  /** The target drawn so far: `CoreTarget.view`, its texture when given, format and size. */
  color: GPUTextureView;
  colorTexture: GPUTexture | undefined;
  format: GPUTextureFormat;
  width: number;
  height: number;
  /** The view's rectangle of the target (`CoreTarget.viewport`), else undefined. */
  viewport: { x: number; y: number; width: number; height: number } | undefined;
  /**
   * The view's depth when something wrote it (the target's own or the core's, sampleable as
   * `texture_depth_2d`), else null.
   */
  depth: GPUTextureView | null;
  /** Where to write: `CoreTarget.output`, its format and rectangle. */
  output: GPUTextureView;
  outputFormat: GPUTextureFormat;
  outputViewport: { x: number; y: number; width: number; height: number } | undefined;
  /**
   * The view's extra targets as drawn so far (ws/core-targets; `RenderCore.targetMask`), the
   * target's size: null for one the core does not have.
   */
  emissive: GPUTextureView | null;
  roughMetal: GPUTextureView | null;
  velocity: GPUTextureView | null;
}

/**
 * What a pass's `encode` gets for the view being drawn. One object, rewritten per call: read it
 * inside `encode`, do not keep it.
 */
export interface CorePassContext {
  /** The view of the last `prepare` being drawn. */
  viewIndex: number;
  /** The core's view bind group for it: `CORE_VIEW_WGSL`'s `CoreView` at binding 0. */
  view: GPUBindGroup;
  /** The layout of `view`, for the pass's pipeline layout (group 0). */
  viewLayout: GPUBindGroupLayout;
  /** The colour target's format. */
  format: GPUTextureFormat;
  /** The depth attachment's format, or undefined when the pass has none. */
  depthFormat: GPUTextureFormat | undefined;
  /** The depth attachment is read-only in this pass (a `'read'` pass after a writing one). */
  depthReadOnly: boolean;
  /**
   * The pass's extra targets (ws/core-targets), a `CORE_TARGET` mask: build the pipeline's
   * targets with `coreColorTargets(color, aux, writes)`. 0 after a resolve.
   */
  aux: number;
}

/** A pass in the list; draw sets join it by id. */
export interface CorePass {
  readonly id: string;
  /** `'core <id>'`: the pass's render pass label (ws/render-fit). */
  readonly label: string;
  readonly depth: PassDepth;
  /** Reversed-Z (`PassDesc.reversedZ`). */
  readonly reversedZ: boolean;
  /** What a first depth pass clears depth to (`PassDesc.depthClear`). */
  readonly depthClear: number;
  readonly when: (() => boolean) | null;
  readonly encode: ((pass: GPURenderPassEncoder, ctx: CorePassContext) => void) | null;
  readonly resolve: ((encoder: GPUCommandEncoder, ctx: CoreResolveContext) => void) | null;
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

  /** The default of `PassDesc.reversedZ` for passes defined on this list. */
  readonly reversedZ: boolean;

  constructor(builtIn: readonly PassDesc[] = CORE_PASSES, reversedZ = false) {
    this.reversedZ = reversedZ;
    for (const p of builtIn) this.define(p);
  }

  /** Add a pass after `desc.after` (or at the end). Throws on a duplicate id or unknown `after`. */
  define(desc: PassDesc): CorePass {
    if (this.get(desc.id)) throw new Error(`pass ${desc.id} is already defined`);
    const reversedZ = desc.reversedZ ?? this.reversedZ;
    const pass: CorePass = {
      id: desc.id,
      label: `core ${desc.id}`,
      depth: desc.depth ?? 'write',
      reversedZ,
      depthClear: desc.depthClear ?? (reversedZ ? 0 : 1),
      when: desc.when ?? null,
      encode: desc.encode ?? null,
      resolve: desc.resolve ?? null,
    };
    if (pass.encode && pass.resolve)
      throw new Error(`pass ${desc.id}: encode or resolve, not both`);
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
