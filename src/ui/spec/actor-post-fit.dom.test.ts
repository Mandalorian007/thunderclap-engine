// @vitest-environment happy-dom
// The DOM presenter for Forge's D4c asks (ws/actor-post-fit): a root `again` plays the host's
// own look again (no class on the host), and a tail list kept due while the embedder hid the
// host goes to its end when the host is shown (`tailsToEnd`, or the host's ResizeObserver).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { panel, type SpecPanel } from './panel';
import { type DomPresenter, presentDom } from './present-dom';
import { b, type PanelSpec } from './words';

let p: SpecPanel | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  p?.dispose();
  host?.remove();
  p = host = null;
  vi.unstubAllGlobals();
});

function make(spec: PanelSpec): DomPresenter {
  host = document.createElement('div');
  document.body.appendChild(host);
  p = panel(spec, { schedule: null });
  const d = presentDom(p, host);
  p.frame(400, 0);
  return d;
}

const anim = () => {
  const a = { playState: 'running', currentTime: 120 as number | null, play: vi.fn() };
  return a as unknown as Animation & { play: ReturnType<typeof vi.fn> };
};

describe('a root again (ws/actor-post-fit)', () => {
  const SPEC: PanelSpec = {
    id: 'hud',
    body: {
      k: 'col',
      again: b('hit'),
      children: [{ k: 'button', id: 'use', text: 'Use', again: b('bump'), w: 100, h: 40 }],
    } as PanelSpec['body'],
  };

  it("plays the host's own animations from the first change, without a class on the host", () => {
    make(SPEC);
    const h = host!;
    const own = anim();
    h.getAnimations = (o?: GetAnimationsOptions) => (o?.subtree ? [] : [own]);
    p!.model.setAll({ hit: 1, bump: 0 });
    p!.apply();
    const body = h.querySelector('.tcs-body')!;
    // The first: the body's class goes on (its animation plays as it comes); the host's replays.
    expect(body.classList.contains('tcs-again')).toBe(true);
    expect(h.classList.contains('tcs-again')).toBe(false);
    expect(own.currentTime).toBe(0);
    expect(own.play).toHaveBeenCalledTimes(1);
    own.currentTime = 300;
    p!.model.set('hit', 2);
    p!.apply();
    expect(own.currentTime).toBe(0);
    expect(own.play).toHaveBeenCalledTimes(2);
    // A word's again leaves the host alone.
    p!.model.set('bump', 1);
    p!.apply();
    p!.model.set('bump', 2);
    p!.apply();
    expect(own.play).toHaveBeenCalledTimes(2);
  });
});

function scrolling(el: HTMLElement, inner: HTMLElement, view: () => number): void {
  let top = 0;
  const content = () => Number.parseFloat(inner.style.height || '0');
  Object.defineProperty(el, 'clientHeight', { get: view, configurable: true });
  Object.defineProperty(el, 'scrollHeight', {
    get: () => Math.max(content(), view()),
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, Math.max(content(), view()) - view()));
    },
    configurable: true,
  });
}

describe('a tail list in a host the embedder hid (ws/actor-post-fit)', () => {
  const CHAT: PanelSpec = {
    id: 'chat',
    body: {
      k: 'col',
      children: [
        {
          k: 'list',
          id: 'log',
          rowH: 20,
          h: 200,
          tail: true,
          row: { k: 'text', id: 'say', text: b('row.say'), style: 'body', grow: 1 },
        },
      ],
    },
  };

  /** A log of 30 lines at its end, then the host hidden by the embedder and a line more. */
  function hiddenLine(): { d: DomPresenter; list: HTMLElement; show: () => void } {
    const d = make(CHAT);
    const list = host!.querySelector('[role=list]') as HTMLElement;
    let boxed = true;
    scrolling(list, list.firstElementChild as HTMLElement, () => (boxed ? 200 : 0));
    const keys = Array.from({ length: 30 }, (_, i) => `m${i}`);
    p!.model.setList('log', keys.slice());
    p!.apply();
    expect(list.scrollTop).toBe(30 * 20 - 200);
    host!.hidden = true;
    boxed = false;
    keys.push('m30');
    p!.model.setList('log', keys.slice());
    p!.apply();
    return {
      d,
      list,
      show: () => {
        host!.hidden = false;
        boxed = true;
      },
    };
  }

  it('goes to its end when the embedder calls tailsToEnd after showing it', () => {
    const { d, list, show } = hiddenLine();
    expect(list.scrollTop).toBe(30 * 20 - 200);
    show();
    d.tailsToEnd();
    expect(list.scrollTop).toBe(31 * 20 - 200);
    // Not due any more: a second call writes nothing.
    list.scrollTop = 0;
    d.tailsToEnd();
    expect(list.scrollTop).toBe(0);
  });

  it("goes to its end from the host's ResizeObserver, with no call", () => {
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
    const { list, show } = hiddenLine();
    // E27: its own 1×1 sentinel, not the host's box, so the page moving the host in an
    // observer step of its own leaves nothing undelivered (no "ResizeObserver loop" error).
    const sentinel = host!.querySelector('.tcs-sentinel')!;
    expect(sentinel).not.toBeNull();
    expect(observers.some((x) => x.on.includes(host!))).toBe(false);
    const o = observers.find((x) => x.on.includes(sentinel))!;
    expect(o).toBeDefined();
    show();
    o.cb();
    expect(list.scrollTop).toBe(31 * 20 - 200);
  });
});
