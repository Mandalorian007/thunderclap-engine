/**
 * `@thunderclap-engine/engine/kit` (ws/kit, E-041 P4): `composeGame` and the services it composes.
 * A game passes only the services it uses (`withOverlay`, `withInput`, `withPost`, ...); the
 * rest are never imported. Each service is also constructible alone (`createKitInput`, ...).
 * The root `createGame` is the default kit: every service on.
 */
export type { KitAudioDeps, KitAudioFields } from './audio';
export { createKitAudio, withAudio } from './audio';
export type { KitBoot, KitBootOptions } from './boot';
export { bootKit, createKitRenderer } from './boot';
export type {
  KitCtx,
  KitExternalFrame,
  KitGame,
  KitLoopOptions,
  KitOptions,
} from './compose';
export { composeGame } from './compose';
export type { ExternalFrames } from './frames';
export { createExternalFrames } from './frames';
export type {
  KitInput,
  KitInputDeps,
  KitInputFields,
  KitInputOptions,
} from './input';
export { createKitInput, withInput } from './input';
export type { KitOverlayDeps, KitOverlayFields, KitOverlayOptions } from './overlay';
export { createKitOverlay, withOverlay } from './overlay';
export type { KitParticleFields, KitPostFields } from './post';
export { withParticles, withPost } from './post';
export type {
  CrashOptions,
  FlushableSave,
  GameHooks,
  GameReplay,
  HideReason,
  KitCore,
  KitPart,
  KitService,
  KitStepPart,
  ReplayOptions,
  ShowReason,
  SimOption,
  XrControl,
  XrOptions,
} from './types';
export type { KitXr, KitXrDeps, KitXrFields } from './xr';
export { createKitXr, withXr } from './xr';
