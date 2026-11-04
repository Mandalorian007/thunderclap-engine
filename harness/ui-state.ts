/**
 * What the UI harness page (harness/ui.html) publishes on `window.__harnessUi` for the engine e2e
 * specs: density tokens, device mode, the rotate card, menu navigation, panel focus and button
 * keys. Shared by the page (harness/ui.ts) and the specs (e2e/ui.spec.ts).
 */
export interface HarnessUiState {
  /** True once the page is mounted. */
  ready: boolean;
  /** Overlay scale (CSS px per design px). */
  scale: number;
  /** Device mode. */
  phone: boolean;
  touch: boolean;
  /** Rotate card showing. */
  rotate: boolean;
  /** `menuNav` results that were not null, in order. */
  menu: string[];
  /** Clicks on the menu's buttons, by label. */
  clicks: string[];
  /** `back` action presses (Escape is a button key). */
  backs: number;
  /** Ticks run (input updates). */
  ticks: number;
}

export interface HarnessUiApi {
  state: HarnessUiState;
  /** `applyTextScale` on the overlay root (1 = 100%). */
  setTextScale(scale: number): void;
  /** Hold (or release) a standard-mapping button on the fake gamepad. */
  pad(button: number, pressed: boolean): void;
}

declare global {
  interface Window {
    __harnessUi?: HarnessUiApi;
  }
}
