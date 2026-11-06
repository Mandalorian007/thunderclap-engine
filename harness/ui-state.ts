/**
 * What the UI harness page (harness/ui.html) publishes on `window.__harnessUi` for the engine e2e
 * specs: density tokens, device mode, the rotate card, menu navigation, panel focus and button
 * keys. Shared by the page (harness/ui.ts) and the specs (e2e/ui.spec.ts).
 */
export interface HarnessUiState {
  /** True once the page is mounted. */
  ready: boolean;
  /** Overlay scale (CSS px per design px of the frame). */
  scale: number;
  /** The overlay's units in this form factor (`frame` on desktops and tablets, `css` on phones). */
  units: 'frame' | 'css';
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
  /** `?tooltip`: the shared tooltip's state (ws/ui-3). */
  tooltipVisible: boolean;
  tooltipPlacement: string | null;
  /** `?cursor`: the grid cell the cursor is on, `[col, row]`, and the picked target's id. */
  cursorCell: [number, number];
  cursorTarget: string | null;
  /** `?loading`: the bar's progress 0..1, or -1 once done. */
  loadingProgress: number;
  /** `?notify`: open notifications, and the actions fired, by label. */
  notifications: number;
  notifyActions: string[];
}

export interface HarnessUiApi {
  state: HarnessUiState;
  /** `applyTextScale` on the overlay root (1 = 100%). */
  setTextScale(scale: number): void;
  /** Hold (or release) a standard-mapping button on the fake gamepad. */
  pad(button: number, pressed: boolean): void;
  /** `?loading`: finish the load (resolves after the fade). */
  finishLoading(): Promise<void>;
}

declare global {
  interface Window {
    __harnessUi?: HarnessUiApi;
  }
}
