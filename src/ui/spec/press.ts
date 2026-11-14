/**
 * What a press on a panel is (ws/ui-spec, from Forge Wilds' `ui/spec/press.ts`): a tap, or a hold
 * (a press held still for `SPEC_HOLD_MS`, a finger or a mouse button, or a right click), with the
 * click that follows a hold's release swallowed. `SpecPressable` runs on plain numbers and a
 * clock it is handed, so Node tests it and a world presenter can feed it rays.
 */

/** How long a press rests before it is a hold, ms. */
export const SPEC_HOLD_MS = 450;

/** How far a resting press may drift and still be a hold, CSS px (or panel units). */
export const SPEC_HOLD_SLOP = 8;

/** A clock that can call back: setTimeout's shape (injected in tests). */
export interface SpecTimer {
  set(f: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: SpecTimer = {
  set: (f, ms) => setTimeout(f, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** One target's press: tap and hold, from down, move, up and click. */
export class SpecPressable {
  private readonly timer: SpecTimer;
  private handle: unknown = null;
  private held = false;
  private x0 = 0;
  private y0 = 0;
  /** Whether a hold can happen (no hold: every press is a tap). */
  holds: boolean;
  onTap: ((shift: boolean) => void) | null = null;
  onHold: (() => void) | null = null;
  /** How far a resting press may drift and still be a hold (a ray's press drifts more). */
  private readonly slop: number;

  constructor(holds: boolean, timer: SpecTimer = realTimer, slop = SPEC_HOLD_SLOP) {
    this.holds = holds;
    this.timer = timer;
    this.slop = slop;
  }

  /** A press starts at (x, y) with button `button` (0: the main one). */
  down(x: number, y: number, button = 0): void {
    if (!this.holds || button !== 0) return;
    this.held = false;
    this.x0 = x;
    this.y0 = y;
    this.cancel();
    this.handle = this.timer.set(this.fire, SPEC_HOLD_MS);
  }

  /**
   * Another press went down (on anything, holding or not): the click a hold
   * swallows is not coming now (that hold's release landed elsewhere: on a
   * card it opened, say), so the next click is a tap.
   */
  begin(): void {
    this.held = false;
    this.cancel();
  }

  /** The press moved to (x, y): far enough, it is no hold. */
  move(x: number, y: number): void {
    if (this.handle !== null && Math.hypot(x - this.x0, y - this.y0) > this.slop) this.cancel();
  }

  /** The press ended or left (no hold now). */
  cancel(): void {
    if (this.handle === null) return;
    this.timer.clear(this.handle);
    this.handle = null;
  }

  /** The click a press ends in: a tap, unless a hold just fired. */
  click(shift = false): void {
    if (this.held) {
      this.held = false;
      return;
    }
    this.onTap?.(shift);
  }

  /** A right click: a hold at once. */
  context(): void {
    if (!this.holds) return;
    this.cancel();
    this.onHold?.();
  }

  private readonly fire = (): void => {
    this.handle = null;
    this.held = true;
    this.onHold?.();
  };
}
