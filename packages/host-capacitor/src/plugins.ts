/**
 * The slices of Capacitor's plugin APIs this host calls, written out by hand so the package
 * compiles and tests without the `@capacitor/*` packages installed (they are optional peers the
 * app installs and hands to `createCapacitorHost({ plugins })`). The shapes follow Capacitor 5+;
 * the real plugin objects satisfy them structurally. `addListener` returns the handle directly
 * in some versions and a promise of it in others, so both are accepted.
 */

export interface PluginListenerHandle {
  remove(): Promise<void>;
}

export type ListenerResult = PluginListenerHandle | Promise<PluginListenerHandle>;

export interface AppState {
  isActive: boolean;
}

export interface BackButtonEvent {
  /** True when the WebView has history to go back to. */
  canGoBack: boolean;
}

/** `@capacitor/app`: the app's foreground state and Android's back button. */
export interface AppPlugin {
  getState(): Promise<AppState>;
  addListener(event: 'appStateChange', fn: (state: AppState) => void): ListenerResult;
  addListener(event: 'pause' | 'resume', fn: () => void): ListenerResult;
  addListener(event: 'backButton', fn: (event: BackButtonEvent) => void): ListenerResult;
  exitApp(): Promise<void>;
}

/** `@capacitor/browser`: an in-app browser sheet for external links. */
export interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}

/** `@capacitor/clipboard`. */
export interface ClipboardPlugin {
  write(options: { string: string }): Promise<void>;
}

export type ImpactStyle = 'LIGHT' | 'MEDIUM' | 'HEAVY';
export type NotificationType = 'SUCCESS' | 'WARNING' | 'ERROR';

/** `@capacitor/haptics`. The enums are string-valued, so their literals are accepted. */
export interface HapticsPlugin {
  impact(options?: { style: ImpactStyle }): Promise<void>;
  notification(options?: { type: NotificationType }): Promise<void>;
  vibrate(options?: { duration: number }): Promise<void>;
}

/** `@capacitor/preferences`: a string key-value store that survives app updates. */
export interface PreferencesPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

export type OrientationLockType =
  | 'any'
  | 'natural'
  | 'landscape'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary'
  | 'landscape-primary'
  | 'landscape-secondary';

/** `@capacitor/screen-orientation`. */
export interface ScreenOrientationPlugin {
  lock(options: { orientation: OrientationLockType }): Promise<void>;
  unlock(): Promise<void>;
}

/**
 * Every plugin the host can use, keyed by the name each package exports. Pass the ones the app
 * installed; each missing one falls back to the base (web) host's answer or to a no-op.
 */
export interface CapacitorPlugins {
  App: AppPlugin;
  Browser: BrowserPlugin;
  Clipboard: ClipboardPlugin;
  Haptics: HapticsPlugin;
  Preferences: PreferencesPlugin;
  ScreenOrientation: ScreenOrientationPlugin;
}
