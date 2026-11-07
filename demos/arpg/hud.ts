/**
 * The HUD's hand-made pieces: the ability slot content with a cooldown sweep (`ui.slots` +
 * `cooldown`), the gear button row, the "watch replay" button, an anchored health bar per
 * enemy, and the painted courtyard the minimap draws. The orbs (`ui.meter({ shape: 'orb' })`),
 * the damage numbers (`ui.floats`) and the minimap (`ui.minimap`) are engine calls in `main.ts`
 * (ws/ui-6).
 * Updates write the DOM only when a rounded value changes, so a steady frame allocates nothing.
 */
import { type AnchorHandle, type Anchors, button, cooldown, h } from '@thunderclap/engine/ui';

const CSS = `
.arpg-ability { position: relative; width: 100%; height: 100%; display: grid; place-items: center; }
.arpg-ability .tc-ui-cooldown { position: absolute; inset: 0; }
.arpg-ability-name { position: relative; color: #f3e6cf; font: 600 12px/1.1 system-ui, sans-serif;
  text-align: center; text-shadow: 0 1px 2px #000; }
.arpg-gear { display: flex; gap: 8px; }
.arpg-gear [aria-pressed="true"] { outline: 2px solid #f5c15b; }
.arpg-bar { width: 54px; height: 6px; background: #000a; border: 1px solid #000; border-radius: 2px;
  overflow: hidden; pointer-events: none; }
.arpg-bar > div { height: 100%; background: linear-gradient(#ff7a5c, #b3221a); transform-origin: left; }
`;

export function injectCss(doc: Document): void {
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);
}

export interface Ability {
  content: HTMLElement;
  /** 0 just used .. 1 ready. */
  set(fraction: number): void;
}

export function ability(name: string): Ability {
  const sweep = cooldown({ size: 64 });
  const content = h(
    'div',
    { class: 'arpg-ability' },
    sweep.element,
    h('span', { class: 'arpg-ability-name' }, name),
  );
  let shown = -1;
  return {
    content,
    set(f) {
      const q = Math.round(f * 50) / 50;
      if (q === shown) return;
      shown = q;
      sweep.set(q);
    },
  };
}

export function gearButtons(names: readonly string[], pick: (i: number) => void) {
  const buttons = names.map((n, i) =>
    button(`${i + 1} ${n}`, () => pick(i), { ariaLabel: `Gear set ${n}` }),
  );
  for (const [i, b] of buttons.entries()) b.dataset.gear = String(i);
  const el = h('div', { class: 'arpg-gear', role: 'group', 'aria-label': 'Gear sets' }, ...buttons);
  return {
    el,
    select(i: number) {
      for (const [k, b] of buttons.entries()) b.setAttribute('aria-pressed', String(k === i));
    },
  };
}

/** The "watch replay" button (P): disabled while a replay plays. */
export function replayButton(watch: () => void) {
  const el = button('P Watch replay', watch, { ariaLabel: 'Watch replay' });
  el.id = 'arpg-replay';
  return {
    el,
    playing(on: boolean) {
      el.disabled = on;
    },
  };
}

/** An enemy's health bar, anchored above its head. */
export interface HealthBar {
  handle: AnchorHandle;
  set(fraction: number): void;
  show(on: boolean): void;
}

export function healthBar(anchors: Anchors, at: ArrayLike<number>): HealthBar {
  const fill = h('div', {});
  const el = h('div', { class: 'arpg-bar' }, fill);
  const handle = anchors.add(el, at, { align: [0.5, 1] });
  let shown = -1;
  let visible = true;
  return {
    handle,
    set(f) {
      if (f === shown) return;
      shown = f;
      fill.style.transform = `scaleX(${f})`;
    },
    show(on) {
      if (on === visible) return;
      visible = on;
      el.style.display = on ? '' : 'none';
    },
  };
}

/**
 * The courtyard as the minimap's background, painted once over the world square ±`half`: the
 * flagstone floor, the wall band, the dais and a glow under each brazier.
 */
export function paintCourtyard(
  doc: Document,
  half: number,
  dais: { x: number; z: number; w: number; d: number },
  braziers: readonly { x: number; z: number }[],
): HTMLCanvasElement {
  const px = 4; // canvas px per world unit
  const size = Math.round(half * 2 * px);
  const c = doc.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return c;
  const at = (v: number) => (v + half) * px;
  g.fillStyle = '#3a3340';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = '#2a2430';
  g.lineWidth = 1;
  for (let v = 0; v <= size; v += 2 * px * 2) {
    g.beginPath();
    g.moveTo(v, 0);
    g.lineTo(v, size);
    g.moveTo(0, v);
    g.lineTo(size, v);
    g.stroke();
  }
  g.strokeStyle = '#18121c';
  g.lineWidth = 2 * px;
  g.strokeRect(px, px, size - 2 * px, size - 2 * px);
  g.fillStyle = '#5a4c5e';
  g.fillRect(at(dais.x - dais.w / 2), at(dais.z - dais.d / 2), dais.w * px, dais.d * px);
  for (const b of braziers) {
    const r = 3 * px;
    const glow = g.createRadialGradient(at(b.x), at(b.z), 0, at(b.x), at(b.z), r);
    glow.addColorStop(0, '#ffb14acc');
    glow.addColorStop(1, '#ffb14a00');
    g.fillStyle = glow;
    g.fillRect(at(b.x) - r, at(b.z) - r, r * 2, r * 2);
  }
  return c;
}
