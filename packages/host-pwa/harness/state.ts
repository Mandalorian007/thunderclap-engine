/**
 * What the PWA harness page (harness/main.ts) publishes on `window.__pwa` for the smoke
 * (e2e/pwa.spec.ts). Shared by both so they agree on the shape.
 */
export interface PwaProbe {
  /** `host.kind`: stays `'web'`. */
  kind: string;
  standalone: boolean;
  installable: boolean;
  updateReady: boolean;
  offline: boolean;
  /** Changes seen through `onOffline`, in order. */
  offlineEvents: boolean[];
  /** `host.pwa.cacheStatus()`. */
  cache(): Promise<{ precached: number; runtime: number; bytes: number }>;
  /** Fetches `data/<name>` (a `runtimeCache` prefix) and returns its status. */
  fetchData(name: string): Promise<number>;
  install(): Promise<string>;
  clearCache(): Promise<void>;
  /** The worker registration's state, or `'none'`. */
  workerState(): Promise<string>;
  /** `window.__tcPwa.version` from the plugin's snippet, or null. */
  version: string | null;
}

declare global {
  interface Window {
    __pwa?: PwaProbe;
    __tcPwa?: { sw: string; version: string };
  }
}
