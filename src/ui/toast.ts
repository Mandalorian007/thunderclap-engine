import { h } from './dom';

export type ToastTone = 'info' | 'success' | 'warn' | 'danger';

export interface ToastOptions {
  /** ms before it disappears. `0` = until dismissed. Default 3500. */
  duration?: number;
  tone?: ToastTone;
}

export interface ToastHandle {
  readonly element: HTMLElement;
  dismiss(): void;
}

/**
 * Transient notices in a polite live region. Click to dismiss. At most `max` are shown;
 * the oldest goes first.
 */
export class Toaster {
  readonly element: HTMLElement;
  private readonly live: ToastHandle[] = [];

  constructor(
    container: HTMLElement,
    private readonly max = 3,
  ) {
    this.element = h('div', { class: 'tc-toasts', role: 'status', 'aria-live': 'polite' });
    container.append(this.element);
  }

  get count(): number {
    return this.live.length;
  }

  show(message: string | Node, opts: ToastOptions = {}): ToastHandle {
    const el = h('div', { class: 'tc-toast', dataset: { tone: opts.tone ?? 'info' } }, message);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle: ToastHandle = {
      element: el,
      dismiss: () => {
        if (timer) clearTimeout(timer);
        const i = this.live.indexOf(handle);
        if (i >= 0) this.live.splice(i, 1);
        el.remove();
      },
    };
    el.addEventListener('click', () => handle.dismiss());
    this.element.append(el);
    this.live.push(handle);
    while (this.live.length > this.max) this.live[0]!.dismiss();
    const duration = opts.duration ?? 3500;
    if (duration > 0) timer = setTimeout(handle.dismiss, duration);
    return handle;
  }

  clear(): void {
    for (const t of [...this.live]) t.dismiss();
  }
}
