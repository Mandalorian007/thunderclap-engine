/**
 * `@thunderclap-engine/host-electron`, renderer side: what a game imports. The main process and the
 * preload are built into `out/` by scripts/build.mjs and are not imported by games.
 */
export { BRIDGE_VERSION, type ThunderclapBridge } from './bridge';
export {
  createElectronHost,
  type ElectronHostOptions,
  electronBridge,
  inElectronShell,
} from './renderer';
