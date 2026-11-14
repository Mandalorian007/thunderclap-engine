/**
 * The head-following screen (ws/ui-world): in a headset the HUD and modals ride one world panel
 * that follows the head lazily (it stays put until the view turns away, then eases back in front),
 * drawn by the world presenter. The same `SpecHud` and spec panels the page shows with
 * `presentHud` and `presentModal` go here with `presentWorldHud` and `presentWorldModal`: same
 * words, same model, same events; only the surface differs.
 */

import type { Renderer } from '../../render/renderer';
import type { RegionName } from '../layout';
import type { PanelRect } from '../world-panel/layout';
import type { Painter, PanelCanvas } from '../world-panel/paint';
import { WorldPanel } from '../world-panel/panel';
import { WorldWidget } from '../world-panel/widgets';
import type { SpecHud } from './hud';
import type { SpecPanel } from './panel';
import { presentWorld, type WorldOptions, type WorldPresenter } from './present-world';

/** How the screen sits in front of the head. */
export interface WorldScreenOptions {
  /** Size in world units (metres in a headset): default 1.6 by 0.9. */
  width?: number;
  height?: number;
  /** Canvas px per world unit (default 800). */
  resolution?: number;
  /** How far ahead of the eye (default 1.2). */
  distance?: number;
  /**
   * How far the view may turn before the screen follows, radians (default 0.35, about 20°); 0
   * locks it to the head rigidly.
   */
  lazy?: number;
  /** The share of the gap closed per update while it follows (default 0.12). */
  ease?: number;
  label?: string;
  /** The canvas it draws on (default: a new one; tests pass a stub). */
  canvas?: PanelCanvas;
}

/**
 * A head-following screen: a transparent, head-locked world panel with no depth test (always on
 * top of the scene), following lazily; rays pass through its empty parts. Attach it to the input (`screen.attach(input)`) for its
 * rays and its head camera; draw it as any drawable.
 */
export function worldScreen(renderer: Renderer, opts: WorldScreenOptions = {}): WorldPanel {
  return new WorldPanel(renderer, {
    width: opts.width ?? 1.6,
    height: opts.height ?? 0.9,
    resolution: opts.resolution ?? 800,
    background: 'transparent',
    depthTest: false,
    hitEmpty: false,
    headLocked: {
      distance: opts.distance ?? 1.2,
      lazy: opts.lazy ?? 0.35,
      ease: opts.ease ?? 0.12,
    },
    label: opts.label ?? 'world-screen',
    ...(opts.canvas ? { canvas: opts.canvas } : {}),
  });
}

/** A HUD on a world screen. */
export interface WorldHudView {
  readonly presenters: readonly WorldPresenter[];
  dispose(): void;
}

/** How `presentWorldHud` draws. */
export type WorldHudOptions = Omit<WorldOptions, 'rect' | 'fit' | 'w' | 'place'> & {
  /** The gap from the screen's edges and between items, canvas px (default 16). */
  margin?: number;
};

interface HudSlot {
  readonly presenter: WorldPresenter;
  readonly region: RegionName;
  readonly order: number;
  w: number;
  h: number;
  readonly rect: PanelRect;
}

/** The region an item takes in a headset: its `desktop` place, else its `default` (a free one: `fill`). */
function regionOf(place: SpecHud['items'][number]['place']): RegionName | null {
  const p = place.desktop ?? place.default;
  if (p === undefined || p === 'hidden') return null;
  return typeof p === 'string' ? p : 'fill';
}

/**
 * Draws hud `h` on world screen `screen` (ws/ui-world): each item a world presenter at its
 * natural size in its region (its `desktop` place: top and bottom rows centred, left and right
 * columns, the card and caption lanes beside and above them, the fill and modal regions at the
 * centre), placed again whenever one's size changes.
 */
