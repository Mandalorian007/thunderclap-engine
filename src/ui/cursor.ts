/**
 * World cursor (ws/ui-3): a pad- and keyboard-driven selection cursor over the world. Grid mode
 * steps by (dx, dy) on each fresh d-pad or arrow press, with latch and repeat (hold to keep
 * stepping); targets mode snaps to the nearest target in the pressed direction. A/Enter selects.
 * The cursor element rides `Anchors` on the hud layer when the game says where the cursor is
 * (`at`) or a target is picked. It yields to a modal panel: while the stack owns the pad
 * (`stack.padOwner`, followed through `onPadOwnerChange`, ws/ui-4) nothing is read and the latch
 * is reset, so the pad is the panel's and the cursor resumes afterwards with a fresh latch.
 * Call `update()` once per frame (before or after `padNav.update()`, both latch on their own).
 */
import type { AnchorHandle, Anchors } from './anchor';
import { consumesArrows, h } from './dom';
import { defaultPads, type PadControl, type PadDir, type PadLike, readPad } from './padnav';
import type { PadOwner } from './stack';
import { toFrameUnits } from './text-scale';

/** A thing the cursor can land on in targets mode: a plane position plus its world point. */
export interface WorldTarget {
  id?: string | number;
  /** Plane coordinates the direction picking reasons in (a cell, a tile, a screen point). */
  x: number;
  y: number;
  /** The point the cursor element is anchored at. */
  world: ArrayLike<number>;
}

export interface CursorRepeat {
  /** ms a direction is held before it repeats. Default 400. */
  delay: number;
  /** ms between repeats. Default 80. */
  interval: number;
}

export interface CursorOptions {
  /** `grid` steps by (dx, dy); `targets` snaps between `targets()`. */
  mode: 'grid' | 'targets';
  /** Grid mode: a press (or repeat) in a direction; dy is +1 for down (y down). */
  step?: (dx: number, dy: number) => void;
  /** Grid mode: where the cursor is now, in world units, for its element; null hides it. */
  at?: () => ArrayLike<number> | null;
  /** Targets mode: the targets to pick from, read on each press. */
  targets?: () => readonly WorldTarget[];
  onSelect?: (target: WorldTarget | null) => void;
  onMove?: (target: WorldTarget | null) => void;
  repeat?: Partial<CursorRepeat>;
  /** Perpendicular drift weight for `pickTarget`. Default 2. */
  weight?: number;
  /** Gamepad source. Default `navigator.getGamepads()` (guarded). */
  getGamepads?: () => readonly (PadLike | null)[];
  /** Stick deflection that counts as a d-pad press. Default 0.6. */
  axisThreshold?: number;
  /** Listen for the arrow keys and Enter too. Default true. */
  keys?: boolean;
  /** Start enabled. Default true. */
  enabled?: boolean;
}

export interface WorldCursor {
  /** The cursor element on the hud layer (`aria-hidden`; a game's own class may style it). */
  readonly element: HTMLElement;
  readonly enabled: boolean;
  /**
   * True while the latch holds a control (a direction or A is held, or a direction repeats), as
   * of the last `update()`. It resets on each pad-owner transition.
   */
  readonly latched: boolean;
  /** Targets mode: the target under the cursor. */
  readonly target: WorldTarget | null;
  /** The cursor's world position (`at()` in grid mode, the target's `world` in targets mode). */
  readonly position: ArrayLike<number> | null;
  /** Read the pad and move; once per frame. `now` (ms) drives repeat; default `performance.now()`. */
  update(now?: number): void;
  /** Targets mode: land on a target (or none) without a press; fires `onMove`. */
  setTarget(target: WorldTarget | null): void;
  /** A press from the game's own input (a touch d-pad, a binding), latched like the pad. */
  press(dir: PadDir | 'activate'): void;
  enable(): void;
  disable(): void;
  dispose(): void;
}

/** What the cursor needs from its overlay (`Overlay` fits). */
export interface CursorHost {
  readonly layers: { readonly hud: HTMLElement };
  readonly stack: {
    /** Read once at creation (and each frame only by a host without `onPadOwnerChange`). */
    readonly hasModal: boolean;
    /** The pad-owner transition (ws/ui-4); a host without it is polled through `hasModal`. */
    onPadOwnerChange?(fn: (owner: PadOwner) => void): () => void;
  };
  /** The overlay's `Anchors`; throws until a camera built it. */
  anchors(): Anchors;
}

