/**
 * `@thunderclap-engine/engine`: the top layer a game touches (D-041). `createGame()` boots the platform
 * and wires every noun-free system into one ctx. The modules under it stay reachable through
 * their own subpaths (`@thunderclap-engine/engine/<module>`).
 */
export type { CrashScreen, CrashScreenOptions } from './core/crash';
export { installCrashScreen } from './core/crash';
export type {
  CrashOptions,
  CreateGameOptions,
  EngineCtx,
  FlushableSave,
  GameHooks,
  GameReplay,
  HideReason,
  ReplayOptions,
  ShowReason,
  SimOption,
  XrControl,
  XrOptions,
} from './core/game';
export { createGame } from './core/game';
