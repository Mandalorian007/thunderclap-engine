/**
 * `@thunderclap/host-capacitor`: the engine's `Host` for a Capacitor (iOS / Android) app.
 * See README.md for the capacitor.config.ts recipe and the back-button guidance.
 */
export {
  type CapacitorHost,
  type CapacitorHostOptions,
  createAppLifecycle,
  createCapacitorHaptics,
  createCapacitorHost,
  createPreferencesStorage,
  type HostBack,
} from './capacitor';
export type {
  AppPlugin,
  AppState,
  BackButtonEvent,
  BrowserPlugin,
  CapacitorPlugins,
  ClipboardPlugin,
  HapticsPlugin,
  ImpactStyle,
  ListenerResult,
  NotificationType,
  OrientationLockType,
  PluginListenerHandle,
  PreferencesPlugin,
  ScreenOrientationPlugin,
} from './plugins';
