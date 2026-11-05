/**
 * What the desktop harness page (harness/main.ts) publishes on `window.__desktop` for the
 * Electron smoke (e2e/shell.spec.ts). Shared by both so they agree on the shape.
 */
export interface DesktopSaveResult {
  persistent: boolean;
  loadResult: string;
  error: string | null;
  n: number;
}

export interface DesktopState {
  /** True once boot finished, whether or not WebGPU came up. */
  ready: boolean;
  /** 'ok', or the boot failure reason. */
  gpu: string;
  /** Swapchain format when `gpu === 'ok'`. */
  format: string | null;
  /** Frames rendered (each clears and presents the swapchain). */
  frames: number;
}

export interface DesktopHostInfo {
  kind: string;
  embed: string;
  /** `window.thunderclap.version`, or null outside the shell. */
  bridgeVersion: number | null;
  /** `host.storage.kind`, and whether `open()` gave a working backend. */
  storageKind: string;
  storage: boolean;
  clipboardWriteAllowed: boolean;
  fullscreenAvailable: boolean;
  fullscreenActive: boolean;
  hasWindow: boolean;
}

export interface DesktopProbe {
  state: DesktopState;
  info(): DesktopHostInfo;
  open(url: string, activation: 'pointer' | 'keyboard' | 'gamepad' | 'script'): string;
  copy(text: string): Promise<string>;
  setTitle(title: string): void;
  /** Writes `{ n }` to a save slot whose storage comes from the host. */
  save(n: number): DesktopSaveResult;
  /** Loads that slot fresh. */
  load(): DesktopSaveResult;
}

declare global {
  interface Window {
    __desktop?: DesktopProbe;
  }
}
