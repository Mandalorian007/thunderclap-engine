/**
 * Controller models that move as they're pressed (ws/xr-merge, from Forge Wilds' controller
 * models): the WebXR input profiles' layouts (`profile.json` of @webxr-input-profiles/assets,
 * the motion-controllers library's semantics) read against a model's node names, and each frame
 * every visual response's value from the gamepad. The game loads the profile and the model
 * (`./models` reads a .glb) and poses each response's value node between its min and max nodes
 * by `values[i]`, or hides it where `hidden[i]` is set. A hand with no controller draws nothing.
 *
 * Pure; `ControllerPose.frame` allocates nothing.
 */
import type { XrPad } from './sticks';

export type ControllerHand = 'left' | 'right';
/** A controller's parts a label can hang on (A and B on the right, X and Y on the left). */
export type ControllerPart = 'trigger' | 'grip' | 'stick' | 'a' | 'b' | 'x' | 'y';

/** The generic profile: what a controller whose own profile isn't to hand draws. */
export const FALLBACK_PROFILE = 'generic-trigger-squeeze-thumbstick';

/** A controller's profile: its first in `have`, else `fallback`. */
export function profileFor(
  profiles: readonly string[] | undefined,
  have: readonly string[],
  fallback = FALLBACK_PROFILE,
): string {
  if (profiles) for (const p of profiles) if (have.includes(p)) return p;
  return fallback;
}

/** The part of a profile.json the layout reads. */
export interface ProfileJson {
  profileId: string;
  layouts: Record<
    string,
    {
      rootNodeName?: string;
      assetPath?: string;
      components: Record<
        string,
        {
          type?: string;
          gamepadIndices?: { button?: number; xAxis?: number; yAxis?: number };
          visualResponses?: Record<
            string,
            {
              componentProperty: string;
              states: string[];
              valueNodeProperty: string;
              valueNodeName: string;
              minNodeName?: string;
              maxNodeName?: string;
            }
          >;
        }
      >;
    }
  >;
}

/** What a response reads. */
export const Prop = { Button: 0, XAxis: 1, YAxis: 2, State: 3 } as const;
export type Prop = (typeof Prop)[keyof typeof Prop];
/** A component's states, as bits. */
export const STATE_DEFAULT = 1;
export const STATE_TOUCHED = 2;
export const STATE_PRESSED = 4;
const BUTTON_TOUCH = 0.05;
const AXIS_TOUCH = 0.1;

