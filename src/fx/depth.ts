import { createShaderModule } from '../render/wgsl';

/**
 * ws/fx-fit: the depth convention for fx shaders. A core pass is standard (near 0, far 1) or
 * reversed-Z (near 1, far 0; `CorePass.reversedZ`, `RenderCoreOptions.reversedZ`). The fx
 * drawables read it from the pass (`CoreDrawContext.reversedZ`, `CorePassContext.reversedZ`):
 * their pipelines test depth with `coreDepthCompare(reversedZ, true)` (ws/render-fit), and their WGSL, which starts from
 * `FX_DEPTH_WGSL`'s standard form, is compiled once more for a reversed pass with
 * `fxDepthCode(code, true)`. A game never sets it per drawable.
 */

/** The line `fxDepthCode` swaps. */
const STANDARD = 'const FX_REVERSED_Z = false;';
const REVERSED = 'const FX_REVERSED_Z = true;';

/**
 * WGSL depth helpers in the standard convention: `FX_REVERSED_Z`, `fx_depth_far()` (the far
 * plane's depth: 1, or 0 reversed), `fx_depth_is_far(d)` (a depth texel with nothing drawn
 * on it) and `fx_depth_nearer(a, b)` (depth `a` is nearer the eye than `b`).
 */
export const FX_DEPTH_WGSL = /* wgsl */ `
${STANDARD}
fn fx_depth_far() -> f32 { return select(1.0, 0.0, FX_REVERSED_Z); }
fn fx_depth_is_far(d: f32) -> bool { return select((d >= 1.0), (d <= 0.0), FX_REVERSED_Z); }
fn fx_depth_nearer(a: f32, b: f32) -> bool { return select((a < b), (a > b), FX_REVERSED_Z); }
`;

/** `code` (holding `FX_DEPTH_WGSL`) for a pass of the given convention. */
export function fxDepthCode(code: string, reversedZ: boolean): string {
  if (!reversedZ) return code;
  if (!code.includes(STANDARD)) throw new Error('fxDepthCode: the code has no FX_DEPTH_WGSL');
  return code.replace(STANDARD, REVERSED);
}

/**
 * A shader module per depth convention, made on first use: the standard one, and the
 * reversed-Z one only once a reversed pass draws.
 */
export class FxDepthModules {
  private standard: GPUShaderModule | null = null;
  private reversed: GPUShaderModule | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly code: string,
    private readonly label: string,
  ) {}

  get(reversedZ: boolean): GPUShaderModule {
    if (reversedZ) {
      this.reversed ??= createShaderModule(
        this.device,
        fxDepthCode(this.code, true),
        `${this.label} (reversed-Z)`,
      );
      return this.reversed;
    }
    this.standard ??= createShaderModule(this.device, this.code, this.label);
    return this.standard;
  }
}