export function presentWorldHud(
  h: SpecHud,
  screen: WorldPanel,
  opts: WorldHudOptions = {},
): WorldHudView {
  const { margin = 16, ...world } = opts;
  const slots: HudSlot[] = [];
  const W = screen.pxWidth;
  const H = screen.pxHeight;
  const arrange = (): void => {
    const byRegion = new Map<RegionName, HudSlot[]>();
    for (const s of slots) {
      let a = byRegion.get(s.region);
      if (!a) {
        a = [];
        byRegion.set(s.region, a);
      }
      a.push(s);
    }
    for (const s of slots) {
      s.rect.w = s.w;
      s.rect.h = s.h;
    }
    for (const [region, list] of byRegion) {
      list.sort((a, b) => a.order - b.order);
      const row = region === 'top' || region === 'bottom' || region === 'captionLane';
      if (row) {
        const total = list.reduce((n, s) => n + s.w, 0) + margin * (list.length - 1);
        let x = Math.round((W - total) / 2);
        const tallest = list.reduce((n, s) => Math.max(n, s.h), 0);
        for (const s of list) {
          s.rect.x = x;
          s.rect.y =
            region === 'top'
              ? margin
              : region === 'bottom'
                ? H - margin - s.h
                : H - margin * 2 - s.h - bottomH(byRegion, margin) - (tallest - s.h);
          x += s.w + margin;
        }
      } else if (region === 'left' || region === 'right' || region === 'cardLane') {
        let y = margin + topH(byRegion, margin);
        for (const s of list) {
          s.rect.x =
            region === 'left'
              ? margin
              : W -
                margin -
                s.w -
                (region === 'cardLane' ? colW(byRegion.get('right'), margin) : 0);
          s.rect.y = y;
          y += s.h + margin;
        }
      } else {
        const total = list.reduce((n, s) => n + s.h, 0) + margin * (list.length - 1);
        let y = Math.round((H - total) / 2);
        for (const s of list) {
          s.rect.x = Math.round((W - s.w) / 2);
          s.rect.y = y;
          y += s.h + margin;
        }
      }
    }
  };
  const presenters: WorldPresenter[] = [];
  h.items.forEach((item, i) => {
    const region = regionOf(item.place);
    if (!region) return;
    const p = h.panels[i]!;
    let slot: HudSlot | null = null;
    const presenter = presentWorld(p, screen, {
      ...world,
      fit: 'natural',
      w: item.w ?? 0,
      place: (w, hh, out) => {
        if (!slot) return;
        slot.w = w;
        slot.h = hh;
        arrange();
        out.x = slot.rect.x;
        out.y = slot.rect.y;
        // The others in its region moved with it.
        for (const s of slots) if (s !== slot && s.w > 0) s.presenter.setRect(s.rect);
      },
    });
    slot = {
      presenter,
      region,
      order: item.order ?? 0,
      w: 0,
      h: 0,
      rect: { x: 0, y: 0, w: 0, h: 0 },
    };
    slots.push(slot);
    presenters.push(presenter);
  });
  h.apply();
  return {
    presenters,
    dispose() {
      for (const d of presenters) d.dispose();
    },
  };
}

function topH(by: Map<RegionName, HudSlot[]>, margin: number): number {
  const top = by.get('top');
  return top ? top.reduce((n, s) => Math.max(n, s.h), 0) + margin : 0;
}

function bottomH(by: Map<RegionName, HudSlot[]>, margin: number): number {
  const b = by.get('bottom');
  return b ? b.reduce((n, s) => Math.max(n, s.h), 0) + margin : 0;
}

function colW(list: HudSlot[] | undefined, margin: number): number {
  return list ? list.reduce((n, s) => Math.max(n, s.w), 0) + margin : 0;
}

/** The dim behind a world modal: it takes every press outside the panel. */
class Backdrop extends WorldWidget {
  onPress: (() => void) | null = null;
  constructor(r: PanelRect) {
    super({});
    this.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  measure(): number {
    return this.layoutRect.h;
  }
  paint(p: Painter, r: PanelRect): void {
    p.ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    p.ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  override pointerUp(_x: number, _y: number, inside: boolean): void {
    if (inside) this.onPress?.();
  }
}

/** How `presentWorldModal` opens a panel. */
export type WorldModalOptions = Omit<WorldOptions, 'rect' | 'fit' | 'place' | 'onEscape'> & {
  /** Called once it closes: `escape`, `backdrop` (a press outside it) or `close` (`close()`). */
  onClose?: (reason: 'escape' | 'backdrop' | 'close') => void;
  /** A press outside it closes it (default true). */
  dismissable?: boolean;
};

/** A panel open on a world screen. */
export interface WorldModal {
  readonly presenter: WorldPresenter;
  readonly open: boolean;
  close(): void;
}

/**
 * Opens `p` on `screen` as a modal (ws/ui-world), the page's `presentModal` in a headset: centred
 * at its natural size over a dim that takes presses outside it, focus on its first word and kept
 * in it (Tab wraps), Escape and a press outside close it. Its presenter goes when it closes.
 */
export function presentWorldModal(
  screen: WorldPanel,
  p: SpecPanel,
  opts: WorldModalOptions = {},
): WorldModal {
  const { onClose, dismissable = true, ...world } = opts;
  const W = screen.pxWidth;
  const H = screen.pxHeight;
  const back = new Backdrop({ x: 0, y: 0, w: W, h: H });
  screen.add(back);
  let open = true;
  const close = (reason: 'escape' | 'backdrop' | 'close'): void => {
    if (!open) return;
    open = false;
    presenter.dispose();
    screen.remove(back);
    onClose?.(reason);
  };
  const presenter = presentWorld(p, screen, {
    ...world,
    fit: 'natural',
    w: opts.w ?? Math.max(p.w, 0),
    place: (w, h, out) => {
      out.x = Math.round((W - w) / 2);
      out.y = Math.round((H - h) / 2);
    },
    onEscape: () => close('escape'),
  });
  if (dismissable) back.onPress = () => close('backdrop');
  p.apply();
  presenter.focusFirst();
  return {
    presenter,
    get open() {
      return open;
    },
    close: () => close('close'),
  };
}
