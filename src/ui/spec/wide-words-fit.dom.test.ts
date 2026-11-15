// @vitest-environment happy-dom
// A panel with button words wider than its frame (EV FX3, Forge on 2.0): the measure keeps every
// box inside the width it is framed at (the words end in an ellipsis, they never widen a box),
// and a laid-out host's size settles: an apply from inside the host's ResizeObserver writes
// nothing that would resize what it observes, so no notification loops.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { panel, type SpecPanel } from './panel';
import { presentDom } from './present-dom';
import type { PanelSpec } from './words';

let p: SpecPanel | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  p?.dispose();
  host?.remove();
  p = host = null;
  vi.unstubAllGlobals();
});

const LONG = 'Gather everyone at the far door and go down together, all of you';
const SPEC: PanelSpec = {
  id: 'door',
  body: {
    k: 'col',
    pad: 8,
    gap: 6,
    children: [
      { k: 'text', id: 'say', text: LONG, style: 'body', wrap: true },
      { k: 'button', id: 'go', text: LONG, h: 40 },
      {
        k: 'row',
        gap: 6,
        children: [
          { k: 'button', id: 'a', text: LONG, h: 32 },
          { k: 'button', id: 'b', text: 'Back', h: 32 },
        ],
      },
    ],
  },
};

/** Every box's right edge, in the panel's frame (a child's x is its parent's plus its own). */
function rights(q: SpecPanel): number[] {
  const bx = q.boxes;
  const c = q.spec;
  const out: number[] = [];
  for (let i = 0; i < c.n; i++) {
    let x = 0;
    for (let j = i; j !== -1; j = c.parent[j]!) x += bx.x[j]!;
    out.push(x + bx.w[i]!);
  }
  return out;
}

describe('wide button words in a framed panel (FX3)', () => {
  it("measures every box inside the frame's width, and writes the host that width once", () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    p = panel(SPEC, { schedule: null });
    const d = presentDom(p, host);
    p.frame(250, 0);
    p.apply();
    expect(p.boxes.w[0]).toBe(250);
    for (const r of rights(p)) expect(r).toBeLessThanOrEqual(250);
    expect(host.style.width).toBe('250px');
    const h = host.style.height;
    expect(Number.parseFloat(h)).toBeGreaterThan(0);
    // Framed again at its own width (an observer handing back the width it was given): no write.
    const writes = d.writes;
    p.frame(250, 0);
    p.apply();
    expect(d.writes).toBe(writes);
    expect(host.style.width).toBe('250px');
    expect(host.style.height).toBe(h);
  });

  it("settles under the host's ResizeObserver (fit 'host'): an apply in its callback leaves the host's size alone", () => {
    const observers: { cb: () => void; on: Element[] }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        on: Element[] = [];
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
          observers.push(this);
        }
        observe(el: Element) {
          this.on.push(el);
        }
        disconnect() {}
      },
    );
    host = document.createElement('div');
    host.style.width = '250px';
    host.style.height = '160px';
    document.body.appendChild(host);
    const box = { width: 250, height: 160 };
    host.getBoundingClientRect = () => ({ ...box, x: 0, y: 0, left: 0, top: 0, right: box.width, bottom: box.height, toJSON() {} }) as DOMRect;
    p = panel(SPEC, { schedule: null });
    presentDom(p, host, { fit: 'host' });
    const ro = observers.find((o) => o.on.includes(host!))!;
    expect(ro).toBeDefined();
    // The observer's callback, as the page sends it, with the panel's apply in the same task.
    const notify = () => {
      ro.cb();
      p!.apply();
    };
    notify();
    expect(p.boxes.w[0]).toBe(250);
    for (const r of rights(p)) expect(r).toBeLessThanOrEqual(250);
    // What the observer watches is not resized by its own callback: the next notification would find no change.
    expect(host.style.width).toBe('250px');
    expect(host.style.height).toBe('160px');
    const at = rights(p);
    notify();
    expect(rights(p)).toEqual(at);
    expect(host.style.width).toBe('250px');
  });
});
