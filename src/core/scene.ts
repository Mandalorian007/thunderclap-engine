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
 * - Preload (ws/core-2): a pushed or replacing scene with `preload(ctx)` is awaited before it
 *   enters; until then the stack is unchanged, so the old top keeps updating and rendering, and
 *   `transitioning` is true. Later stack ops wait behind it, in order. `push` and `replace`
 *   return a promise that resolves once the scene has entered (a scene without `preload` enters
 *   at once, or when the current `update`/`render` returns, and its promise resolves on the next
 *   microtask). A rejected `preload` rejects that promise and leaves the stack as it was.
 * - `onTransition(fn)` reports `'preload'` (before `preload` starts), `'exit'` (after a scene's
 *   `exit`, with the scene it gives way to) and `'enter'` (after a scene's `enter`, with the scene
 *   it covered or replaced), so a game drives a loading screen or a fade from one hook.
 */
export interface Scene<Ctx = unknown, Frame = unknown, Cam = Camera> {
  /** Debug name. */
  readonly name?: string;
  /** If true, the scene below keeps rendering underneath this one. */
  readonly transparent?: boolean;
  /**
   * Load what the scene needs before it enters; awaited by `push`/`replace` while the previous
   * top keeps running. A rejection cancels the push and leaves the stack unchanged.
   */
  preload?(ctx: Ctx): Promise<void>;
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

export type TransitionPhase = 'preload' | 'enter' | 'exit';

/** `from` is the scene leaving or being covered, `to` the one arriving or revealed (or undefined). */
export type TransitionListener<Ctx = unknown, Frame = unknown, Cam = Camera> = (
  from: Scene<Ctx, Frame, Cam> | undefined,
  to: Scene<Ctx, Frame, Cam> | undefined,
  phase: TransitionPhase,
) => void;

interface Op<C, F, K> {
  kind: 'push' | 'replace' | 'pop' | 'clear';
  scene: Scene<C, F, K> | null;
  /** The preload finished; apply without loading again. */
  loaded: boolean;
  promise: Promise<void> | null;
  resolve: (() => void) | null;
  reject: ((err: unknown) => void) | null;
}

const noop = () => {};

export class SceneStack<Ctx = unknown, Frame = unknown, Cam = Camera> {
  private readonly items: Scene<Ctx, Frame, Cam>[] = [];
  private readonly pending: Op<Ctx, Frame, Cam>[] = [];
  private busy = 0;
  /** The op whose scene is preloading; the queue waits behind it. */
  private loading: Op<Ctx, Frame, Cam> | null = null;
  private listeners: TransitionListener<Ctx, Frame, Cam>[] = [];

  constructor(private readonly ctx: Ctx) {}

  get size(): number {
    return this.items.length;
  }

  get top(): Scene<Ctx, Frame, Cam> | undefined {
    return this.items[this.items.length - 1];
  }

  /** True while a pushed or replacing scene's `preload` is pending. */
  get transitioning(): boolean {
    return this.loading !== null;
  }

  /** The scenes on the stack, bottom first: the live array (read it, copy it to keep it). */
  get scenes(): readonly Scene<Ctx, Frame, Cam>[] {
    return this.items;
  }

  /** @deprecated (ws/api-core, E-036) Read `scenes` (this returns a copy). Removed next minor. */
  list(): readonly Scene<Ctx, Frame, Cam>[] {
    return this.items.slice();
  }

  /** Push `scene` (after its `preload`, if any); resolves once it has entered. */
  push(scene: Scene<Ctx, Frame, Cam>): Promise<void> {
    return this.queueScene('push', scene);
  }

  pop(): void {
    this.queue(bare('pop'));
  }

  /** Replace the top with `scene` (after its `preload`, if any); resolves once it has entered. */
  replace(scene: Scene<Ctx, Frame, Cam>): Promise<void> {
    return this.queueScene('replace', scene);
  }

  /** Exit every scene, top first. */
  clear(): void {
    this.queue(bare('clear'));
  }