export interface ResponseLayout {
  readonly prop: Prop;
  readonly states: number;
  /** Shows and hides its value node (else moves it between min and max). */
  readonly visibility: boolean;
  /** Node indices in the model. */
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

export interface ComponentLayout {
  readonly id: string;
  /** Gamepad indices, -1 for none. */
  readonly button: number;
  readonly xAxis: number;
  readonly yAxis: number;
  readonly responses: readonly ResponseLayout[];
}

export interface ControllerLayout {
  readonly profile: string;
  readonly hand: ControllerHand;
  readonly assetPath: string;
  readonly components: readonly ComponentLayout[];
  /** Every response, in order: `ControllerPose.values` indexes these. */
  readonly responses: readonly ResponseLayout[];
  /** The node a part's label hangs on (its first response's value node), -1 for none. */
  readonly parts: Readonly<Record<ControllerPart, number>>;
}

const PROP: Readonly<Record<string, Prop>> = {
  button: Prop.Button,
  xAxis: Prop.XAxis,
  yAxis: Prop.YAxis,
  state: Prop.State,
};
const STATE_BIT: Readonly<Record<string, number>> = {
  default: STATE_DEFAULT,
  touched: STATE_TOUCHED,
  pressed: STATE_PRESSED,
};
const PART_COMPONENT: Readonly<Record<ControllerPart, readonly [string, number]>> = {
  trigger: ['xr-standard-trigger', 0],
  grip: ['xr-standard-squeeze', 1],
  stick: ['xr-standard-thumbstick', 3],
  a: ['a-button', 4],
  x: ['x-button', 4],
  b: ['b-button', 5],
  y: ['y-button', 5],
};

/**
 * A hand's layout: `profile` read against the model's node names (in node order); responses
 * naming nodes the model lacks are left out.
 */
export function layoutOf(
  profile: ProfileJson,
  hand: ControllerHand,
  nodeNames: readonly string[],
): ControllerLayout {
  const l = profile.layouts[hand] ?? profile.layouts['left-right'] ?? profile.layouts.none;
  if (!l) throw new Error(`${profile.profileId} has no ${hand} layout`);
  const byName = new Map<string, number>();
  for (let i = 0; i < nodeNames.length; i++) byName.set(nodeNames[i]!, i);
  const node = (name: string | undefined): number =>
    name === undefined ? -1 : (byName.get(name) ?? -1);
  const components: ComponentLayout[] = [];
  const all: ResponseLayout[] = [];
  for (const [id, c] of Object.entries(l.components)) {
    const responses: ResponseLayout[] = [];
    for (const r of Object.values(c.visualResponses ?? {})) {
      const prop = PROP[r.componentProperty];
      if (prop === undefined) continue;
      const visibility = r.valueNodeProperty === 'visibility';
      const value = node(r.valueNodeName);
      const min = node(r.minNodeName);
      const max = node(r.maxNodeName);
      if (value < 0 || (!visibility && (min < 0 || max < 0))) continue;
      const states = r.states.reduce((b, s) => b | (STATE_BIT[s] ?? 0), 0);
      responses.push({ prop, states, visibility, value, min, max });
    }
    all.push(...responses);
    const gi = c.gamepadIndices ?? {};
    components.push({
      id,
      button: gi.button ?? -1,
      xAxis: gi.xAxis ?? -1,
      yAxis: gi.yAxis ?? -1,
      responses,
    });
  }
  const parts = {} as Record<ControllerPart, number>;
  for (const [part, [id, button]] of Object.entries(PART_COMPONENT) as [
    ControllerPart,
    readonly [string, number],
  ][]) {
    const face = part === 'a' || part === 'b' || part === 'x' || part === 'y';
    const c =
      components.find((k) => k.id === id) ??
      (face ? undefined : components.find((k) => k.button === button));
    parts[part] = c?.responses[0]?.value ?? -1;
  }
  return {
    profile: profile.profileId,
    hand,
    assetPath: l.assetPath ?? `${hand}.glb`,
    components,
    responses: all,
    parts,
  };
}

type PadButton = { readonly pressed: boolean; readonly touched?: boolean; readonly value?: number };

/** A component's state now (a `STATE_*` bit). */
export function componentState(c: ComponentLayout, pad: XrPad): number {
  let state = STATE_DEFAULT;
  if (c.button >= 0 && c.button < pad.buttons.length) {
    const b = pad.buttons[c.button] as PadButton;
    const v = Math.min(Math.max(b.value ?? (b.pressed ? 1 : 0), 0), 1);
    if (b.pressed || v === 1) state = STATE_PRESSED;
    else if (b.touched || v > BUTTON_TOUCH) state = STATE_TOUCHED;
  }
  if (state === STATE_DEFAULT) {
    const x = c.xAxis >= 0 ? (pad.axes[c.xAxis] ?? 0) : 0;
    const y = c.yAxis >= 0 ? (pad.axes[c.yAxis] ?? 0) : 0;
    if (Math.abs(x) > AXIS_TOUCH || Math.abs(y) > AXIS_TOUCH) state = STATE_TOUCHED;
  }
  return state;
}

/**
 * A response's value now: a button's 0 to 1 (0 outside its states), an axis 0 to 1 (0.5 outside
 * its states; the stick held to the unit circle), a state's 1 or 0 (visibility: 1 shown).
 */
export function responseValue(
  r: ResponseLayout,
  c: ComponentLayout,
  state: number,
  pad: XrPad,
): number {
  respondInto(r, c, state, pad, scratch, 0);
  return scratch[0]!;
}

const scratch = new Float32Array(1);

/** `responseValue` into `out[i]` (no number crosses a call: nothing boxed, nothing allocated). */
function respondInto(
  r: ResponseLayout,
  c: ComponentLayout,
  state: number,
  pad: XrPad,
  out: Float32Array,
  i: number,
): void {
  const on = (r.states & state) !== 0;
  if (r.prop === Prop.Button) {
    if (!on || c.button < 0 || c.button >= pad.buttons.length) out[i] = 0;
    else {
      const b = pad.buttons[c.button] as PadButton;
      out[i] = Math.min(Math.max(b.value ?? (b.pressed ? 1 : 0), 0), 1);
    }
  } else if (r.prop === Prop.State) out[i] = on ? 1 : 0;
  else if (!on) out[i] = 0.5;
  else {
    let x = c.xAxis >= 0 ? Math.min(Math.max(pad.axes[c.xAxis] ?? 0, -1), 1) : 0;
    let y = c.yAxis >= 0 ? Math.min(Math.max(pad.axes[c.yAxis] ?? 0, -1), 1) : 0;
    const h = Math.sqrt(x * x + y * y);
    if (h > 1) {
      x /= h;
      y /= h;
    }
    out[i] = (r.prop === Prop.XAxis ? x : y) * 0.5 + 0.5;
  }
}

/** One hand's responses this frame: the game poses its model's nodes from these. */
export class ControllerPose {
  /** Per response (`layout.responses`): the value 0 to 1. */
  readonly values: Float32Array;
  /** Per response: 1 where its value node is hidden this frame. */
  readonly hidden: Uint8Array;
  /** Button responses moved off rest (a pressed trigger's): a sign the model moves. */
  moved = 0;

  constructor(readonly layout: ControllerLayout) {
    this.values = new Float32Array(layout.responses.length);
    this.hidden = new Uint8Array(layout.responses.length);
  }

  /** Reads `pad` (null: at rest, every value 0, nothing hidden). */
  frame(pad: XrPad | null): void {
    this.values.fill(0);
    this.hidden.fill(0);
    this.moved = 0;
    if (!pad) return;
    let i = 0;
    for (const c of this.layout.components) {
      const state = componentState(c, pad);
      for (const r of c.responses) {
        respondInto(r, c, state, pad, this.values, i);
        const v = this.values[i]!;
        if (r.prop === Prop.Button && v > 0.05) this.moved++;
        if (r.visibility && v < 0.5) this.hidden[i] = 1;
        i++;
      }
    }
  }
}
