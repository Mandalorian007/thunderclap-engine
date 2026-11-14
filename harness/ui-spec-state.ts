/**
 * What the UI spec harness page (harness/ui-spec.html) publishes on `window.__harnessUiSpec` for
 * e2e/ui-spec.spec.ts. Shared by the page (harness/ui-spec.ts) and the spec.
 */
export interface HarnessUiSpecState {
  /** True once the HUD is drawn. */
  ready: boolean;
  /** Animation frames run (each one applies the HUD). */
  frames: number;
  /** The health and mana the page last set (0..1). */
  health: number;
  mana: number;
  /** The hotbar's selected slot. */
  selected: number;
  /** Quests listed, and done. */
  quests: number;
  done: number;
  /** The dialog is open on the overlay's stack. */
  dialog: boolean;
  /** DOM writes by the HUD's presenters so far (`DomPresenter.writes`). */
  writes: number;
  /** Panel applies that did something so far. */
  applies: number;
  /** The last panel event: `<panel>/<id>:<type>`. */
  last: string;
  /** Time-driven motion (the bars' drift) is parked. */
  parked: boolean;
}

export interface HarnessUiSpecApi {
  state: HarnessUiSpecState;
  /** Park or resume the bars' drift. */
  park(on: boolean): void;
  /** Select hotbar slot `i`. */
  select(i: number): void;
  /** Add a quest; returns its key. */
  addQuest(title: string): string;
  /** Mark quest `key` done (it moves to the end of the list). */
  finish(key: string): void;
  openDialog(): void;
  closeDialog(): void;
}

declare global {
  interface Window {
    __harnessUiSpec?: HarnessUiSpecApi;
  }
}
