import type { FullscreenPass } from './fullscreen';
import { Texture, type TextureDesc } from './texture';

export interface PingPongStepOptions {
  /** Texture slot of `pass` that reads the previous state. Default 0. */
  slot?: number;
  /** Clear colour for the write target; `null` loads it. Default transparent black. */
  clear?: GPUColor | null;
}

/**
 * Two same-sized render targets for feedback effects (fluid sims, trails, blur chains):
 * each `step` runs a fullscreen pass that reads `read` and writes `write`, then swaps.
 * Alternating textures reuses cached bind groups, so a steady ping-pong allocates nothing.
 *
 * ```ts
 * const sim = renderer.createPingPong({ width: 256, height: 256, label: 'sim' });
 * frame.prePass(stepSim);               // a stable function:
 * function stepSim(enc: GPUCommandEncoder) {
 *   sim.step(enc, simPass);             // simPass samples slot 0 = previous state
 *   material.setTexture(0, sim.read);   // sample the newest state in this frame's draws
 * }
 * ```
 */
export class PingPong {
  private a: Texture;
  private b: Texture;

  constructor(
    private readonly device: GPUDevice,
    private readonly desc: TextureDesc,
  ) {
    this.a = this.make('a');
    this.b = this.make('b');
  }

  /** The latest state (written by the last `step`). Sample this. */
  get read(): Texture {
    return this.a;
  }

  /** The target the next `step` writes. */
  get write(): Texture {
    return this.b;
  }

  get width(): number {
    return this.a.width;
  }

  get height(): number {
    return this.a.height;
  }

  swap(): void {
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  /** Encode `pass` reading `read` (texture `slot`) into `write`, then swap. */
  step(encoder: GPUCommandEncoder, pass: FullscreenPass, opts: PingPongStepOptions = {}): void {
    pass.setTexture(opts.slot ?? 0, this.a);
    pass.encode(encoder, this.b.view, { clear: opts.clear });
    this.swap();
  }

  /** Recreate both targets at a new size (contents are lost). No-op when unchanged. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.a.width && h === this.a.height) return;
    this.destroy();
    this.desc.width = w;
    this.desc.height = h;
    this.a = this.make('a');
    this.b = this.make('b');
  }

  destroy(): void {
    this.a.destroy();
    this.b.destroy();
  }

  private make(which: string): Texture {
    return new Texture(this.device, {
      ...this.desc,
      label: `${this.desc.label ?? 'ping-pong'}:${which}`,
    });
  }
}