  /** Observe transitions; returns the unsubscribe function. Listeners are copy-on-write. */
  onTransition(fn: TransitionListener<Ctx, Frame, Cam>): () => void {
    this.listeners = [...this.listeners, fn];
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
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
    const n = this.items.length;
    if (n === 0) return;
    let start = n - 1;
    while (start > 0 && this.items[start]!.transparent) start--;
    this.busy++;
    try {
      for (let i = start; i < n; i++) this.items[i]!.render?.(frame, camera, alpha);
    } finally {
      this.busy--;
      this.flush();
    }
  }

  private queueScene(kind: 'push' | 'replace', scene: Scene<Ctx, Frame, Cam>): Promise<void> {
    const op: Op<Ctx, Frame, Cam> = {
      kind,
      scene,
      loaded: false,
      promise: null,
      resolve: null,
      reject: null,
    };
    op.promise = new Promise<void>((resolve, reject) => {
      op.resolve = resolve;
      op.reject = reject;
    });
    // Outside the executor, so a throwing `enter` still throws out of `push`, as before.
    this.queue(op);
    return op.promise;
  }

  private queue(op: Op<Ctx, Frame, Cam>): void {
    this.pending.push(op);
    if (this.busy === 0) this.flush();
  }

  private flush(): void {
    while (this.busy === 0 && this.loading === null && this.pending.length > 0) {
      const op = this.pending.shift()!;
      const scene = op.scene;
      if (!op.loaded && scene?.preload) {
        this.startPreload(op, scene);
        continue;
      }
      try {
        this.apply(op);
      } catch (err) {
        // The error throws out of the call that applied the op; the promise rejects too, marked
        // handled so a caller that ignored it is not told twice.
        op.promise?.catch(noop);
        op.reject?.(err);
        throw err;
      }
      op.resolve?.();
    }
  }

  private startPreload(op: Op<Ctx, Frame, Cam>, scene: Scene<Ctx, Frame, Cam>): void {
    this.loading = op;
    this.emit(this.top, scene, 'preload');
    let p: Promise<void>;
    try {
      p = Promise.resolve(scene.preload!(this.ctx));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      () => {
        this.loading = null;
        op.loaded = true;
        this.pending.unshift(op);
        if (this.busy === 0) this.flush();
      },
      (err: unknown) => {
        this.loading = null;
        op.reject?.(err);
        if (this.busy === 0) this.flush();
      },
    );
  }

  private emit(
    from: Scene<Ctx, Frame, Cam> | undefined,
    to: Scene<Ctx, Frame, Cam> | undefined,
    phase: TransitionPhase,
  ): void {
    const ls = this.listeners;
    for (let i = 0; i < ls.length; i++) ls[i]!(from, to, phase);
  }

  private apply(op: Op<Ctx, Frame, Cam>): void {
    switch (op.kind) {
      case 'push': {
        const scene = op.scene!;
        const below = this.top;
        below?.pause?.();
        this.items.push(scene);
        scene.enter?.(this.ctx);
        this.emit(below, scene, 'enter');
        break;
      }
      case 'pop': {
        const s = this.items.pop();
        s?.exit?.();
        if (s) {
          this.top?.resume?.();
          this.emit(s, this.top, 'exit');
        }
        break;
      }
      case 'replace': {
        const scene = op.scene!;
        const s = this.items.pop();
        s?.exit?.();
        if (s) this.emit(s, scene, 'exit');
        this.items.push(scene);
        scene.enter?.(this.ctx);
        this.emit(s, scene, 'enter');
        break;
      }
      case 'clear': {
        while (this.items.length) {
          const s = this.items.pop()!;
          s.exit?.();
          this.emit(s, this.top, 'exit');
        }
        break;
      }
    }
  }
}

function bare<C, F, K>(kind: 'pop' | 'clear'): Op<C, F, K> {
  return { kind, scene: null, loaded: false, promise: null, resolve: null, reject: null };
}
