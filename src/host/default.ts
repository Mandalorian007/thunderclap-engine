/**
 * The host engine modules use when the caller passes none (`createSaveStore`, `listSlots`,
 * `persistMixer`, `externalLink`): a web host, made on first use. A shell that is not the
 * browser (Electron) calls `setDefaultHost` before anything else runs. Games should still pass
 * their host explicitly.
 */
import type { Host } from './types';
import { createWebHost } from './web';

let current: Host | null = null;

export function defaultHost(): Host {
  current ??= createWebHost();
  return current;
}

/** Replaces the default host (null: a fresh web host on next use). */
export function setDefaultHost(host: Host | null): void {
  current = host;
}
