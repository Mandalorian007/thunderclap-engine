/**
 * The CSS-px overlay beside the legacy one (D-041 Phase 2, ws/port-chrome): how a game ports
 * its scenes to layout regions one form factor at a time while scenes that are not ported keep
 * the scaled design-px overlay.
 *
 * - `legacy` is the game's existing overlay (`createOverlay()`, scaled, over the canvas rect). It
 *   keeps the one `PanelStack`, `Toaster` and `CaptionCard` every scene already uses, so pad
 *   navigation, input blocking and caption suspension are unchanged.
 * - `ui` is a second overlay in CSS-px mode over the whole container (letterbox bars included),
 *   stacked above `legacy`, with `layout` (`createLayout`) on it. Its own stack, toasts and
 *   caption are not used: they are idle and stay empty.
 * - `active` is true while the layout's form factor is one of `forms`. While active, the legacy
 *   overlay's `panels` and `toasts` layers are moved into `ui`'s root (above its regions), so
 *   every panel and toast lays out in CSS px with the layout's tokens, and `ui.root` is shown.
 *   While inactive they are back in the legacy root, `ui.root` is hidden and nothing about the
 *   legacy overlay differs from a game without this.
 * - Under a modal panel, `ui`'s hud and caption layers go inert like the legacy ones.
 *
 * Scenes register widgets with `layout.add()` (and the legacy caption with
 * `layout.dockCaption(legacy.caption)`) while active, and remove them on exit or when `active`
 * turns off: `WidgetHandle.remove()` returns an element to where it was before `add`.
 */

import { createLayout, type FormFactor, type Layout, type LayoutSpec } from './layout';
import { createOverlay, type Overlay } from './overlay';

export interface CssChromeOptions {
  /** The container both overlays sit in (the surface root). */
  parent: HTMLElement;
  /** The game's legacy overlay. */
  legacy: Overlay;
  /** Form factors that use the CSS-px overlay. Default: both phone form factors. */
  forms?: readonly FormFactor[];
  /** Region tracks per form factor (see `createLayout`). */
  layout?: LayoutSpec;
  /** Where focus goes when the last panel closes (see `OverlayOptions.focusHome`). */
  focusHome?: () => HTMLElement | null;
}

export interface CssChrome {
  /** The CSS-px overlay (`data-units="css"`), over the whole container. */
  readonly ui: Overlay;
  readonly layout: Layout;
  /** The current form factor uses the CSS-px overlay. */
  readonly active: boolean;
  /** Called when `active` changes (after the panels and toasts layers have moved). */
  onChange(fn: (active: boolean) => void): () => void;
  /** Re-measure the container (call on every resize; `createGame` does). */
  resize(): void;
  destroy(): void;
}

export const PHONE_FORMS: readonly FormFactor[] = ['phone-landscape', 'phone-portrait'];

export function createCssChrome(opts: CssChromeOptions): CssChrome {
  const { parent, legacy } = opts;
  const forms = new Set(opts.forms ?? PHONE_FORMS);
  const ui = createOverlay({ parent, legacyScale: false, focusHome: opts.focusHome });
  const measure = () => ({ x: 0, y: 0, width: parent.clientWidth, height: parent.clientHeight });
  ui.setRect(measure());
  const layout = createLayout(ui, opts.layout);
  ui.root.dataset.chrome = '';

  let active = false;
  const subs = new Set<(a: boolean) => void>();
  const sync = () => {
    const a = forms.has(layout.formFactor);
    if (a === active) return;
    active = a;
    ui.root.hidden = !a;
    const { panels, toasts } = legacy.layers;
    if (a) ui.root.append(panels, toasts);
    else legacy.root.append(panels, toasts);
    for (const f of subs) f(a);
  };
  ui.root.hidden = true;
  const offLayout = layout.onChange(sync);
  sync();

  const inert = [ui.layers.hud, ui.layers.captions];
  const offStack = legacy.stack.onChange((s) => {
    for (const el of inert) {
      el.inert = s.hasModal;
      el.toggleAttribute('inert', s.hasModal);
    }
  });

  return {
    ui,
    layout,
    get active() {
      return active;
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    resize() {
      ui.setRect(measure());
    },
    destroy() {
      offLayout();
      offStack();
      subs.clear();
      if (active) legacy.root.append(legacy.layers.panels, legacy.layers.toasts);
      layout.destroy();
      ui.destroy();
    },
  };
}
