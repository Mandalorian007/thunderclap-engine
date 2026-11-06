import { consumesArrows, focusableWithin, h } from './dom';

export type CloseReason = 'escape' | 'backdrop' | 'programmatic' | 'replaced';

/**
 * Which arrow keys walk focus through a panel's controls (`PanelOptions.arrowNav`):
 * `vertical` (ArrowUp/ArrowDown, the default), `both` (ArrowLeft/ArrowRight too) or `none`.
 */
export type ArrowNav = 'vertical' | 'both' | 'none';

export interface PanelOptions {
  /** Panel body. */
  content: Node;
  /** Visible heading (also the accessible name). Omit for chrome-less panels; then pass `label`. */
  title?: string;
  /** Accessible name when there's no visible title. */
  label?: string;
  /** Dim the background, trap focus, make lower layers inert, set `hasModal`. Default true. */
  modal?: boolean;
  /** Esc closes it. Default true. */
  dismissible?: boolean;
  /** Clicking the backdrop closes it. Default: same as `dismissible`. */
  closeOnBackdrop?: boolean;
  /** `card` (themed surface) or `none` (you style it, e.g. a full-screen book). Default `card`. */
  chrome?: 'card' | 'none';
  /** Extra class on the panel element. */
  className?: string;
  /** Element (or selector within the panel) to focus on open. Default: first focusable, else the panel. */
  initialFocus?: HTMLElement | string;
  /** `dialog` (default) or `alertdialog`. */
  role?: 'dialog' | 'alertdialog';
  /**
   * Arrow keys move focus among the panel's focusable elements, wrapping, while this panel is on
   * top: `vertical` (ArrowUp/ArrowDown; the default), `both` (ArrowLeft/ArrowRight too) or
   * `none`. A focused text field, textarea, select or slider keeps the arrows it uses itself.
   */
  arrowNav?: ArrowNav;
  onClose?: (reason: CloseReason) => void;
}

export interface PanelHandle {
  /** The panel element (`role=dialog`), containing `content`. */
  readonly element: HTMLElement;
  readonly open: boolean;
  close(reason?: CloseReason): void;
}

interface Entry {
  handle: PanelHandle;
  host: HTMLElement;
  panel: HTMLElement;
  opts: PanelOptions;
  restoreFocus: Element | null;
  open: boolean;
}

let idCounter = 0;

/**
 * Put this attribute on an opener (or any ancestor, e.g. a HUD bar) whose buttons double as
 * keyboard shortcuts. When a panel it opened closes, focus does not go back to it, because a
 * focused button would swallow the game's keys. Focus goes to the next panel down, else to
 * the stack's focus home.
 */
export const NO_RESTORE_FOCUS_ATTR = 'data-tc-no-restore-focus';

export interface PanelStackFocusOptions {
  /**
   * Where focus goes when a panel closes and there is nowhere better: the opener is gone,
   * inert, marked `NO_RESTORE_FOCUS_ATTR` or was nothing (`<body>`), and no panel is left
   * to focus. Typically the game canvas, so key handling keeps working.
   */
  home?: () => HTMLElement | null;
}

/** `ArrowNav` per key: the step through the focusable list, or 0 when the key is not an arrow. */
function arrowStep(key: string, nav: ArrowNav): number {
  if (nav === 'none') return 0;
  if (key === 'ArrowDown') return 1;
  if (key === 'ArrowUp') return -1;
  if (nav === 'both') {
    if (key === 'ArrowRight') return 1;
    if (key === 'ArrowLeft') return -1;
  }
  return 0;
}

/**
 * A stack of panels inside one container. The top panel gets keyboard focus; Esc closes it
 * (if dismissible); Tab cycles inside the top modal; the arrow keys walk its controls
 * (`arrowNav`); lower panels and `inertWhenModal` elements are made `inert` while a modal is
 * on top.
 */
export class PanelStack {
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<(stack: PanelStack) => void>();
  private readonly doc: Document;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  /**
   * @param container where panel hosts are appended (the overlay's `panels` layer).
   * @param inertWhenModal other elements to make inert while a modal is open (e.g. the HUD layer).
   * @param focus where focus goes on close when the opener shouldn't (or can't) get it back.
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly inertWhenModal: readonly HTMLElement[] = [],
    private readonly focus: PanelStackFocusOptions = {},
  ) {
    this.doc = container.ownerDocument;
    this.doc.addEventListener('keydown', this.onKey);
  }

  get size(): number {
    return this.entries.length;
  }

  /** True while any open panel is modal. Wire this to `input.blocked`. */
  get hasModal(): boolean {
    return this.entries.some((e) => e.opts.modal !== false);
  }

  get top(): PanelHandle | null {
    return this.entries.at(-1)?.handle ?? null;
  }

