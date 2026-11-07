/**
 * Save harness page: `@thunderclap-engine/engine/save` with no WebGPU, so e2e/save.spec.ts can verify
 * it on every matrix row. Noun-free.
 *
 * - A slot manager with three slots; `save(n)` copies the working tilemap into slot `n` with a
 *   label and the list of slots re-renders from the sidecars.
 * - A settings store (volume) bound to a range slider through `bind`.
 * - A 64×64 `Uint8Array` tilemap in the slot data (`s.bytes`), painted on a 2D canvas, with an
 *   undo journal behind the Undo and Redo buttons.
 * - `MemoryStorage` unless `?persist`, so the matrix rows never see each other's saves.
 */
import {
  createJournal,
  createSettingsStore,
  createSlotManager,
  fnv1a,
  type Infer,
  MemoryStorage,
  s,
} from '@thunderclap-engine/engine/save';
import type { HarnessSaveApi, HarnessSaveState } from './save-state';

const SIZE = 64;
const persist = new URLSearchParams(location.search).has('persist');
const storage = persist ? undefined : new MemoryStorage();

const Progress = s.object({
  label: s.string({ maxLength: 32 }),
  tiles: s.bytes({ maxLength: SIZE * SIZE }),
  paints: s.number({ int: true, min: 0 }),
});
type Progress = Infer<typeof Progress>;

const Settings = s.object({ volume: s.number({ min: 0, max: 1 }) });
type Settings = Infer<typeof Settings>;

const manager = createSlotManager<Progress>({
  game: 'harness',
  version: 1,
  defaults: () => ({ label: 'Working', tiles: new Uint8Array(SIZE * SIZE), paints: 0 }),
  schema: Progress,
  slots: 3,
  storage,
  debounceMs: 0,
  meta: (d) => ({ label: d.label, playMs: d.paints * 1000 }),
});
/** The tilemap being painted lives in slot 1; `save(n)` copies it into slot `n`. */
const work = manager.open(1);
const journal = createJournal(work);
const settings = createSettingsStore<Settings>({
  game: 'harness',
  defaults: () => ({ volume: 0.5 }),
  schema: Settings,
  storage,
});

const root = document.getElementById('root') as HTMLElement;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  id: string,
  text = '',
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.id = id;
  e.textContent = text;
  return e;
};
const left = document.createElement('div');
left.className = 'col';
const right = document.createElement('div');
right.className = 'col';
const canvas = el('canvas', 'tiles');
canvas.width = SIZE;
canvas.height = SIZE;
const ctx2d = canvas.getContext('2d') as CanvasRenderingContext2D;
const image = ctx2d.createImageData(SIZE, SIZE);
const tools = document.createElement('div');
tools.className = 'row';
const paintBtn = el('button', 'paint', 'Paint');
const undoBtn = el('button', 'undo', 'Undo');
const redoBtn = el('button', 'redo', 'Redo');
tools.append(paintBtn, undoBtn, redoBtn);
const saves = document.createElement('div');
saves.className = 'row';
for (let n = 1; n <= manager.slots; n++) {
  const b = el('button', `save-${n}`, `Save ${n}`);
  b.addEventListener('click', () => api.save(n));
  saves.append(b);
}
const list = el('ul', 'slots');
const recent = el('p', 'recent');
const volumeLabel = document.createElement('label');
const volume = el('input', 'volume');
volume.type = 'range';
volume.min = '0';
volume.max = '1';
volume.step = '0.01';
const volumeText = el('span', 'volume-text');
volumeLabel.append('Volume', volume, volumeText);
const checksum = el('p', 'checksum');
left.append(canvas, tools, checksum);
right.append(saves, list, recent, volumeLabel);
root.append(left, right);

const state: HarnessSaveState = {
  ready: false,
  persist,
  slots: [],
  mostRecent: null,
  volume: settings.get().volume,
  canUndo: false,
  canRedo: false,
  tileChecksum: '',
  painted: 0,
  paints: 0,
};

function tileChecksum(tiles: Uint8Array): string {
  let text = '';
  for (let i = 0; i < tiles.length; i += 0x2000) {
    text += String.fromCharCode.apply(null, tiles.subarray(i, i + 0x2000) as unknown as number[]);
  }
  return fnv1a(text);
}

function render(): void {
  const d = work.get();
  let painted = 0;
  for (let i = 0; i < d.tiles.length; i++) {
    const v = d.tiles[i] as number;
    if (v) painted++;
    const o = i * 4;
    image.data[o] = v ? 80 + ((v * 37) & 0x7f) : 20;
    image.data[o + 1] = v ? 160 + ((v * 59) & 0x5f) : 20;
    image.data[o + 2] = v ? 90 : 24;
    image.data[o + 3] = 255;
  }
  ctx2d.putImageData(image, 0, 0);
  state.painted = painted;
  state.paints = d.paints;
  state.tileChecksum = tileChecksum(d.tiles);
  state.canUndo = journal.canUndo;
  state.canRedo = journal.canRedo;
  state.slots = manager.list();
  state.mostRecent = manager.mostRecent();
  state.volume = settings.get().volume;
  undoBtn.disabled = !state.canUndo;
  redoBtn.disabled = !state.canRedo;
  checksum.textContent = `tiles ${state.tileChecksum} (${painted} painted, ${d.paints} paints)`;
  list.replaceChildren(
    ...state.slots.map((i) => {
      const li = document.createElement('li');
      li.id = `slot-${i.slot}`;
      li.textContent = `${i.slot}: ${i.label}, v${i.version}, ${i.size} chars, ${new Date(i.savedAt).toISOString()}`;
      return li;
    }),
  );
  recent.textContent = state.mostRecent
    ? `most recent: slot ${state.mostRecent.slot} (${state.mostRecent.label})`
    : 'no saves';
  volumeText.textContent = state.volume.toFixed(2);
}

const api: HarnessSaveApi = {
  state,
  paint(x, y, value = 1) {
    const d = work.get();
    const i = d.paints;
    const px = x ?? (i * 7) % SIZE;
    const py = y ?? (i * 13) % SIZE;
    journal.push(`paint ${i}`);
    work.update((draft) => {
      draft.tiles[py * SIZE + px] = value & 0xff;
      draft.paints++;
    });
    render();
  },
  undo() {
    const ok = journal.undo();
    render();
    return ok;
  },
  redo() {
    const ok = journal.redo();
    render();
    return ok;
  },
  save(slot) {
    const d = work.get();
    const target = slot === 1 ? work : manager.open(slot);
    target.set({ ...structuredClone(d), label: `Slot ${slot} save` });
    target.flush();
    render();
  },
  setVolume(v) {
    settings.update((d) => {
      d.volume = Math.min(1, Math.max(0, v));
    });
    render();
  },
};
window.__harnessSave = api;

paintBtn.addEventListener('click', () => api.paint());
undoBtn.addEventListener('click', () => api.undo());
redoBtn.addEventListener('click', () => api.redo());
settings.bind(volume, 'volume');
settings.subscribe(render);
work.subscribe(render);

render();
state.ready = true;
