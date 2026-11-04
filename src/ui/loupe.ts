/**
 * Loupe: a round magnifier over a canvas, for fingers on small screens. It copies a patch of
 * the source canvas (WebGPU or 2D: whatever the page last showed) into its own small 2D canvas
 * each time `show` is called, and can ring one spot in the patch. Everything is in client (CSS)
 * px. It never takes input (`pointer-events: none`), and fades out on `hide`.
 *
 * Styling is the caller's: the root element has class `tc-loupe` (plus `className`), and is
 * `data-on` while shown.
 */
import { h } from './dom';

export interface LoupeOptions {
  /** Diameter in CSS px (default 120). */
  size?: number;
  /** Magnification (default 2.5). */
  zoom?: number;
  /** Where the loupe element goes (default document.body). It is `position: fixed`. */
  parent?: HTMLElement;
  /** Extra class names for styling. */
  className?: string;
}

export interface LoupeView {
  /** Client point the loupe is centred on (what it magnifies). */
  focus: { x: number; y: number };
  /** Client point where the loupe itself is drawn (its centre). */
  at: { x: number; y: number };
  /** Optional ring: a client point and radius (CSS px, before zoom). */
  ring?: { x: number; y: number; r: number; color?: string } | null;
  /**
   * Optional leader: a thin line from the loupe's rim to a client point and radius (the real
   * spot the loupe magnifies, outside it), so the eye joins the two. Hidden when the spot is
   * under or touching the loupe.
   */
  leader?: { x: number; y: number; r: number } | null;
}

/**
 * The leader's segment (client px) from the rim of a loupe `size` across at `at` to `r` short
 * of the spot, or `null` when there is no room for one.
 */
export function loupeLeader(
  at: { x: number; y: number },
  size: number,
  spot: { x: number; y: number; r: number },
): { x0: number; y0: number; x1: number; y1: number } | null {
  const dx = spot.x - at.x;
  const dy = spot.y - at.y;
  const d = Math.hypot(dx, dy);
  const from = size / 2 + 1;
  const to = d - spot.r - 2;
  if (to - from < 6) return null;
  const ux = dx / d;
  const uy = dy / d;
  return { x0: at.x + ux * from, y0: at.y + uy * from, x1: at.x + ux * to, y1: at.y + uy * to };
}

export class Loupe {
  readonly el: HTMLElement;
  readonly size: number;
  readonly zoom: number;
  private readonly cv: HTMLCanvasElement;
  /** The leader line (`tc-loupe-leader`), a sibling of the loupe so it draws outside it. */
  readonly leaderEl: HTMLElement;
  private readonly g: CanvasRenderingContext2D | null;
  private on = false;
  private pending: { view: LoupeView; px: number; dpr: number } | null = null;

  constructor(
    private readonly source: HTMLCanvasElement,
    opts: LoupeOptions = {},
  ) {
    this.size = opts.size ?? 120;
    this.zoom = opts.zoom ?? 2.5;
    const doc = source.ownerDocument;
    this.cv = h('canvas', { 'aria-hidden': 'true' });
    this.el = h(
      'div',
      {
        class: `tc-loupe${opts.className ? ` ${opts.className}` : ''}`,
        'aria-hidden': 'true',
        style: {
          position: 'fixed',
          left: '0px',
          top: '0px',
          width: `${this.size}px`,
          height: `${this.size}px`,
          pointerEvents: 'none',
          opacity: '0',
        },
      },
      this.cv,
    );
    Object.assign(this.cv.style, { width: '100%', height: '100%', display: 'block' });
    this.g = this.cv.getContext('2d');
    this.leaderEl = h('div', {
      class: `tc-loupe-leader${opts.className ? ` ${opts.className}-leader` : ''}`,
      'aria-hidden': 'true',
      hidden: true,
      style: {
        position: 'fixed',
        left: '0px',
        top: '0px',
        height: '2px',
        transformOrigin: '0 50%',
        pointerEvents: 'none',
        background: '#ffd56a',
        boxShadow: '0 0 0 1px #000a',
      },
    });
    (opts.parent ?? doc.body).append(this.leaderEl, this.el);
  }

  get visible(): boolean {
    return this.on;
  }

  show(v: LoupeView): void {
    const win = this.source.ownerDocument.defaultView ?? window;
    const dpr = Math.min(3, win.devicePixelRatio || 1);
    const px = Math.round(this.size * dpr);
    if (this.cv.width !== px) {
      this.cv.width = px;
      this.cv.height = px;
    }
    const d = this.size;
    this.el.style.transform = `translate(${Math.round(v.at.x - d / 2)}px, ${Math.round(v.at.y - d / 2)}px)`;
    const seg = v.leader ? loupeLeader(v.at, d, v.leader) : null;
    this.leaderEl.hidden = !seg;
    if (seg) {
      const len = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
      const deg = (Math.atan2(seg.y1 - seg.y0, seg.x1 - seg.x0) * 180) / Math.PI;
      this.leaderEl.style.width = `${len.toFixed(1)}px`;
      this.leaderEl.style.transform = `translate(${seg.x0.toFixed(1)}px, ${(seg.y0 - 1).toFixed(1)}px) rotate(${deg.toFixed(2)}deg)`;
    }
    if (!this.on) {
      this.on = true;
      this.el.dataset.on = '';
      this.el.style.opacity = '1';
    }
    // Copy after the caller's frame is drawn: a WebGPU canvas is only readable between its
    // render and the browser presenting it, so a copy made earlier in the frame comes out blank.
    // A microtask runs once the current task (update then render) is over.
    const queued = this.pending !== null;
    this.pending = { view: v, px, dpr };
    if (!queued) queueMicrotask(() => this.draw());
  }

  private draw(): void {
    const p = this.pending;
    this.pending = null;
    const g = this.g;
    if (!p || !g || !this.on) return;
    const { view: v, px, dpr } = p;
    const d = this.size;
    const r = this.source.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const kx = this.source.width / r.width;
    const ky = this.source.height / r.height;
    const span = d / this.zoom; // client px shown across the loupe
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.fillStyle = '#000';
    g.fillRect(0, 0, px, px);
    try {
      g.drawImage(
        this.source,
        (v.focus.x - span / 2 - r.left) * kx,
        (v.focus.y - span / 2 - r.top) * ky,
        span * kx,
        span * ky,
        0,
        0,
        px,
        px,
      );
    } catch {
      // A source that can't be read yet: the loupe stays dark for this frame.
    }
    const ring = v.ring;
    if (ring) {
      const s = px / span; // device px per client px inside the loupe
      const cx = (ring.x - (v.focus.x - span / 2)) * s;
      const cy = (ring.y - (v.focus.y - span / 2)) * s;
      g.lineWidth = 3 * dpr;
      g.strokeStyle = '#000a';
      g.beginPath();
      g.arc(cx, cy, ring.r * s + 2 * dpr, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 2.5 * dpr;
      g.strokeStyle = ring.color ?? '#ffd56a';
      g.beginPath();
      g.arc(cx, cy, ring.r * s, 0, Math.PI * 2);
      g.stroke();
    }
  }

  hide(): void {
    this.pending = null;
    if (!this.on) return;
    this.on = false;
    this.leaderEl.hidden = true;
    delete this.el.dataset.on;
    this.el.style.opacity = '0';
  }

  destroy(): void {
    this.el.remove();
    this.leaderEl.remove();
  }
}
