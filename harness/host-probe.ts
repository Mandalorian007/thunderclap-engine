/**
 * Host probe for the engine e2e (e2e/host.spec.ts): the web host's open, copy, fullscreen and
 * storage, driven the way a game drives them. Published as `window.__host`; nothing is on the
 * page until a spec calls `mount()`, so the platform smoke sees the bare harness.
 */
import { createWebHost, type Host } from '@thunderclap/engine/host';
import type { CopyResult, LinkActivation, OpenResult } from '@thunderclap/engine/platform';
import { createSaveStore, s } from '@thunderclap/engine/save';
import {
  activateLink,
  type ExternalLink,
  ensureStyles,
  externalLink,
} from '@thunderclap/engine/ui';
import type { HarnessHostInfo, HarnessHostProbe, HarnessSaveResult } from './state';

/** The probe's link. The specs fulfil it locally, so no request leaves the machine. */
export const PROBE_URL = 'https://harness.example/thunderclap';

const SaveData = s.object({ n: s.number() });

export function createHostProbe(): HarnessHostProbe {
  const web = createWebHost();
  const copies: CopyResult[] = [];
  const opens: OpenResult[] = [];
  const fullscreen: boolean[] = [];
  // The game's view of the host, recording what came back.
  const host: Host = {
    ...web,
    get embed() {
      return web.embed;
    },
    openExternal(url, o) {
      const r = web.openExternal(url, o);
      opens.push(r);
      return r;
    },
    async copyText(text) {
      const r = await web.copyText(text);
      copies.push(r);
      return r;
    },
  };
  let link: ExternalLink | null = null;

  const info = (): HarnessHostInfo => ({
    kind: host.kind,
    embed: host.embed,
    storage: host.storage.open() !== null,
    clipboardWriteAllowed: host.clipboardWriteAllowed(),
    fullscreenAvailable: host.fullscreen.available(),
    fullscreenActive: host.fullscreen.active(),
    copies: [...copies],
    opens: [...opens],
    fullscreen: [...fullscreen],
  });

  const store = () =>
    createSaveStore({
      game: 'harness',
      slot: 'host',
      version: 1,
      defaults: () => ({ n: 0 }),
      schema: SaveData,
      host,
      debounceMs: 0,
      autoFlush: false,
    });
  const saveResult = (st: ReturnType<typeof store>): HarnessSaveResult => ({
    persistent: st.persistent,
    loadResult: st.status.loadResult,
    error: st.status.error,
    n: st.get().n,
  });

  return {
    info,
    mount() {
      if (link) return;
      const doc = document;
      ensureStyles(doc);
      link = externalLink({
        url: PROBE_URL,
        content: 'Visit the harness',
        host,
        action: 'probe-link',
        place: 'below',
        align: 'start',
        labels: {
          copy: 'Copy link',
          copied: 'Copied!',
          copiedAnnounce: 'Link copied.',
          copyBlocked: 'Copy blocked. Copy the link:',
          popupBlocked: 'New tab blocked. Copy the link:',
          close: 'Close',
        },
      });
      const fs = doc.createElement('button');
      fs.type = 'button';
      fs.dataset.action = 'probe-fullscreen';
      fs.textContent = 'Fullscreen';
      fs.addEventListener('click', () => void host.fullscreen.toggle());
      host.fullscreen.watch((on) => fullscreen.push(on));
      const panel = doc.createElement('div');
      panel.id = 'host-probe';
      panel.style.cssText =
        'position:fixed;left:8px;top:8px;z-index:10;display:flex;gap:12px;align-items:flex-start;' +
        'font:16px system-ui;color:#fff;';
      if (link) panel.append(link.element);
      panel.append(fs);
      doc.body.append(panel);
    },
    activate(activation: LinkActivation) {
      return link ? activateLink(link.anchor, activation) : null;
    },
    save(n: number) {
      const st = store();
      st.set({ n });
      st.flush();
      return saveResult(st);
    },
    load() {
      return saveResult(store());
    },
    clearSave() {
      store().clear();
    },
  };
}
