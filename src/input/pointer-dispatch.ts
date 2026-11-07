/**
 * The pointer dispatcher (ws/input-4): one set of DOM pointer listeners per target, one
 * `pointerType` parse, one pointer capture, fanned out to every consumer in priority order.
 * `Input.attach` builds one and hands it to its linked `Gestures`, `Look`, `PointerRouter` and
 * touch zones; each of those attached on its own builds a private one. A consumer may `claim` a
 * pointer: from then until it lifts the pointer reaches only its owner (and the consumers added
 * with `seesClaimed`, the feed and the router's screen source), so two thumbs in two touch zones
 * never pinch and an orbit drag never pans.
 */
import type { PointerTransform } from './types';

/** The device a DOM pointer event came from (`pointerType`, anything unknown read as mouse). */
export type PointerRecordDevice = 'mouse' | 'touch' | 'pen';

/**
 * One pointer event as the dispatcher delivers it. The dispatcher owns the object and reuses it:
 * read it in the consumer, copy what you keep.
 */
export interface PointerRecord {
  /** `PointerEvent.pointerId`. */
  id: number;
  device: PointerRecordDevice;
  /** `PointerEvent.button` clamped to 0 or more (0 primary, 1 middle, 2 secondary). */
  button: number;
  /** `PointerEvent.isPrimary`. */
  primary: boolean;
  /**
   * Feed coordinates: client CSS px when the dispatcher has a transform (the transform maps
   * them), else px relative to the target's top-left.
   */
  x: number;
  y: number;
  /** Raw `clientX`/`clientY`. */
  clientX: number;
  clientY: number;
  /**
   * `Event.timeStamp`: when the event happened, ms on the `performance.now()` clock (not when the
   * page got round to handling it). `eventTime` maps it onto another clock.
   */
  time: number;
  /** False when the transform maps the point outside the game (true without a transform). */
  inside: boolean;
}

/** Something the dispatcher delivers to. Every method is optional. */
export interface PointerConsumer {
  pointerDown?(p: PointerRecord): void;
  pointerMove?(p: PointerRecord): void;
  pointerUp?(p: PointerRecord): void;
  /** The browser took the pointer (`pointercancel`). */
  pointerCancel?(p: PointerRecord): void;
  /** A hovering pointer left the target (`pointerleave`). */
  pointerLeave?(p: PointerRecord): void;
  /** Window blur or a hidden tab: drop every pointer. */
  cancelAll?(): void;
}

export interface PointerDispatcherOptions {
  /** The client → game-space mapping; sets how `PointerRecord.x`/`y` are made. `null` = none. */
  transform?: PointerTransform | null;
  /**
   * When true a claimed pointer still hovers through the router's screen source (it produces
   * hits and `hit`/`hitEnd` but no select). Default false: a claimed pointer is hidden from the
   * router until it is released.
   */
  hoverWhileClaimed?: boolean;
}

function wallNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * When an event happened, on the clock `now` (ws/input-6). `timeStamp` is `Event.timeStamp`, on
 * the `performance.now()` clock; its age (how long the page took to handle it) is subtracted
 * from `now()`, so a fake or tick-driven clock still sees a late event as early. An unusable
 * stamp (not finite, negative, or in the future) counts as handled at once: `now()`.
 */
export function eventTime(timeStamp: number, now: () => number): number {
  const wall = wallNow();
  const age =
    Number.isFinite(timeStamp) && timeStamp >= 0 && timeStamp <= wall ? wall - timeStamp : 0;
  return now() - age;
}

/** Consumer priorities `Input` uses, lowest first. A game's own consumer picks any number. */
export const POINTER_PRIORITY = {
  /** The `Input` feed (`pointerAt`, `buttonDown`, ...): sees everything, claimed or not. */
  feed: 0,
  /** Touch zones claim their thumbs before anything else reads them. */
  zones: 10,
  /** `Look`: an orbit drag claims its mouse or pen pointer. */
  look: 20,
  gestures: 30,
  /** The router's `ScreenPointers`: sees claimed pointers but hides them from `poll`. */
  screen: 40,
} as const;

