import type { Camera } from '../render/camera';

/**
 * Scene stack (C7 draft).
 *
 * - Only the top scene receives `update`.
 * - `render(frame, camera, alpha)` hands scenes the camera the game draws with (`ctx.camera` in
 *   `createGame`), so a scene never reaches for `renderer.camera`.
 * - Rendering starts at the highest scene that is not `transparent` and goes up, so a
 *   transparent scene (pause menu, modal) draws over the scene beneath it.
 * - push/pop/replace called during `update` or `render` are deferred until that call returns,
 *   so a scene can safely replace itself mid-update.
 * - Covered scenes get `pause()` and `resume()` when they lose and regain the top.
 */
export interface Scene<Ctx = unknown, Frame = unknown, Cam = Camera> {
  /** Debug name. */
  readonly name?: string;
  /** If true, the scene below keeps rendering underneath this one. */
  readonly transparent?: boolean;
  enter?(ctx: Ctx): void;
  exit?(): void;
  /** Another scene was pushed on top of this one. */
  pause?(): void;
  /** This scene became the top again. */
  resume?(): void;
  update?(dt: number): void;
  /** Record this scene's draws into `frame` as seen by `camera`; `alpha` interpolates between fixed steps. */
  render?(frame: Frame, camera: Cam, alpha: number): void;
}

type Op<C, F, K> = { kind: 'push' | 'replace'; scene: Scene<C, F, K> } | { kind: 'pop' | 'clear' };

export class SceneStack<Ctx = unknown, Frame = unknown, Cam = Camera> {
  private readonly scenes: Scene<Ctx, Frame, Cam>[] = [];
  private readonly pending: Op<Ctx, Frame, Cam>[] = [];
  private busy = 0;

  constructor(private readonly ctx: Ctx) {}

  get size(): number {
    return this.scenes.length;
  }

  get top(): Scene<Ctx, Frame, Cam> | undefined {
    return this.scenes[this.scenes.length - 1];
  }

  /** Snapshot of the stack, bottom first (debugging/tests). */
  list(): readonly Scene<Ctx, Frame, Cam>[] {
    return this.scenes.slice();
  }

  push(scene: Scene<Ctx, Frame, Cam>): void {
    this.queue({ kind: 'push', scene });
  }

  pop(): void {
    this.queue({ kind: 'pop' });
  }

  replace(scene: Scene<Ctx, Frame, Cam>): void {
    this.queue({ kind: 'replace', scene });
  }

  /** Exit every scene, top first. */
  clear(): void {
    this.queue({ kind: 'clear' });
  }

  update(dt: number): void {
    const top = this.top;
    if (!top?.update) return;
    this.busy++;
    try {
      top.update(dt);
    } finally {
      this.busy--;
      this.flush();
    }
  }

  /** Render every visible scene (highest opaque one upward) into `frame` through `camera`. */
  render(frame: Frame, camera: Cam, alpha = 0): void {
    const n = this.scenes.length;
    if (n === 0) return;
    let start = n - 1;
    while (start > 0 && this.scenes[start]!.transparent) start--;
    this.busy++;
    try {
      for (let i = start; i < n; i++) this.scenes[i]!.render?.(frame, camera, alpha);
    } finally {
      this.busy--;
      this.flush();
    }
  }

  private queue(op: Op<Ctx, Frame, Cam>): void {
    this.pending.push(op);
    if (this.busy === 0) this.flush();
  }

  private flush(): void {
    if (this.busy > 0) return;
    while (this.pending.length) {
      const op = this.pending.shift()!;
      this.apply(op);
    }
  }

  private apply(op: Op<Ctx, Frame, Cam>): void {
    switch (op.kind) {
      case 'push': {
        this.top?.pause?.();
        this.scenes.push(op.scene);
        op.scene.enter?.(this.ctx);
        break;
      }
      case 'pop': {
        const s = this.scenes.pop();
        s?.exit?.();
        if (s) this.top?.resume?.();
        break;
      }
      case 'replace': {
        const s = this.scenes.pop();
        s?.exit?.();
        this.scenes.push(op.scene);
        op.scene.enter?.(this.ctx);
        break;
      }
      case 'clear': {
        while (this.scenes.length) this.scenes.pop()!.exit?.();
        break;
      }
    }
  }
}
