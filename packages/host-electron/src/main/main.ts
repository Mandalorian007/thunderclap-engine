/**
 * The ThunderClap desktop shell's main process (D-041, Phase 4). It:
 * - turns WebGPU on explicitly (switches.ts) before the app is ready;
 * - serves the renderer bundle from `app://bundle/` (a fixed, secure origin, so `localStorage`
 *   saves stay put), or the local Vite dev server when `TC_RENDERER_URL` is set (unpackaged);
 * - cancels every request that would leave the machine, denies new windows, navigation away,
 *   webviews and permission prompts;
 * - answers the preload bridge (src/bridge.ts) after checking who called and with what.
 *
 * Unpackaged-only environment (ignored in a packaged build):
 * - `TC_RENDERER_URL`: load this local dev server instead of the bundle (`pnpm desktop:dev`).
 * - `TC_RENDERER_DIR`: serve this directory instead of `out/renderer`.
 * - `TC_USER_DATA`: use this `userData` directory (tests isolate saves with it).
 * - `TC_GPU_SWITCHES`: replace the WebGPU switches (e.g. SwiftShader on a headless runner).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  protocol,
  session,
  shell,
} from 'electron';
import { CH } from '../bridge';
import {
  APP_ORIGIN,
  APP_SCHEME,
  bundleFile,
  CSP,
  localDevUrl,
  mimeType,
  navigationAllowed,
  requestAllowed,
  safeExternalHttps,
} from './policy';
import { parseSwitches, webgpuSwitches } from './switches';

const here = dirname(fileURLToPath(import.meta.url));
const unpackaged = !app.isPackaged;
const env = (name: string): string | undefined => (unpackaged ? process.env[name] : undefined);

const devUrl = localDevUrl(env('TC_RENDERER_URL'));
const rendererDir = env('TC_RENDERER_DIR') ?? join(here, 'renderer');
const startUrl = devUrl ? devUrl.href : `${APP_ORIGIN}/`;

// WebGPU on, explicitly (README.md "WebGPU switches").
const gpuOverride = env('TC_GPU_SWITCHES');
for (const [name, value] of gpuOverride
  ? parseSwitches(gpuOverride)
  : webgpuSwitches(process.platform)) {
  if (value === undefined) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}

const userData = env('TC_USER_DATA');
if (userData) app.setPath('userData', userData);

// `standard` + `secure`: a real origin with `localStorage`, and a secure context for WebGPU.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// One instance per `userData`: a second one would find `localStorage` locked.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
  });
  app.whenReady().then(start);
}

app.on('window-all-closed', () => app.quit());

// No webviews, no new windows, no navigation away, in any web contents. A plain https link that
// asks for a new window (`<a target="_blank">`, the engine's link widget on a click or Enter)
// opens in the system browser instead, as the bridge's `openExternal` would: same rule, and only
// from our own page.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const href = safeExternalHttps(url);
    if (href && navigationAllowed(contents.getURL(), startUrl)) {
      shell.openExternal(href).catch((err) => {
        console.error('[thunderclap] openExternal failed:', err);
      });
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!navigationAllowed(url, startUrl)) e.preventDefault();
  });
  contents.on('will-redirect', (e, url) => {
    if (!navigationAllowed(url, startUrl)) e.preventDefault();
  });
});

function start(): void {
  const ses = session.defaultSession;

  protocol.handle(APP_SCHEME, async (req) => {
    const file = bundleFile(rendererDir, req.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': mimeType(file),
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // Nothing leaves the machine: only the page's own origin (or the local dev server).
  ses.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !requestAllowed(details.url, devUrl) });
  });
  // No permission prompts. Clipboard and fullscreen go through the bridge; HTML fullscreen
  // stays allowed so an engine element's own request still works.
  ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');

  installMenu();
  registerBridge();
  createWindow();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    useContentSize: true,
    show: false,
    backgroundColor: '#000000',
    title: app.getName(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: unpackaged,
    },
  });
  win.once('ready-to-show', () => win.show());
  const report = (on: boolean) => {
    if (!win.isDestroyed()) win.webContents.send(CH.fullscreenChanged, on);
  };
  win.on('enter-full-screen', () => report(true));
  win.on('leave-full-screen', () => report(false));
  void win.loadURL(startUrl);
  return win;
}

/** macOS needs an app menu for Cmd+Q, copy and paste; elsewhere a game window has none. */
function installMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      role: 'windowMenu',
      submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The window behind a bridge call, if the call came from our page's main frame. */
function callerWindow(e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(e.sender);
  const frame = e.senderFrame;
  if (!win || !frame || frame !== e.sender.mainFrame) return null;
  return navigationAllowed(frame.url, startUrl) ? win : null;
}

function registerBridge(): void {
  ipcMain.handle(CH.openExternal, async (e, url: unknown) => {
    const href = safeExternalHttps(url);
    if (!callerWindow(e) || !href) return false;
    try {
      await shell.openExternal(href);
      return true;
    } catch (err) {
      console.error('[thunderclap] openExternal failed:', err);
      return false;
    }
  });

  ipcMain.handle(CH.copyText, (e, text: unknown) => {
    if (!callerWindow(e) || typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle(CH.fullscreenGet, (e) => callerWindow(e)?.isFullScreen() ?? false);

  ipcMain.handle(CH.fullscreenSet, async (e, on: unknown) => {
    const win = callerWindow(e);
    if (!win) return false;
    const want = on === true;
    if (win.isFullScreen() === want) return want;
    // macOS animates into its own Space; wait for the event (bounded) before answering.
    const done = new Promise<void>((res) => {
      const t = setTimeout(res, 2000);
      const settle = () => {
        clearTimeout(t);
        res();
      };
      if (want) win.once('enter-full-screen', settle);
      else win.once('leave-full-screen', settle);
    });
    win.setFullScreen(want);
    await done;
    return win.isFullScreen();
  });

  ipcMain.on(CH.minimize, (e) => callerWindow(e)?.minimize());
  ipcMain.on(CH.toggleMaximize, (e) => {
    const win = callerWindow(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(CH.close, (e) => callerWindow(e)?.close());
  ipcMain.on(CH.setTitle, (e, title: unknown) => {
    if (typeof title === 'string') callerWindow(e)?.setTitle(title.slice(0, 200));
  });
}
