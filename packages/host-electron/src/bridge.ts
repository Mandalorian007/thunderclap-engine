/**
 * The preload bridge: what the Electron shell exposes to the page as `window.thunderclap`
 * (src/preload/preload.ts), and the IPC channel names behind it. Shared by the main process,
 * the preload and the renderer, so it imports nothing.
 *
 * The page never gets Node, `ipcRenderer` or any Electron module, only these functions. Every
 * call is checked again in the main process (src/main/ipc.ts): links must be plain `https:`,
 * text must be a string, and only the shell's own window may call.
 */

/** Bumped when a member is removed or changes meaning; adding one does not bump it. */
export const BRIDGE_VERSION = 1;

/** The global the preload defines. */
export const BRIDGE_GLOBAL = 'thunderclap';

export interface ThunderclapBridge {
  readonly version: number;
  /** `process.platform` of the shell: `darwin`, `win32` or `linux`. */
  readonly platform: string;
  /**
   * Opens a plain `https:` URL in the user's browser (`shell.openExternal`). Resolves false
   * when the main process refused it (not https, credentials, whitespace) or the OS failed.
   */
  openExternal(url: string): Promise<boolean>;
  /** Writes `text` to the system clipboard (`clipboard.writeText`). */
  copyText(text: string): Promise<boolean>;
  readonly fullscreen: {
    /** Whether the window is fullscreen now. */
    get(): Promise<boolean>;
    /** Enters or leaves fullscreen; resolves to the state afterwards. */
    set(on: boolean): Promise<boolean>;
    /** Calls `fn` whenever the window enters or leaves fullscreen. Returns unsubscribe. */
    onChange(fn: (on: boolean) => void): () => void;
  };
  readonly window: {
    minimize(): void;
    toggleMaximize(): void;
    /** Closes the window; the shell quits when it was the last one. */
    close(): void;
    setTitle(title: string): void;
  };
}

/** IPC channels, all prefixed `tc:`. `invoke` channels answer; `send` channels do not. */
export const CH = {
  openExternal: 'tc:open-external',
  copyText: 'tc:copy-text',
  fullscreenGet: 'tc:fullscreen-get',
  fullscreenSet: 'tc:fullscreen-set',
  /** main → renderer: the new fullscreen state. */
  fullscreenChanged: 'tc:fullscreen-changed',
  minimize: 'tc:window-minimize',
  toggleMaximize: 'tc:window-toggle-maximize',
  close: 'tc:window-close',
  setTitle: 'tc:window-set-title',
} as const;
