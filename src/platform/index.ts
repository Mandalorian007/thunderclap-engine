export type { BootOptions, BootResult } from './boot';
export { boot } from './boot';
export type { PointerKind } from './device';
export {
  fullscreenAvailable,
  isFullscreen,
  isPortrait,
  isTouchOnly,
  toggleFullscreen,
  watchFullscreen,
  watchPointerKind,
} from './device';
export type { DeviceTraits, LifecycleHandlers } from './environment';
export {
  deviceTraits,
  HANDHELD_SHORT_SIDE,
  prefersReducedMotion,
  watchLifecycle,
  watchReducedMotion,
  watchVisibility,
} from './environment';
export type { GpuContext, GpuFailureReason, GpuInitOptions, GpuInitResult } from './gpu';
export { initGpu } from './gpu';
export type { BackbufferSize, FillWidthOptions, Letterbox, Rect, Vec2 } from './letterbox';
export {
  clientToLogical,
  computeBackbuffer,
  computeFillWidth,
  computeLetterbox,
  logicalToClient,
} from './letterbox';
export type { CopyResult, EmbedContext, LinkActivation, OpenResult } from './links';
export { embedContext, safeExternalUrl } from './links';
export type { MessageScreenAction, MessageScreenOptions, PlatformFamily } from './screens';
export {
  platformFamily,
  showDeviceLostScreen,
  showMessageScreen,
  showUnsupportedScreen,
} from './screens';
export type { SurfaceOptions, SurfaceSize } from './surface';
export { mountSurface, Surface } from './surface';
