/**
 * `@thunderclap/engine`: the top layer a game touches (D-041). `createGame()` boots the platform
 * and wires every noun-free system into one ctx. The modules under it stay reachable through
 * their own subpaths (`@thunderclap/engine/<module>`).
 */
export type {
  CreateGameOptions,
  EngineCtx,
  FlushableSave,
  GameHooks,
  HideReason,
  ShowReason,
  SimOption,
} from './core/game';
export { createGame } from './core/game';
