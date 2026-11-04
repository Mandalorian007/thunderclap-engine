/**
 * Up/down and gamepad confirm for a non-modal menu (a title screen, an end card), so every
 * control on it, links included, is reachable without a mouse. Modal panels use `PadNav`
 * instead.
 *
 * Arrow keys reach this while a button or link has focus if the game lists them as Input
 * `buttonKeys`, but Enter and Space do not: the focused control handles those natively. So
 * `confirm` is only taken here when it came from a gamepad.
 *
 * A pad press is not a user gesture, so a new-tab link is opened with `window.open` and checked:
 * if the browser blocks it, the link's copy field appears instead (`activateLink`).
 */
import type { InputDevice } from '../input/types';
import { focusableWithin } from './dom';
import { activateLink } from './link';

/** What a tick of menu input did: moved focus, clicked the focused control, or nothing. */
export type MenuNavResult = 'moved' | 'clicked' | null;

/** The slice of `Input` menu navigation reads. */
export interface MenuNavInput<A extends string> {
  pressed(action: A): boolean;
  readonly lastDevice: InputDevice;
}

/** The game's action names for up, down and confirm. Default `up`, `down`, `confirm`. */
export interface MenuNavActions<A extends string> {
  up: A;
  down: A;
  confirm: A;
}

const DEFAULT_ACTIONS = { up: 'up', down: 'down', confirm: 'confirm' } as const;

/**
 * One tick of menu navigation over the focusable controls in `root`. Call it from the scene's
 * update while no modal is open. Up and down move focus (wrapping; from outside the menu, down
 * goes to the first control and up to the last). Confirm from a gamepad activates the focused
 * control.
 */
export function menuNav<A extends string>(
  input: MenuNavInput<A>,
  root: HTMLElement,
  actions: MenuNavActions<A> = DEFAULT_ACTIONS as unknown as MenuNavActions<A>,
): MenuNavResult {
  const step = input.pressed(actions.down) ? 1 : input.pressed(actions.up) ? -1 : 0;
  const active = root.ownerDocument.activeElement as HTMLElement | null;
  const inside = !!active && active !== root && root.contains(active);
  if (step) {
    const items = focusableWithin(root);
    if (!items.length) return null;
    const at = inside ? items.indexOf(active) : -1;
    const next =
      at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
    return 'moved';
  }
  if (inside && input.lastDevice === 'gamepad' && input.pressed(actions.confirm)) {
    activateLink(active, 'gamepad');
    return 'clicked';
  }
  return null;
}