const DIRS: readonly PadDir[] = ['up', 'down', 'left', 'right'];
const DX: Record<PadDir, number> = { up: 0, down: 0, left: -1, right: 1 };
const DY: Record<PadDir, number> = { up: -1, down: 1, left: 0, right: 0 };
const KEY_DIR: Record<string, PadDir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/**
 * The target nearest `from` in direction `dir` (y down): among the targets with a positive
 * component along the direction, the one with the least `along + weight · perpendicular`, so a
 * neighbour straight ahead beats a nearer one off to the side. Null when none lies that way.
 */
export function pickTarget(
  from: { x: number; y: number },
  targets: readonly WorldTarget[],
  dir: PadDir,
  weight = 2,
): WorldTarget | null {
  const dx = DX[dir];
  const dy = DY[dir];
  let best: WorldTarget | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const t of targets) {
    const vx = t.x - from.x;
    const vy = t.y - from.y;
    const along = vx * dx + vy * dy;
    if (along <= 0) continue;
    const perp = Math.abs(vx * dy - vy * dx);
    const cost = along + weight * perp;
    if (cost < bestCost) {
      bestCost = cost;
      best = t;
    }
  }
  return best;
}

/** The cursor (see the module comment). Also reachable as `ui.cursor(opts)`. */
export function createCursor(host: CursorHost, opts: CursorOptions): WorldCursor {
  const layer = host.layers.hud;
  const doc = layer.ownerDocument;
  ensureCursorStyles(doc);
  const element = h('div', { class: 'tc-cursor', 'aria-hidden': 'true', hidden: true });
  const getPads = opts.getGamepads ?? defaultPads;
  const threshold = opts.axisThreshold ?? 0.6;
  const delay = opts.repeat?.delay ?? 400;
  const interval = opts.repeat?.interval ?? 80;
  const weight = opts.weight ?? 2;
  const useKeys = opts.keys ?? true;

  let enabled = opts.enabled ?? true;
  let target: WorldTarget | null = null;
  let handle: AnchorHandle | null = null;
  let disposed = false;
  // The latch: what was held last frame (pad and keys together) and the one direction repeating.
  const now = new Set<PadControl>();
  const held = new Set<PadControl>();
  const keys = new Set<PadControl>();
  const pressed = new Set<PadControl>();
  let repeatDir: PadDir | null = null;
  let repeatAt = 0;
  // Who owns the pad: a subscribing host tells us on each transition (the latch resets, and
  // nothing is read while the panel has the pad); a polling host is asked each frame.
  const subscribed = typeof host.stack.onPadOwnerChange === 'function';
  let yielded = host.stack.hasModal;
  const resetLatch = () => {
    held.clear();
    pressed.clear();
    repeatDir = null;
  };
  const unwatch = subscribed
    ? host.stack.onPadOwnerChange!((owner) => {
        yielded = owner === 'stack';
        resetLatch();
        // Getting the pad back: what is still held from the panel is not a fresh press here.
        if (!yielded) readPad(getPads(), threshold, held);
      })
    : null;

  const anchorAt = (world: ArrayLike<number> | null) => {
    if (!world) {
      if (handle) {
        handle.remove();
        handle = null;
      }
      element.hidden = true;
      return;
    }
    if (handle) handle.set(world);
    else handle = host.anchors().add(element, world);
    if (element.hidden) element.hidden = false;
  };

  const move = (dir: PadDir) => {
    if (opts.mode === 'grid') {
      opts.step?.(DX[dir], DY[dir]);
      opts.onMove?.(null);
      return;
    }
    const list = opts.targets?.() ?? [];
    const next = target ? pickTarget(target, list, dir, weight) : (list.find(() => true) ?? null);
    if (next && next !== target) setTarget(next);
  };

  function setTarget(t: WorldTarget | null): void {
    target = t;
    anchorAt(t ? t.world : null);
    opts.onMove?.(t);
  }

  const select = () => opts.onSelect?.(target);

  // A key held adds to `keys` (for the repeat); its first keydown also queues a one-shot in
  // `pressed`, so a tap that starts and ends between two frames still counts as a press.
  const onKeyDown = (e: KeyboardEvent) => {
    const dir = KEY_DIR[e.key];
    const active = doc.activeElement;
    let control: PadControl;
    if (dir) {
      if (active && active !== doc.body && consumesArrows(active, DX[dir] !== 0)) return;
      control = dir;
    } else if (e.key === 'Enter') {
      if (active && active !== doc.body && active !== layer) return;
      control = 'activate';
    } else return;
    keys.add(control);
    if (!e.repeat) pressed.add(control);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const dir = KEY_DIR[e.key];
    if (dir) keys.delete(dir);
    else if (e.key === 'Enter') keys.delete('activate');
  };
  const onBlur = () => keys.clear();
  if (useKeys) {
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp);
    doc.defaultView?.addEventListener('blur', onBlur);
  }

  const cursor: WorldCursor = {
    element,
    get enabled() {
      return enabled;
    },
    get latched() {
      return held.size > 0 || repeatDir !== null;
    },
    get target() {
      return target;
    },
    get position() {
      if (opts.mode === 'targets') return target ? target.world : null;
      return opts.at?.() ?? null;
    },
    update(t = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
      if (disposed) return;
      if (!subscribed) yielded = host.stack.hasModal;
      if (yielded) {
        // The panel has the pad: nothing is read, and the latch stays reset.
        pressed.clear();
        if (opts.mode === 'grid') anchorAt(opts.at?.() ?? null);
        return;
      }
      readPad(getPads(), threshold, now);
      for (const k of keys) now.add(k);
      for (const k of pressed) now.add(k);
      pressed.clear();
      if (!enabled) {
        // Disabled: a press that outlives it is not a fresh one.
        held.clear();
        for (const k of now) held.add(k);
        repeatDir = null;
      } else {
        if (now.has('activate') && !held.has('activate')) select();
        let fresh: PadDir | null = null;
        for (const d of DIRS) if (now.has(d) && !held.has(d)) fresh = d;
        if (fresh) {
          move(fresh);
          repeatDir = fresh;
          repeatAt = t + delay;
        } else if (repeatDir && now.has(repeatDir)) {
          if (t >= repeatAt) {
            move(repeatDir);
            repeatAt = t + interval;
          }
        } else repeatDir = null;
        held.clear();
        for (const k of now) held.add(k);
      }
      if (opts.mode === 'grid') anchorAt(opts.at?.() ?? null);
    },
    setTarget,
    press(dir) {
      pressed.add(dir);
    },
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      repeatDir = null;
    },
    dispose() {
      disposed = true;
      unwatch?.();
      if (useKeys) {
        doc.removeEventListener('keydown', onKeyDown);
        doc.removeEventListener('keyup', onKeyUp);
        doc.defaultView?.removeEventListener('blur', onBlur);
      }
      anchorAt(null);
      element.remove();
    },
  };
  return cursor;
}

/**
 * Stylesheet for the cursor element (design px, theme tokens).
 *
 * @deprecated (ws/api-core, E-036) Internal: its `ensure*Styles` injects it. Leaves the `ui` entry next
 * minor; tests import it from this file.
 */
export const CURSOR_CSS = toFrameUnits(`
.tc-cursor { width: 48px; height: 48px; box-sizing: border-box; pointer-events: none;
  border: 3px solid var(--tc-color-accent); border-radius: var(--tc-radius-s);
  box-shadow: 0 0 0 2px var(--tc-color-surface), var(--tc-shadow);
  animation: tc-cursor-pulse 1s ease-in-out infinite alternate; }
.tc-cursor[hidden] { display: none; }
@keyframes tc-cursor-pulse { from { opacity: 0.7; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .tc-cursor { animation: none; } }
`);

const STYLE_ID = 'tc-ui-cursor';

/** Add `CURSOR_CSS` to `doc` once (the first cursor does it). */
export function ensureCursorStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CURSOR_CSS;
  doc.head.appendChild(style);
}