export interface PointerDispatcher {
  readonly target: HTMLElement;
  /** `PointerDispatcherOptions.hoverWhileClaimed`; may be changed at any time. */
  hoverWhileClaimed: boolean;
  /**
   * Register a consumer; lower priorities are delivered first, equal priorities in registration
   * order. With `seesClaimed` the consumer receives records for claimed pointers too. Returns
   * the remover.
   */
  add(consumer: PointerConsumer, priority?: number, seesClaimed?: boolean): () => void;
  remove(consumer: PointerConsumer): void;
  /**
   * Claim pointer `id` for `owner`: until `release(id)`, the pointer lifts or is cancelled, its
   * records reach only `owner` and the `seesClaimed` consumers. False (and no change) when
   * another owner holds it. Claiming during delivery takes effect for the consumers after the
   * claimant on the same event.
   */
  claim(id: number, owner: object): boolean;
  release(id: number): void;
  /** The owner of a claimed pointer, or `null`. */
  owner(id: number): object | null;
  claimed(id: number): boolean;
  /** Replace the transform (`Input.setPointerTransform` does this). */
  setTransform(fn: PointerTransform | null): void;
  /** Remove the DOM listeners and every consumer and claim. */
  destroy(): void;
}

interface Entry {
  consumer: PointerConsumer;
  priority: number;
  seesClaimed: boolean;
}

type Method = 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel' | 'pointerLeave';

/** Build a dispatcher on `target` (see `PointerDispatcher`). The listeners go on at once. */
export function createPointerDispatcher(
  target: HTMLElement,
  opts: PointerDispatcherOptions = {},
): PointerDispatcher {
  const doc = target.ownerDocument;
  const win = doc.defaultView ?? window;
  let transform: PointerTransform | null = opts.transform ?? null;
  const entries: Entry[] = [];
  const claims = new Map<number, object>();
  const record: PointerRecord = {
    id: 0,
    device: 'mouse',
    button: 0,
    primary: true,
    x: 0,
    y: 0,
    clientX: 0,
    clientY: 0,
    time: 0,
    inside: true,
  };

  const fill = (e: PointerEvent): PointerRecord => {
    const r = record;
    r.id = e.pointerId;
    const type = e.pointerType;
    r.device = type === 'touch' || type === 'pen' ? type : 'mouse';
    r.button = Math.max(e.button, 0);
    r.primary = e.isPrimary;
    r.clientX = e.clientX;
    r.clientY = e.clientY;
    r.time = e.timeStamp;
    if (transform) {
      r.x = e.clientX;
      r.y = e.clientY;
      r.inside = transform(e.clientX, e.clientY) !== null;
    } else {
      const b = target.getBoundingClientRect();
      r.x = e.clientX - b.left;
      r.y = e.clientY - b.top;
      r.inside = true;
    }
    return r;
  };

  const deliver = (method: Method, r: PointerRecord): void => {
    // Consumers may add or remove themselves while delivering; index by position.
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i]!;
      if (!en.seesClaimed) {
        const owner = claims.get(r.id);
        if (owner !== undefined && owner !== en.consumer) continue;
      }
      en.consumer[method]?.(r);
    }
  };

  const onDown = (e: PointerEvent) => {
    deliver('pointerDown', fill(e));
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no active pointer.
    }
  };
  const onMove = (e: PointerEvent) => deliver('pointerMove', fill(e));
  const onUp = (e: PointerEvent) => {
    deliver('pointerUp', fill(e));
    claims.delete(e.pointerId);
  };
  const onCancel = (e: PointerEvent) => {
    deliver('pointerCancel', fill(e));
    claims.delete(e.pointerId);
  };
  const onLeave = (e: PointerEvent) => deliver('pointerLeave', fill(e));
  const cancelAll = () => {
    claims.clear();
    for (let i = 0; i < entries.length; i++) entries[i]!.consumer.cancelAll?.();
  };
  const onBlur = () => cancelAll();
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') cancelAll();
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);
  target.addEventListener('pointerleave', onLeave);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);

  const remove = (consumer: PointerConsumer): void => {
    const i = entries.findIndex((en) => en.consumer === consumer);
    if (i >= 0) entries.splice(i, 1);
    for (const [id, owner] of claims) if (owner === consumer) claims.delete(id);
  };

  return {
    target,
    hoverWhileClaimed: opts.hoverWhileClaimed ?? false,
    add(consumer, priority = 0, seesClaimed = false) {
      remove(consumer);
      let at = entries.length;
      while (at > 0 && entries[at - 1]!.priority > priority) at--;
      entries.splice(at, 0, { consumer, priority, seesClaimed });
      return () => remove(consumer);
    },
    remove,
    claim(id, owner) {
      const held = claims.get(id);
      if (held !== undefined && held !== owner) return false;
      claims.set(id, owner);
      return true;
    },
    release(id) {
      claims.delete(id);
    },
    owner: (id) => claims.get(id) ?? null,
    claimed: (id) => claims.has(id),
    setTransform(fn) {
      transform = fn;
    },
    destroy() {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onCancel);
      target.removeEventListener('pointerleave', onLeave);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
      entries.length = 0;
      claims.clear();
    },
  };
}
