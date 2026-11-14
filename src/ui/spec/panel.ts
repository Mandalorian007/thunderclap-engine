/**
 * A panel (ws/ui-spec, from Forge Wilds' `ui/spec/panel.ts`): its words compiled, its model, its
 * boxes, and the presenters drawing it. State in (`model`), events out (`onEvent`): the game sets
 * the model, the presenters say what was pressed. One apply a frame, and only when something
 * changed: the model's first change after a draw asks the host for a frame (`schedule`), the
 * layout runs only when a box moved (a show, a list's length, a new frame), each presenter writes
 * only what changed, and an idle frame returns at once.
 */

import { SpecBoxes } from './boxes';
import { type CompiledSpec, compileSpec } from './compile';
import { SpecModel } from './model';
import { type SpecFamilies, typeMeasureIn } from './units';
import type { PanelEvent, PanelSpec } from './words';

/** What draws a panel: the page (`presentDom`), or a surface in the world. */
export interface SpecPresenter {
  /**
   * Draws what changed since the last apply: every box when `relaid` (the layout ran), then the
   * model's dirty keys and rows. Reads nothing back from its surface.
   */
  apply(relaid: boolean): void;
  /** Takes its surface down. */
  dispose(): void;
}

/** A host's frame scheduler: requestAnimationFrame's shape. */
export type SpecSchedule = (f: () => void) => void;

const nextFrame: SpecSchedule = (f) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => f());
  else queueMicrotask(f);
};

/**
 * Whether a panel that gives way as `give` says (`PanelSpec.giveWay`) has given way now: a sheet
 * covers the screen (`sheet`), on a small screen (`small`) if it says `small`. The one rule every
 * presenter and host asks.
 */
export function specGivesWay(
  give: '' | 'small' | 'always' | undefined,
  sheet: boolean,
  small: boolean,
): boolean {
  return !!give && sheet && (give === 'always' || small);
}

/** Compiled specs, one per spec object. */
const compiled = new WeakMap<PanelSpec, CompiledSpec>();

/** How a panel is made. */
export interface SpecPanelOptions {
  /**
   * How it asks for a frame once its model changes (default: `requestAnimationFrame`); null: the
   * host calls `apply` itself once a frame (a game loop's `onFrame`).
   */
  schedule?: SpecSchedule | null;
  /**
   * The game's own type stacks (ws/ui-fit; each over `SPEC_FAMILY`'s): its wrap texts' lines are
   * counted in them (`typeMeasureIn`). Give its theme the same fonts.
   */
  families?: Partial<SpecFamilies>;
}

/** A panel: its compiled words, model, boxes and presenters. Made with `panel(spec)`. */
export class SpecPanel {
  readonly spec: CompiledSpec;
  readonly model: SpecModel;
  readonly boxes: SpecBoxes;
  readonly presenters: SpecPresenter[] = [];
  /** What was pressed, typed or picked. */
  onEvent: ((e: PanelEvent) => void) | null = null;
  /**
   * Told each new frame (its width, height and text scale) before it is laid out: where the game
   * counts a bound text's lines at the width now (`wrapCount`), so the layout that follows has them.
   */
  onFrame: ((w: number, h: number, text: number) => void) | null = null;
  /** The frame laid out in: width (0: natural), height (0: natural), and text scale. */
  w = 0;
  h = 0;
  text = 1;
  /** Applies that did something (for the budgets). */
  applies = 0;
  /** It has given way (`giveWay`): its presenters hide it and take no presses. */
  given = false;
  private framed = false;
  private scheduled = false;
  private readonly schedule: SpecSchedule | null;
  private readonly run = (): void => this.apply();

  constructor(spec: PanelSpec, schedule: SpecSchedule | null = nextFrame) {
    let c = compiled.get(spec);
    if (!c) {
      c = compileSpec(spec);
      compiled.set(spec, c);
    }
    this.spec = c;
    this.model = new SpecModel(c);
    this.boxes = new SpecBoxes(c, this.model);
    this.schedule = schedule;
    this.model.onChange = () => this.ask();
  }

  /** The frame changed (`w` 0: its natural width; `h` 0: its natural height): laid out again at the next apply. */
  frame(w: number, h: number, text = 1): void {
    if (w === this.w && h === this.h && text === this.text && this.framed) return;
    this.w = w;
    this.h = h;
    this.text = text;
    this.framed = true;
    this.onFrame?.(w, h, text);
    this.model.relayout = true;
    this.model.changed();
    this.ask();
  }

  /**
   * A sheet covers the screen (`sheet`) or not, on a `small` screen or not: the panel gives way if
   * its spec says so (`PanelSpec.giveWay`, `specGivesWay`), drawn at the next apply.
   */
  giveWay(sheet: boolean, small: boolean): void {
    const given = specGivesWay(this.spec.giveWay, sheet, small);
    if (given === this.given) return;
    this.given = given;
    this.model.changed();
    this.ask();
  }

  /** Stack `id`'s aim now (`SpecStack.aim`: fixed, or its key's value; '' for none or no such word). */
  aimOf(id: string): string {
    const c = this.spec;
    const i = c.ids.indexOf(id);
    if (i === -1) return '';
    const aim = (c.nodes[i] as { aim?: string | { b: string } }).aim;
    if (aim === undefined) return '';
    if (typeof aim === 'string') return aim;
    const v = this.model.get(aim.b);
    return v === null || v === undefined ? '' : String(v);
  }

  /** Draws what changed: nothing, at once, when nothing did. */
  apply(): void {
    this.scheduled = false;
    const m = this.model;
    // Idle (or not yet given a frame: nothing to lay out in): nothing to do.
    if (!m.pending || !this.framed) return;
    this.applies++;
    const relaid = m.relayout;
    if (relaid) this.boxes.layout(this.w, this.h, this.text);
    for (let i = 0; i < this.presenters.length; i++) this.presenters[i]!.apply(relaid);
    m.clean();
  }

  /** Says what happened (a presenter's press, field or pick). */
  emit(e: PanelEvent): void {
    this.onEvent?.(e);
  }

  /** Takes every presenter down. */
  dispose(): void {
    for (const p of this.presenters) p.dispose();
    this.presenters.length = 0;
    this.model.onChange = null;
  }

  private ask(): void {
    if (this.scheduled || !this.schedule) return;
    this.scheduled = true;
    this.schedule(this.run);
  }
}

/** A panel from `spec` (compiled once per spec object; it throws on a malformed spec). */
export function panel(spec: PanelSpec, opts: SpecPanelOptions = {}): SpecPanel {
  const p = new SpecPanel(spec, opts.schedule === undefined ? nextFrame : opts.schedule);
  if (opts.families) p.boxes.measure = typeMeasureIn(opts.families);
  return p;
}
