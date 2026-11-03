/**
 * Offscreen snapshots: a second `Renderer` on the same GPU device that draws one frame into an
 * `OffscreenCanvas` and hands it back as an `ImageBitmap`. Use it to bake still images (icons,
 * thumbnails, previews) with the real materials and post stack, then show them in the DOM.
 *
 * ```ts
 * const shot = new SnapshotRenderer(renderer.device, renderer.format, { width: 512, height: 256 });
 * shot.renderer.post = new PostStack(shot.renderer);            // optional
 * const mat = shot.renderer.createMaterial({ … });              // materials belong to shot.renderer
 * const bmp = shot.capture((frame) => frame.sprite(mat, { x: 128, y: 128, w: 200, h: 200 }));
 * ctx2d.drawImage(bmp, 0, 0, 256, 256, 0, 0, 256, 256);        // slice cells out of the sheet
 * ```
 *
 * The logical space equals the pixel size, so a draw at (x, y) lands on that pixel.
 */
import type { Frame } from './frame';
import { Renderer } from './renderer';

export interface SnapshotOptions {
  /** Output size in pixels (also the logical size). */
  width: number;
  height: number;
}

export class SnapshotRenderer {
  readonly renderer: Renderer;
  readonly width: number;
  readonly height: number;
  private readonly canvas: OffscreenCanvas;
  private readonly context: GPUCanvasContext;

  constructor(device: GPUDevice, format: GPUTextureFormat, opts: SnapshotOptions) {
    this.width = Math.max(1, Math.floor(opts.width));
    this.height = Math.max(1, Math.floor(opts.height));
    this.canvas = new OffscreenCanvas(this.width, this.height);
    const context = this.canvas.getContext('webgpu');
    if (!context) throw new Error('SnapshotRenderer: no webgpu context on OffscreenCanvas');
    context.configure({ device, format, alphaMode: 'opaque' });
    this.context = context;
    this.renderer = new Renderer(
      { device, context, format },
      { logicalWidth: this.width, logicalHeight: this.height, initialInstances: 64 },
    );
    this.renderer.resize(this.width, this.height);
  }

  /**
   * Draw one frame (`draw` records into it) and return the result. `time` feeds
   * `globals.time`, so animated materials can be frozen at a chosen moment.
   */
  capture(draw: (frame: Frame) => void, time = 0): ImageBitmap {
    const frame = this.renderer.beginFrame(time, 1 / 60);
    draw(frame);
    this.renderer.endFrame();
    return this.canvas.transferToImageBitmap();
  }

  destroy(): void {
    this.renderer.destroy();
    this.context.unconfigure();
  }
}
