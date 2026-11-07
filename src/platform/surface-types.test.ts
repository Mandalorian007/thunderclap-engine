/**
 * ws/platform-surface: `Surface` is an interface, implemented by the DOM class (the value
 * `Surface`), so a game-made surface type-checks with no cast. The type
 * checks run in `pnpm typecheck`; the runtime cases run in plain Node.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type BackbufferSize, computeLetterbox, type Letterbox, type Vec2 } from './letterbox';
import { mountSurface, Surface, type SurfaceSize } from './surface';

/** The smallest surface a game could write: a fixed 320×180 design, no DOM. */
class FixedSurface implements Surface {
  readonly logicalWidth = 320;
  readonly logicalHeight = 180;
  rect: Letterbox = computeLetterbox(640, 360, 320, 180);
  fitRect: Letterbox = this.rect;
  backbuffer: BackbufferSize = { width: 640, height: 360, pixelRatio: 1 };
  get root(): HTMLElement {
    throw new Error('no DOM');
  }
  get canvas(): HTMLCanvasElement {
    throw new Error('no DOM');
  }
  onResize(fn: (size: SurfaceSize) => void): () => void {
    fn({ rect: this.rect, backbuffer: this.backbuffer });
    return () => {};
  }
  clientToLogical(x: number, y: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = x / this.rect.scale;
    out.y = y / this.rect.scale;
    return out;
  }
  logicalToClient(x: number, y: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = x * this.rect.scale;
    out.y = y * this.rect.scale;
    return out;
  }
  containsLogical(p: Vec2): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= 320 && p.y <= 180;
  }
  setFrame(): void {}
  layout(): void {}
  destroy(): void {}
}

/** A consumer typed with the public `Surface`, as `EngineCtx.surface` and `BootResult` are. */
const designSize = (s: Surface): [number, number] => [s.logicalWidth, s.logicalHeight];

describe('Surface interface (ws/platform-surface)', () => {
  it('a game-made class and an object literal are a Surface with no cast', () => {
    const game: Surface = new FixedSurface();
    expect(designSize(game)).toEqual([320, 180]);
    expect(game.clientToLogical(64, 32)).toEqual({ x: 32, y: 16 });
    const literal: Surface = {
      ...new FixedSurface(),
      root: {} as HTMLElement,
      canvas: {} as HTMLCanvasElement,
      onResize: () => () => {},
      clientToLogical: (x, y) => ({ x, y }),
      logicalToClient: (x, y) => ({ x, y }),
      containsLogical: () => true,
      setFrame: () => {},
      layout: () => {},
      destroy: () => {},
    };
    expect(designSize(literal)).toEqual([320, 180]);
  });

  it('the DOM class keeps its type: constructible, and mountSurface returns a Surface', () => {
    expectTypeOf(mountSurface).returns.toEqualTypeOf<Surface>();
    expectTypeOf(Surface).constructorParameters.toEqualTypeOf<
      [root: HTMLElement, opts?: import('./surface').SurfaceOptions]
    >();
    expectTypeOf<InstanceType<typeof Surface>>().toEqualTypeOf<Surface>();
    const probe = (s: Surface) => {
      // @ts-expect-error `logicalWidth` stays readonly, as on 1.0.0's class
      s.logicalWidth = 1;
      // @ts-expect-error `canvas` stays readonly
      s.canvas = {} as HTMLCanvasElement;
    };
    expect(probe).toBeTypeOf('function');
  });

  it('a surface missing a member does not type-check', () => {
    const { destroy: _drop, ...partial } = new FixedSurface();
    // @ts-expect-error `destroy` (and the prototype methods spread drops) are required
    const bad: Surface = partial;
    expect(bad).toBeDefined();
  });

  it('the DOM class can still be extended and narrowed with instanceof', () => {
    class Tinted extends Surface {
      tint = 'red';
    }
    expectTypeOf<Tinted>().toExtend<Surface>();
    const pick = (s: Surface | null) => (s instanceof Surface ? s.logicalWidth : 0);
    expect(pick(null)).toBe(0);
    expect(typeof Surface.prototype.layout).toBe('function');
  });
});
