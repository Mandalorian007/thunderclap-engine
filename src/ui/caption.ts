import { h } from './dom';
import type { Rect } from './overlay';
import { prefersReducedMotion } from './styles';

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** Area (px²) of `box` that lies inside any of `regions` (overlaps between regions count twice). Pure. */
export function overlapArea(box: Rect, regions: readonly Rect[]): number {
  let area = 0;
  for (const r of regions) {
    const w = Math.min(box.x + box.width, r.x + r.width) - Math.max(box.x, r.x);
    const h = Math.min(box.y + box.height, r.y + r.height) - Math.max(box.y, r.y);
    if (w > 0 && h > 0) area += w * h;
  }
  return area;
}

/** The order corners are tried in: the preferred one, its mirror across, then the other edge. Pure. */
export function cornerOrder(preferred: Corner): Corner[] {
  const [v, side] = preferred.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const flipV = v === 'top' ? 'bottom' : 'top';
  const flipS = side === 'left' ? 'right' : 'left';
  return [preferred, `${v}-${flipS}`, `${flipV}-${side}`, `${flipV}-${flipS}`] as Corner[];
}

export interface ReadingTimeOptions {
  /** Base time added to every line. Default 1200 ms. */
  baseMs?: number;
  /** Per character. Default 45 ms (~220 wpm with base). */
  perCharMs?: number;
  /** Floor. Default 2000 ms. */
  minMs?: number;
  /** Ceiling. Default 12000 ms. */
  maxMs?: number;
}

/** How long a line should stay up once fully revealed. Pure. */
export function readingTimeMs(text: string, opts: ReadingTimeOptions = {}): number {
  const { baseMs = 1200, perCharMs = 45, minMs = 2000, maxMs = 12000 } = opts;
  const chars = text.trim().length;
  return Math.round(Math.min(maxMs, Math.max(minMs, baseMs + chars * perCharMs)));
}

/** Delay before revealing the next char: pauses after punctuation. Pure. */
export function revealDelayMs(prev: string, cps: number): number {
  const base = 1000 / cps;
  if (/[.!?…]/.test(prev)) return base * 8;
  if (/[,;:—–]/.test(prev)) return base * 4;
  return base;
}

export interface SayOptions {
  /** Shown above the text (e.g. a name). Omit for none. */
  speaker?: string;
  /** Optional element shown left of the text (a canvas, an svg glyph...). */
  portrait?: Node;
  /** Reveal speed in characters per second. `0` or reduced motion = instant. Default 45. */
  cps?: number;
  /** ms to hold once fully shown; `0` = until clicked / `advance()`. Default `readingTimeMs(text)`. */
  hold?: number;
  /** Called with each revealed character (e.g. to blip a sound). Not called for whitespace. */
  onChar?: (ch: string, index: number) => void;
  /** Override the card's corner for this line. */
  corner?: Corner;
}

export interface CaptionOptions {
  corner?: Corner;
  /** Force reduced motion (default: the user's `prefers-reduced-motion`). */
  reducedMotion?: boolean;
  /** Default reveal speed. */
  cps?: number;
  /** Clicking the card skips the reveal, then advances. Default true. */
  clickToAdvance?: boolean;
}

interface Line {
  text: string;
  opts: SayOptions;
  resolve: () => void;
}

/**
 * A corner speech/caption card with a typewriter reveal and a queue. The full line goes into a
 * polite live region at once (screen readers don't hear the typewriter), and the visible text
 * keeps its final layout from the start (unrevealed chars are `visibility:hidden`) so the card
 * never reflows while typing.
 */
export class CaptionCard {
  readonly element: HTMLElement;
  private readonly portraitEl: HTMLElement;
  private readonly speakerEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly shownEl: HTMLElement;
  private readonly pendingEl: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly queue: Line[] = [];
  private current: Line | null = null;
  private revealed = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private phase: 'idle' | 'typing' | 'holding' = 'idle';
  private readonly corner: Corner;
  private readonly sideEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly placeSubs = new Set<(el: HTMLElement) => void>();
  private readonly homeEl: HTMLElement;
  private dockHost: HTMLElement | null = null;
  private lineCps = 0;
  private isSuspended = false;
  reducedMotion: boolean;
  cps: number;

