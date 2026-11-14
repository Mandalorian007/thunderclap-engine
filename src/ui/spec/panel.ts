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

/** Compiled specs, one per spec object. */
const compiled = new WeakMap<PanelSpec, CompiledSpec>();

/** How a panel is made. */
export interface SpecPanelOptions {
  /**
   * How it asks for a frame once its model changes (default: `requestAnimationFrame`); null: the
   * host calls `apply` itself once a frame (a game loop's `onFrame`).
   */
  schedule?: SpecSchedule | null;
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
  return new SpecPanel(spec, opts.schedule === undefined ? nextFrame : opts.schedule);
}
