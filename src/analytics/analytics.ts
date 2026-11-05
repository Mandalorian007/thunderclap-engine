/**
 * Analytics: typed, batched events handed to a sink the game supplies. The engine ships no
 * network sink (VISION rule 4): nothing here calls fetch or sendBeacon.
 */
import type { EventMap } from '../core/events';
import type { EngineCtx, GameHooks, HideReason } from '../core/game';
import type { HostKind } from '../host/types';
import type { EmbedContext } from '../platform/links';
import { classifyFormFactor, type FormFactor } from '../ui/layout';

export type SessionEndReason = HideReason | 'deviceLost';

/** Props of the events the engine emits itself. */
export interface EngineEvents {
  game_start: {
    formFactor: FormFactor;
    deviceKind: HostKind;
    dpr: number;
    viewport: { width: number; height: number };
    embed: EmbedContext;
    /** The build or version string the game passed in `context.build`. */
    build: string | null;
  };
  session_end: { durationMs: number; reason: SessionEndReason };
  device_lost: { reason: string; message: string };
}

/** Values a game may attach to every event (build, channel, experiment arm). */
export type AnalyticsContext = Readonly<Record<string, string | number | boolean>>;

export interface AnalyticsEvent<N extends string = string, P = unknown> {
  readonly name: N;
  readonly props: P;
  /** Random per page load. */
  readonly session: string;
  /** Monotonic per session, from 1. */
  readonly seq: number;
  /** `clock()` at emit, ms. */
  readonly t: number;
  readonly context?: AnalyticsContext;
}

export type AnalyticsSink = (events: AnalyticsEvent[]) => void | Promise<void>;

export interface AnalyticsOptions {
  /** Receives each batch. The game owns delivery (see the README for a sendBeacon sink). */
  sink: AnalyticsSink;
  /** Session id. Default: random. */
  session?: string;
  /** Time source, ms. Default `Date.now`. */
  clock?: () => number;
  /** Attached to every event. `build` also lands in `game_start`. */
  context?: AnalyticsContext;
  /** A sink failure. Never thrown. */
  onError?: (error: unknown) => void;
  /** Flush on its own when this many events are queued. Default 20; 0 disables. */
  maxBatch?: number;
}

type Args<M, K extends keyof M> = M[K] extends undefined ? [props?: M[K]] : [props: M[K]];

export interface Analytics<E extends EventMap = EventMap> {
  readonly session: string;
  /** Events queued and not yet flushed. */
  readonly pending: number;
  emit<K extends keyof (E & EngineEvents) & string>(
    name: K,
    ...props: Args<E & EngineEvents, K>
  ): void;
  /** Hands the queue to the sink. Resolves when the sink does; never rejects. */
  flush(): Promise<void>;
  /**
   * Emits `game_start`, then `session_end` and a flush when the page hides, and `device_lost`
   * when the GPU goes. Wraps `ctx.hooks.hide`, `show` and `deviceLost`, keeping the game's own.
   * Returns detach.
   */
  attach(ctx: AttachTarget): () => void;
}

/** The part of `EngineCtx` `attach` reads. */
export type AttachTarget = Pick<EngineCtx, 'hooks' | 'host'> &
  Partial<Pick<EngineCtx, 'ui' | 'surface'>>;

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function createAnalytics<E extends EventMap = EventMap>(
  opts: AnalyticsOptions,
): Analytics<E> {
  const clock = opts.clock ?? Date.now;
  const session = opts.session ?? randomId();
  const maxBatch = opts.maxBatch ?? 20;
  const report = (e: unknown) => {
    try {
      opts.onError?.(e);
    } catch {
      /* the error handler must not throw either */
    }
  };
  let queue: AnalyticsEvent[] = [];
  let seq = 0;
  let flushing: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (!queue.length) return flushing;
    const batch = queue;
    queue = [];
    // The sink runs now (a page that is hiding may not get another turn).
    let p: Promise<void>;
    try {
      p = Promise.resolve(opts.sink(batch)).catch(report);
    } catch (e) {
      report(e);
      p = Promise.resolve();
    }
    flushing = Promise.all([flushing, p]).then(() => {});
    return flushing;
  };

  const emit = (name: string, props?: unknown) => {
    try {
      queue.push({
        name,
        props: props ?? {},
        session,
        seq: ++seq,
        t: clock(),
        ...(opts.context ? { context: opts.context } : {}),
      });
      if (maxBatch > 0 && queue.length >= maxBatch) void flush();
    } catch (e) {
      report(e);
    }
  };

  const attach = (ctx: AttachTarget): (() => void) => {
    const start = clock();
    const win = typeof window === 'undefined' ? null : window;
    const coarse = !!win?.matchMedia?.('(pointer: coarse)')?.matches;
    const width = win?.innerWidth ?? 0;
    const height = win?.innerHeight ?? 0;
    const formFactor =
      ctx.ui?.layout.formFactor ??
      classifyFormFactor({
        width,
        height,
        coarsePointer: coarse,
        shortSide: Math.min(win?.screen?.width ?? 0, win?.screen?.height ?? 0),
      });
    emit('game_start', {
      formFactor,
      deviceKind: ctx.host.kind,
      dpr: win?.devicePixelRatio ?? 1,
      viewport: { width, height },
      embed: ctx.host.embed,
      build: typeof opts.context?.build === 'string' ? opts.context.build : null,
    });

    // hidden, pagehide and freeze can fire in a row: one session_end per hidden stretch.
    let ended = false;
    const end = (reason: SessionEndReason) => {
      if (ended) return;
      ended = true;
      emit('session_end', { durationMs: clock() - start, reason });
      void flush();
    };
    const hooks = ctx.hooks;
    const prevHide = hooks.hide;
    const prevShow = hooks.show;
    const prevLost = hooks.deviceLost;
    const hide: NonNullable<GameHooks['hide']> = (reason) => {
      end(reason);
      prevHide?.call(hooks, reason);
    };
    const show: NonNullable<GameHooks['show']> = (reason) => {
      ended = false;
      prevShow?.call(hooks, reason);
    };
    const lost = (info: GPUDeviceLostInfo) => {
      emit('device_lost', { reason: String(info.reason), message: String(info.message) });
      end('deviceLost');
      prevLost?.call(hooks, info);
    };
    hooks.hide = hide;
    hooks.show = show;
    hooks.deviceLost = lost;

    return () => {
      // Restore only if nobody wrapped us since; otherwise the chain stays.
      if (hooks.hide === hide) hooks.hide = prevHide;
      if (hooks.show === show) hooks.show = prevShow;
      if (hooks.deviceLost === lost) hooks.deviceLost = prevLost;
    };
  };

  return {
    session,
    get pending() {
      return queue.length;
    },
    emit: emit as Analytics<E>['emit'],
    flush,
    attach,
  };
}
