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