  onChange(fn: (stack: PanelStack) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(opts: PanelOptions): PanelHandle {
    const modal = opts.modal !== false;
    const dismissible = opts.dismissible !== false;
    const id = `tc-panel-${++idCounter}`;
    const titleEl = opts.title
      ? h('h2', { class: 'tc-panel-title', id: `${id}-title` }, opts.title)
      : null;
    const panel = h(
      'div',
      {
        class: ['tc-panel', opts.chrome === 'none' ? '' : 'tc-card', opts.className ?? '']
          .join(' ')
          .trim(),
        role: opts.role ?? 'dialog',
        'aria-modal': modal ? 'true' : null,
        'aria-labelledby': titleEl ? titleEl.id : null,
        'aria-label': !titleEl && opts.label ? opts.label : null,
        tabindex: '-1',
        id,
      },
      titleEl,
      opts.content,
    );
    const host = h('div', { class: 'tc-panel-host', dataset: { modal: String(modal) } });
    if (modal) {
      const backdrop = h('div', { class: 'tc-backdrop', 'aria-hidden': 'true' });
      if (opts.closeOnBackdrop ?? dismissible) {
        backdrop.addEventListener('click', () => entry.handle.close('backdrop'));
      }
      host.append(backdrop);
    }
    host.append(panel);

    const entry: Entry = {
      host,
      panel,
      opts,
      restoreFocus: this.doc.activeElement,
      open: true,
      handle: {
        element: panel,
        get open() {
          return entry.open;
        },
        close: (reason = 'programmatic') => this.closeEntry(entry, reason),
      },
    };
    this.entries.push(entry);
    this.container.append(host);
    this.refresh();
    this.focusInitial(entry);
    this.emit();
    return entry.handle;
  }

  /**
   * What Esc does, for other input devices (e.g. a gamepad's back button): close the top
   * panel if it is dismissible. Returns true if one closed.
   */
  dismissTop(): boolean {
    const top = this.entries.at(-1);
    if (!top || top.opts.dismissible === false) return false;
    top.handle.close('escape');
    return true;
  }

  /** The top panel's element if it is modal (the one keyboard focus is trapped in). */
  get topModalElement(): HTMLElement | null {
    const top = this.entries.at(-1);
    return top && top.opts.modal !== false ? top.panel : null;
  }

  /** Close the top panel. Returns false if the stack was empty. */
  pop(reason: CloseReason = 'programmatic'): boolean {
    const top = this.entries.at(-1);
    if (!top) return false;
    this.closeEntry(top, reason);
    return true;
  }

  /** Close the top panel (if any) and push a new one. */
  replace(opts: PanelOptions): PanelHandle {
    const top = this.entries.at(-1);
    if (top) this.closeEntry(top, 'replaced', false);
    return this.push(opts);
  }

  /** Close everything, top first. */
  clear(): void {
    while (this.entries.length) this.closeEntry(this.entries.at(-1)!, 'programmatic');
  }

  destroy(): void {
    this.clear();
    this.doc.removeEventListener('keydown', this.onKey);
    this.listeners.clear();
  }

  private closeEntry(entry: Entry, reason: CloseReason, restore = true) {
    if (!entry.open) return;
    const i = this.entries.indexOf(entry);
    const wasTop = i === this.entries.length - 1;
    entry.open = false;
    this.entries.splice(i, 1);
    entry.host.remove();
    this.refresh();
    if (restore && wasTop) {
      const back = entry.restoreFocus as HTMLElement | null;
      const top = this.entries.at(-1);
      if (this.canRestore(back)) {
        back.focus();
      } else if (top) {
        this.focusInitial(top);
      } else {
        this.focus.home?.()?.focus({ preventScroll: true });
      }
    }
    entry.opts.onClose?.(reason);
    this.emit();
  }

  private canRestore(el: HTMLElement | null): el is HTMLElement {
    if (!el?.isConnected || typeof el.focus !== 'function' || el.closest('[inert]')) return false;
    // With a focus home, "nothing was focused" restores to home rather than to <body>.
    if (this.focus.home && (el === this.doc.body || el === this.doc.documentElement)) return false;
    return !el.closest(`[${NO_RESTORE_FOCUS_ATTR}]`);
  }

  /** Inert everything below the topmost modal. */
  private refresh() {
    let topModal = -1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.opts.modal !== false) {
        topModal = i;
        break;
      }
    }
    this.entries.forEach((e, i) => {
      e.host.inert = i < topModal;
      e.host.toggleAttribute('inert', i < topModal);
    });
    for (const el of this.inertWhenModal) {
      el.inert = topModal >= 0;
      el.toggleAttribute('inert', topModal >= 0);
    }
  }

  private focusInitial(entry: Entry) {
    const f = entry.opts.initialFocus;
    let target: HTMLElement | null = null;
    if (typeof f === 'string') target = entry.panel.querySelector<HTMLElement>(f);
    else if (f) target = f;
    target ??= focusableWithin(entry.panel)[0] ?? entry.panel;
    target.focus({ preventScroll: true });
  }

  private handleKey(e: KeyboardEvent) {
    const top = this.entries.at(-1);
    if (!top || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (top.opts.dismissible === false) return;
      e.preventDefault();
      // Keep the game's input map from also seeing this Escape.
      e.stopPropagation();
      top.handle.close('escape');
      return;
    }
    if (e.key === 'Tab' && top.opts.modal !== false) {
      const items = focusableWithin(top.panel);
      if (items.length === 0) {
        e.preventDefault();
        top.panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = this.doc.activeElement;
      const inside = active instanceof Node && top.panel.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    this.handleArrow(e, top);
  }

  /**
   * ArrowUp/ArrowDown (and ArrowLeft/ArrowRight with `arrowNav: 'both'`) move focus through the
   * top panel's focusable elements, wrapping, when focus is inside it (always, for a modal). A
   * focused control that uses the arrow itself (a text field's caret, a select, a slider) keeps
   * it; a consumed arrow is `preventDefault`ed and stopped, like Escape.
   */
  private handleArrow(e: KeyboardEvent, top: Entry) {
    const step = arrowStep(e.key, top.opts.arrowNav ?? 'vertical');
    if (step === 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const active = this.doc.activeElement as HTMLElement | null;
    const inside = active !== null && top.panel.contains(active);
    if (!inside && top.opts.modal === false) return;
    const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (inside && active !== top.panel && consumesArrows(active, horizontal)) return;
    const items = focusableWithin(top.panel);
    if (items.length === 0) return;
    const i = inside ? items.indexOf(active) : -1;
    const next =
      i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
  }

  private emit() {
    for (const fn of this.listeners) fn(this);
  }
}
