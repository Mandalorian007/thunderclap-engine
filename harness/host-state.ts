/**
 * What the host-facets harness page (harness/host.ts) publishes on `window.__harnessHost` for
 * e2e/host.spec.ts: the web host's lifecycle, haptics and safe area as `createGame` wires them.
 * Shared by the page and the spec.
 */
import type { Rect } from '@thunderclap/engine/ui';

export interface HarnessHostState {
  /** True once `createGame` resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', 'unsupported' or an error message. */
  gpu: string;
  /** Rendered frames (counted in `hooks.afterRender`). */
  frames: number;
  loopRunning: boolean;
  /** `host.lifecycle.state` now. */
  lifecycle: 'active' | 'background';
  /** Every `hooks.lifecycle` call, in order. */
  lifecycleEvents: ('active' | 'background')[];
  /** `host.haptics.available()`. */
  hapticsAvailable: boolean;
  /** `host.safeArea.insets()`: the `?safe=` values when given, else the page's `env()`. */
  safeArea: { top: number; right: number; bottom: number; left: number };
  /** The layout's effective insets (`ui.layout.state.safeArea`). */
  layoutSafeArea: { top: number; right: number; bottom: number; left: number };
  /** The `top` and `bottom` layout regions, overlay CSS px, or null when collapsed. */
  regionsTop: Rect | null;
  regionsBottom: Rect | null;
  /** The overlay's rect in the viewport, and the viewport, CSS px. */
  overlay: Rect;
  viewport: { width: number; height: number };
}

/** `window.__harnessHost`. */
export interface HarnessHostApi {
  state(): HarnessHostState;
}

declare global {
  interface Window {
    __harnessHost?: HarnessHostApi;
  }
}
