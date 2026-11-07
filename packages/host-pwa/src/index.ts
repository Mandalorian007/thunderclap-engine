/**
 * `@thunderclap-engine/host-pwa`: what a game imports. The page side (`createPwaHost`, `inStandalone`)
 * and the build side (`pwaPlugin`, also at `@thunderclap-engine/host-pwa/vite`, which a `vite.config.ts`
 * should prefer so Node never loads the host).
 */
export {
  type CacheStatus,
  createPwaHost,
  type InstallOutcome,
  inStandalone,
  type PwaHost,
  type PwaHostOptions,
} from './host';
export type { ManifestIcon, ManifestOptions, WebManifest } from './manifest';
export type { Route, RouteRequest } from './sw-logic';
export { type PwaPluginOptions, pwaPlugin } from './vite';
