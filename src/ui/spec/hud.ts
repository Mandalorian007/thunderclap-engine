/**
 * A HUD and a modal from specs (ws/ui-spec): `hud(spec)` makes one panel per item, each with its
 * own model; `presentHud(h, ui)` draws each in today's overlay layout (`ui.layout.add`, so the
 * form factor's regions and safe areas place it) at the overlay's scale, and `presentModal(ui, p)`
 * opens a panel on the overlay's panel stack (its focus trap, Escape and focus return).
 */

import type { LayoutState, WidgetHandle, WidgetOptions } from '../layout';
import type { Overlay } from '../overlay';
import type { PanelHandle, PanelOptions } from '../stack';
import { panel, type SpecPanel, type SpecPanelOptions } from './panel';
import { type DomOptions, type DomPresenter, presentDom } from './present-dom';
import type { PanelEvent, PanelSpec } from './words';

/** One HUD panel: its words and where today's layout puts it. */
export interface HudItem {
  readonly spec: PanelSpec;
  /** Its placement per form factor (`WidgetOptions.place`). */
  readonly place: WidgetOptions['place'];
  /** Its order in its region. */
  readonly order?: number;
  /** Its width in units (0 or unset: its natural width). */
  readonly w?: number;
}

/** A HUD: panels placed in the overlay's regions. */
export interface HudSpec {
  readonly items: readonly HudItem[];
}

/** A HUD's panels (`hud(spec)`), one model each. */
export class SpecHud {
  readonly items: readonly HudItem[];
  readonly panels: readonly SpecPanel[];
  /** Every panel's events. */
  onEvent: ((e: PanelEvent) => void) | null = null;
  private readonly byId = new Map<string, SpecPanel>();

  constructor(spec: HudSpec, opts: SpecPanelOptions = {}) {
    this.items = spec.items;
    const panels: SpecPanel[] = [];
    for (const item of spec.items) {
      if (this.byId.has(item.spec.id)) throw new Error(`hud: two panels ${item.spec.id}`);
      const p = panel(item.spec, opts);
      p.onEvent = (e) => this.onEvent?.(e);
      this.byId.set(item.spec.id, p);
      panels.push(p);
    }
    this.panels = panels;
  }

  /** Panel `id`. */
  get(id: string): SpecPanel {
    const p = this.byId.get(id);
    if (!p) throw new Error(`hud: no panel ${id}`);
    return p;
  }

  /** Every panel's apply (a host without a scheduler calls it once a frame). */
  apply(): void {
    for (let i = 0; i < this.panels.length; i++) this.panels[i]!.apply();
  }

  dispose(): void {
    for (const p of this.panels) p.dispose();
  }
}

/** A HUD from `spec`: a panel per item (none drawn until `presentHud`). */
export function hud(spec: HudSpec, opts: SpecPanelOptions = {}): SpecHud {
  return new SpecHud(spec, opts);
}

/** What `presentHud` and `presentModal` need of the overlay. */
export type SpecOverlay = Pick<
  Overlay,
  'root' | 'layout' | 'units' | 'scale' | 'onResize' | 'stack'
>;

/**
 * CSS px per spec unit on `ui` now: 1 in `css` units; in `frame` units the overlay's scale (CSS
 * px per design px) times 2 (a design px is about half a unit: the 1920-wide frame).
 */
export function specScale(ui: Pick<Overlay, 'units' | 'scale'>): number {
  return ui.units === 'css' ? 1 : ui.scale * 2;
}

/** A HUD on the page. */
export interface HudView {
  readonly presenters: readonly DomPresenter[];
  readonly widgets: readonly WidgetHandle[];
  dispose(): void;
}

/**
 * Draws `h` in `ui`'s layout: each panel's host added with its item's placement, framed at its
 * width, scaled with the overlay (`specScale`) on every resize and form change.
 */
export function presentHud(h: SpecHud, ui: SpecOverlay, opts: DomOptions = {}): HudView {
  const doc = ui.root.ownerDocument;
  const presenters: DomPresenter[] = [];
  const widgets: WidgetHandle[] = [];
  const scale = (): void => {
    const s = opts.scale ?? specScale(ui);
    for (const d of presenters) d.setScale(s);
  };
  ui.layout.batch(() => {
    h.items.forEach((item, i) => {
      const p = h.panels[i]!;
      const host = doc.createElement('div');
      host.id = `tc-spec-${item.spec.id}`;
      presenters.push(presentDom(p, host, { ...opts, scale: opts.scale ?? specScale(ui) }));
      p.frame(item.w ?? 0, 0, p.text);
      widgets.push(
        ui.layout.add(host, {
          place: item.place,
          id: host.id,
          ...(item.order !== undefined ? { order: item.order } : {}),
        }),
      );
    });
  });
  const offResize = ui.onResize(scale);
  const offLayout = ui.layout.onChange((_s: LayoutState) => scale());
  // Drawn now: the layout measures the hosts at their size.
  h.apply();
  return {
    presenters,
    widgets,
    dispose() {
      offResize();
      offLayout();
      for (const w of widgets) w.remove();
      for (const d of presenters) d.dispose();
    },
  };
}

/** How `presentModal` opens a panel. */
export type SpecModalOptions = Omit<PanelOptions, 'content'> & DomOptions;

/** A panel open on the overlay's stack. */
export interface SpecModal {
  readonly presenter: DomPresenter;
  readonly handle: PanelHandle;
}

/**
 * Opens `p` on `ui`'s panel stack (modal by default: focus trapped, Escape closes, focus goes
 * back): drawn at the overlay's scale, framed at its natural width unless already framed. Its
 * presenter goes when the panel closes.
 */
export function presentModal(
  ui: SpecOverlay,
  p: SpecPanel,
  opts: SpecModalOptions = {},
): SpecModal {
  const { scale, theme, fit, slotArt, timer, onClose, ...stack } = opts;
  const host = ui.root.ownerDocument.createElement('div');
  const dom: DomOptions = { scale: scale ?? specScale(ui) };
  if (theme) dom.theme = theme;
  if (fit) dom.fit = fit;
  if (slotArt) dom.slotArt = slotArt;
  if (timer) dom.timer = timer;
  const presenter = presentDom(p, host, dom);
  if (p.w === 0 && p.h === 0) p.frame(0, 0, p.text);
  p.apply();
  const handle = ui.stack.push({
    ...stack,
    content: host,
    onClose: (reason) => {
      presenter.dispose();
      onClose?.(reason);
    },
  });
  return { presenter, handle };
}
