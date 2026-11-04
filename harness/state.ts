/**
 * What the harness page publishes on `window.__harness` for the engine e2e specs.
 * Shared by the page (harness/main.ts) and the specs (e2e/), so both agree on the shape.
 */
export interface HarnessTap {
  /** Logical (design-space) position of the press. */
  x: number;
  y: number;
  /** `Input.lastDevice` at the press. */
  device: string;
}

export interface HarnessState {
  /** True once boot finished (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', or the boot failure reason. */
  gpu: string;
  /** Swapchain format when `gpu === 'ok'`. */
  format: string | null;
  /** `window !== window.top`. */
  embedded: boolean;
  /** Rendered frames (each one clears and presents the swapchain). */
  frames: number;
  /** `Surface.onResize` calls (the first fires on subscribe). */
  resizes: number;
  /** Surface letterbox rect, CSS px relative to the root. */
  rect: { x: number; y: number; width: number; height: number; scale: number };
  /** Root (container) size, CSS px. */
  container: { width: number; height: number };
  /** Surface backbuffer, device px. */
  backbuffer: { width: number; height: number; pixelRatio: number };
  /** Size of the last presented swapchain texture. */
  presented: { width: number; height: number };
  /** Every `tap` action press, in order. */
  taps: HarnessTap[];
}

/** What the web host reports, and every open and copy result so far (harness/host-probe.ts). */
export interface HarnessHostInfo {
  kind: string;
  embed: string;
  /** `host.storage.open()` gave a working backend. */
  storage: boolean;
  clipboardWriteAllowed: boolean;
  fullscreenAvailable: boolean;
  fullscreenActive: boolean;
  copies: string[];
  opens: string[];
  /** Every `host.fullscreen.watch` report since `mount()`. */
  fullscreen: boolean[];
}

export interface HarnessSaveResult {
  persistent: boolean;
  loadResult: string;
  error: string | null;
  n: number;
}

/** `window.__host`: drives the web host the way a game does. */
export interface HarnessHostProbe {
  info(): HarnessHostInfo;
  /** Adds an `externalLink` widget (through the host) and a fullscreen button, top left. */
  mount(): void;
  /** `activateLink` on the probe link, as PadNav does for a pad press. */
  activate(activation: 'pointer' | 'keyboard' | 'gamepad' | 'script'): string | null;
  /** Writes `{ n }` to a save slot whose storage comes from the host. */
  save(n: number): HarnessSaveResult;
  /** Loads that slot fresh. */
  load(): HarnessSaveResult;
  clearSave(): void;
}

declare global {
  interface Window {
    __harness?: HarnessState;
    __host?: HarnessHostProbe;
  }
}