  constructor(container: HTMLElement, opts: CaptionOptions = {}) {
    this.corner = opts.corner ?? 'bottom-right';
    this.reducedMotion = opts.reducedMotion ?? prefersReducedMotion();
    this.cps = opts.cps ?? 45;
    this.portraitEl = h('div', { class: 'tc-caption-portrait', 'aria-hidden': 'true' });
    this.speakerEl = h('div', { class: 'tc-caption-speaker', 'aria-hidden': 'true' });
    this.shownEl = h('span');
    this.pendingEl = h('span', { class: 'tc-caption-pending' });
    this.textEl = h(
      'div',
      { class: 'tc-caption-text', 'aria-hidden': 'true' },
      this.shownEl,
      this.pendingEl,
    );
    this.liveEl = h('div', {
      class: 'tc-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    // With a portrait, the speaker's name sits under it (a shorter card); without, above the text.
    this.sideEl = h('div', { class: 'tc-caption-side' }, this.portraitEl);
    this.bodyEl = h('div', { class: 'tc-caption-body' }, this.speakerEl, this.textEl);
    this.element = h(
      'div',
      { class: 'tc-caption', dataset: { corner: this.corner }, hidden: true },
      this.sideEl,
      this.bodyEl,
    );
    if (opts.clickToAdvance !== false) this.element.addEventListener('click', () => this.advance());
    this.homeEl = container;
    container.append(this.element, this.liveEl);
  }

  /** The region the card is docked in (see `dock`), or null in its corner. */
  get docked(): HTMLElement | null {
    return this.dockHost;
  }

  /**
   * Region placement (layout regions, `Layout.dockCaption`): move the card into `host` and let
   * it fill that region instead of floating in a corner. While docked, corners and `onPlace` do
   * not apply; the region never overlaps another. `null` returns it to its corner in the
   * original container. The live region stays put.
   */
  dock(host: HTMLElement | null): void {
    if (host === this.dockHost) return;
    this.dockHost = host;
    this.element.toggleAttribute('data-docked', !!host);
    this.element.style.maxWidth = '';
    if (host) host.append(this.element);
    else this.homeEl.insertBefore(this.element, this.liveEl);
    this.place();
  }

  /** True while a line is showing or queued. */
  get busy(): boolean {
    return this.current !== null;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Text of the line being shown, or null. */
  get currentText(): string | null {
    return this.current?.text ?? null;
  }

  /** True while `suspend(true)` holds the card hidden and frozen. */
  get suspended(): boolean {
    return this.isSuspended;
  }

  /**
   * Called whenever the card is laid out in its corner (a new line, back from suspension or
   * undocked), after its corner is reset to the line's and its inline `max-width` cleared. A
   * game that must keep the card off parts of its scene moves or narrows it here (`overlapArea`
   * and `cornerOrder` help). Returns unsubscribe.
   */
  onPlace(fn: (el: HTMLElement) => void): () => void {
    this.placeSubs.add(fn);
    return () => this.placeSubs.delete(fn);
  }

  /** Lay the card out again in its corner and run `onPlace` (e.g. after the scene moved). */
  relayout(): void {
    this.place();
  }

  /**
   * Hide the card and freeze its typing and hold timers (e.g. while a modal panel is open);
   * `suspend(false)` shows it again and picks up where it left off, with a fresh hold. The
   * queue and live region are untouched, and `say()` still queues while suspended.
   */
  suspend(on: boolean): void {
    if (on === this.isSuspended) return;
    this.isSuspended = on;
    this.element.toggleAttribute('data-suspended', on);
    if (on) {
      this.stopTimer();
    } else {
      this.place();
      this.schedule();
    }
  }

  /** Queue a line; resolves when it's dismissed (held time elapsed, advanced, or cleared). */
  say(text: string, opts: SayOptions = {}): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ text, opts, resolve });
      if (!this.current) this.next();
    });
  }

  /** Skip the typewriter if typing, else dismiss the current line. */
  advance(): void {
    if (this.phase === 'typing') this.finishReveal();
    else if (this.phase === 'holding') this.dismiss();
  }

  /** Drop the queue and hide the card; all pending `say` promises resolve. */
  clear(): void {
    const pending = this.queue.splice(0);
    this.stopTimer();
    const cur = this.current;
    this.current = null;
    this.phase = 'idle';
    this.element.hidden = true;
    cur?.resolve();
    for (const l of pending) l.resolve();
  }

  destroy(): void {
    this.clear();
    this.placeSubs.clear();
    this.element.remove();
    this.liveEl.remove();
  }

  private next() {
    const line = this.queue.shift();
    this.stopTimer();
    if (!line) {
      this.current = null;
      this.phase = 'idle';
      this.element.hidden = true;
      return;
    }
    this.current = line;
    this.revealed = 0;
    this.speakerEl.textContent = line.opts.speaker ?? '';
    this.portraitEl.replaceChildren(...(line.opts.portrait ? [line.opts.portrait] : []));
    this.sideEl.hidden = !line.opts.portrait;
    if (line.opts.portrait) this.sideEl.append(this.speakerEl);
    else this.bodyEl.prepend(this.speakerEl);
    this.liveEl.textContent = line.opts.speaker ? `${line.opts.speaker}: ${line.text}` : line.text;
    this.element.hidden = false;
    this.lineCps = line.opts.cps ?? this.cps;
    const instant = this.reducedMotion || this.lineCps <= 0;
    if (instant) this.revealed = [...line.text].length;
    this.phase = instant ? 'holding' : 'typing';
    // The whole line is laid out from the start (pending chars hidden), so place it once now.
    this.render();
    this.place();
    this.schedule();
  }

  /** (Re)start the timer for the current phase, unless suspended. */
  private schedule() {
    this.stopTimer();
    const line = this.current;
    if (!line || this.isSuspended) return;
    if (this.phase === 'typing') this.tick(this.lineCps);
    else if (this.phase === 'holding') {
      const hold = line.opts.hold ?? readingTimeMs(line.text);
      if (hold > 0) this.timer = setTimeout(() => this.dismiss(), hold);
    }
  }

  /** Reset the card to the line's corner and let `onPlace` adjust it. */
  private place() {
    const el = this.element;
    const line = this.current;
    if (!line || el.hidden || this.isSuspended || this.dockHost) return;
    el.dataset.corner = line.opts.corner ?? this.corner;
    el.style.maxWidth = '';
    for (const fn of this.placeSubs) fn(el);
  }

  private tick(cps: number) {
    const line = this.current!;
    const chars = [...line.text];
    if (this.revealed >= chars.length) {
      this.finishReveal();
      return;
    }
    const ch = chars[this.revealed]!;
    this.revealed++;
    this.render();
    if (ch.trim()) line.opts.onChar?.(ch, this.revealed - 1);
    this.timer = setTimeout(() => this.tick(cps), revealDelayMs(ch, cps));
  }

  private finishReveal() {
    const line = this.current;
    if (!line) return;
    this.revealed = [...line.text].length;
    this.render();
    this.phase = 'holding';
    this.schedule();
  }

  private dismiss() {
    const line = this.current;
    this.stopTimer();
    this.current = null;
    line?.resolve();
    this.next();
  }

  private render() {
    const chars = [...(this.current?.text ?? '')];
    this.shownEl.textContent = chars.slice(0, this.revealed).join('');
    this.pendingEl.textContent = chars.slice(this.revealed).join('');
  }

  private stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
