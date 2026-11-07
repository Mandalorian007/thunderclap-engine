/**
 * Pipeline variants of one scene-pass drawable, keyed on the pass it draws into
 * (ws/render-10): a variant key (the depth format, or whatever names the drawable's depth
 * state; null without depth) × the target's aux key (`frame.auxKey`, 0..3). A view into a
 * target with other aux attachments than the last one gets its own pipeline, built on first
 * use from `renderer.sceneTargets(blend, aux)`; nothing is rebuilt or allocated after.
 * Internal to the engine's drawables (fx, ui world panel).
 */
export class ScenePipelineCache {
  private readonly rows = new Map<unknown, (GPURenderPipeline | undefined)[]>();

  /** The pipeline stored for (`key`, `aux`), else undefined. */
  get(key: unknown, aux: number): GPURenderPipeline | undefined {
    return this.rows.get(key)?.[aux & 3];
  }

  /** Store `pipeline` for (`key`, `aux`) and return it. */
  set(key: unknown, aux: number, pipeline: GPURenderPipeline): GPURenderPipeline {
    let row = this.rows.get(key);
    if (!row) {
      row = [undefined, undefined, undefined, undefined];
      this.rows.set(key, row);
    }
    row[aux & 3] = pipeline;
    return pipeline;
  }
}

/** `desc` with its fragment colour targets replaced by `targets` (and `label`, `depthStencil`). */
export function sceneVariant(
  desc: GPURenderPipelineDescriptor,
  targets: GPUColorTargetState[],
  label: string | undefined,
  depthStencil: GPUDepthStencilState | undefined,
): GPURenderPipelineDescriptor {
  const out: GPURenderPipelineDescriptor = {
    ...desc,
    label,
    fragment: { ...desc.fragment!, targets },
  };
  if (depthStencil) out.depthStencil = depthStencil;
  return out;
}

/** The label suffix of an aux variant: empty for a plain target (labels stay as before). */
export function auxSuffix(aux: number): string {
  return aux === 0 ? '' : `:aux${aux}`;
}

/**
 * Where a drawable that writes its own motion puts it (ws/render-11): the fragment location of
 * the velocity attachment for aux key `aux` (colour, emissive, rough-metal, velocity), or 0
 * when the target has no velocity attachment (the drawable keeps its masked pipeline).
 */
export function velocityLocation(aux: number): number {
  return aux & 2 ? (aux & 1 ? 3 : 2) : 0;
}

/** Straight-alpha over: a translucent quad's motion is weighted by its coverage. */
const VELOCITY_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/**
 * `targets` (a `renderer.sceneTargets` list) with the velocity entry written instead of masked
 * and blended over what the opaque pass left, by the alpha the fragment writes in `.a` of its
 * `vec4f(velocity, 0, alpha)` output. A copy, built once per pipeline (not per frame).
 */
export function velocityTargets(
  targets: GPUColorTargetState[],
  aux: number,
): GPUColorTargetState[] {
  const at = velocityLocation(aux);
  if (at === 0) return targets;
  const out = targets.slice();
  out[at] = { format: targets[at]!.format, blend: VELOCITY_BLEND };
  return out;
}

/**
 * WGSL: `engine_motion(frag, prev_clip)`, the screen motion since last frame in uv units
 * (+x right, +y down, jitter removed) of a fragment at framebuffer position `frag` whose
 * previous clip position is `prev_clip`; zero when `prev_clip.w <= 0` (unknown). The same
 * formula as the prelude's `engine_velocity`, for drawables built on `WGSL_GLOBALS` (fx
 * billboards and world particles). Needs the `camera` block.
 */
export const WGSL_MOTION = /* wgsl */ `
fn engine_motion(frag: vec4f, prev_clip: vec4f) -> vec2f {
  if (prev_clip.w <= 0.0) { return vec2f(0.0); }
  let cur = (frag.xy - camera.viewport.xy) / camera.viewport.zw - camera.jitter.xy * vec2f(0.5, -0.5);
  let pn = prev_clip.xy / prev_clip.w;
  let prev = vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
  return cur - prev;
}
`;

/**
 * `sceneVariant` for a drawable's motion-writing shader: the same descriptor with `module`
 * (its velocity build) on both stages and `velocityTargets` as the colour targets.
 */
export function motionVariant(
  desc: GPURenderPipelineDescriptor,
  module: GPUShaderModule,
  targets: GPUColorTargetState[],
  aux: number,
  label: string | undefined,
  depthStencil: GPUDepthStencilState | undefined,
): GPURenderPipelineDescriptor {
  const out = sceneVariant(desc, velocityTargets(targets, aux), label, depthStencil);
  out.vertex = { ...desc.vertex, module };
  out.fragment = { ...out.fragment!, module };
  return out;
}
