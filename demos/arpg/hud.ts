/**
 * The HUD: health and mana orbs either side of a four-slot ability row with cooldown sweeps
 * (`ui.slots` + `cooldown`), a gear button row at the top, and the per-enemy pieces (an
 * anchored health bar each, a pool of floating damage numbers). The orbs are hand-made DOM
 * (`ui.meter` has no orb shape) and the numbers rise by hand (there is no `ui.floats`).
 * Updates write the DOM only when a rounded value changes, so a steady frame allocates nothing.
 */
import { type AnchorHandle, type Anchors, button, cooldown, h } from '@thunderclap/engine/ui';

const CSS = `
.arpg-orb { position: relative; width: 112px; height: 112px; border-radius: 50%; overflow: hidden;
  border: 3px solid #3b2a1c; box-shadow: 0 0 0 2px #120a06, inset 0 0 18px #000c; background: #0d0a10;
  pointer-events: none; }
.arpg-orb-fill { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; transform-origin: bottom;
  transition: transform 120ms linear; }
.arpg-orb[data-kind="health"] .arpg-orb-fill { background: radial-gradient(circle at 40% 30%, #ff6b5a, #9c1010 60%, #4a0505); }
.arpg-orb[data-kind="mana"] .arpg-orb-fill { background: radial-gradient(circle at 40% 30%, #7fb4ff, #1b3fa8 60%, #0a1446); }
.arpg-orb-gloss { position: absolute; inset: 8% 22% 55% 18%; border-radius: 50%;
  background: linear-gradient(#ffffff55, #ffffff00); }
.arpg-orb-text { position: absolute; inset: 0; display: grid; place-items: center; color: #fff;
  font: 700 18px/1 system-ui, sans-serif; text-shadow: 0 1px 2px #000; }
.arpg-ability { position: relative; width: 100%; height: 100%; display: grid; place-items: center; }
.arpg-ability .tc-ui-cooldown { position: absolute; inset: 0; }
.arpg-ability-name { position: relative; color: #f3e6cf; font: 600 12px/1.1 system-ui, sans-serif;
  text-align: center; text-shadow: 0 1px 2px #000; }
.arpg-gear { display: flex; gap: 8px; }
.arpg-gear [aria-pressed="true"] { outline: 2px solid #f5c15b; }
.arpg-bar { width: 54px; height: 6px; background: #000a; border: 1px solid #000; border-radius: 2px;
  overflow: hidden; pointer-events: none; }
.arpg-bar > div { height: 100%; background: linear-gradient(#ff7a5c, #b3221a); transform-origin: left; }
.arpg-dmg { color: #ffd35a; font: 800 22px/1 system-ui, sans-serif; text-shadow: 0 2px 3px #000, 0 0 6px #a40;
  pointer-events: none; }
`;

/** Precomputed opacity strings, so fading a number allocates no string per frame. */
const OPACITY: string[] = [];
for (let i = 0; i <= 20; i++) OPACITY.push(String(i / 20));

export interface Orb {
  el: HTMLElement;
  set(value: number, max: number): void;
}

export function injectCss(doc: Document): void {
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);
}

export function orb(kind: 'health' | 'mana', label: string): Orb {
  const fill = h('div', { class: 'arpg-orb-fill' });
  const text = h('div', { class: 'arpg-orb-text' });
  const el = h(
    'div',
    { class: 'arpg-orb', 'data-kind': kind, role: 'meter', 'aria-label': label },
    fill,
    h('div', { class: 'arpg-orb-gloss' }),
    text,
  );
  let shown = -1;
  return {
    el,
    set(value, max) {
      const v = Math.max(0, Math.round(value));
      if (v === shown) return;
      shown = v;
      fill.style.transform = `scaleY(${v / max})`;
      text.textContent = String(v);
      el.setAttribute('aria-valuenow', String(v));
    },
  };
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

/** Floating damage numbers: a fixed pool of anchors, each rising and fading for `LIFE` seconds. */
export class DamageNumbers {
  private static readonly LIFE = 0.9;
  private readonly items: {
    handle: AnchorHandle;
    el: HTMLElement;
    age: number;
    x: number;
    y: number;
    z: number;
    shownOpacity: number;
  }[] = [];
  private readonly at = new Float32Array(3);
  private next = 0;

  constructor(anchors: Anchors, count: number) {
    for (let i = 0; i < count; i++) {
      const el = h('div', { class: 'arpg-dmg' });
      el.style.display = 'none';
      const handle = anchors.add(el, this.at, { align: [0.5, 1] });
      this.items.push({ handle, el, age: -1, x: 0, y: 0, z: 0, shownOpacity: -1 });
    }
  }

  /** Live numbers (for the spec). */
  get alive(): number {
    let n = 0;
    for (const it of this.items) if (it.age >= 0) n++;
    return n;
  }

  spawn(text: string, x: number, y: number, z: number): void {
    const it = this.items[this.next]!;
    this.next = (this.next + 1) % this.items.length;
    it.el.textContent = text;
    it.el.style.display = '';
    it.age = 0;
    it.x = x + (Math.random() - 0.5) * 0.3;
    it.y = y;
    it.z = z;
    it.shownOpacity = -1;
  }

  update(dt: number): void {
    const life = DamageNumbers.LIFE;
    for (const it of this.items) {
      if (it.age < 0) continue;
      it.age += dt;
      if (it.age >= life) {
        it.age = -1;
        it.el.style.display = 'none';
        continue;
      }
      const t = it.age / life;
      this.at[0] = it.x;
      this.at[1] = it.y + 1.4 * t;
      this.at[2] = it.z;
      it.handle.set(this.at);
      const o = Math.round((1 - t * t) * 20);
      if (o !== it.shownOpacity) {
        it.shownOpacity = o;
        it.el.style.opacity = OPACITY[o]!;
      }
    }
  }
}
