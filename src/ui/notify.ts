/**
 * Notifications (ws/ui-3): richer than toasts (which are one line of text, top-centre): a titled
 * card with a body, an icon, a tone and action buttons, stacked top-right on the `toasts` layer
 * in a `role="status"` polite live region. Each one times out unless hovered or focused (or
 * `timeout: 0`); a close button and Escape dismiss it. The actions are plain buttons, so the
 * game's pad drives them through `menuNav(input, ui.notifications.element)` when it wants to.
 */
import { h } from './dom';
import { toFrameUnits } from './text-scale';
import { button } from './widgets';

export type NotifyTone = 'info' | 'success' | 'warn' | 'danger';

export interface NotifyAction {
  label: string;
  /** Runs, then the notification is dismissed unless `keep` is set. */
  onClick: () => void;
  keep?: boolean;
}

export interface NotifyOptions {
  title: string;
  body?: string | Node;
  /** A glyph or node at the left. */
  icon?: string | Node;
  tone?: NotifyTone;
  actions?: readonly NotifyAction[];
  /** ms before it disappears; paused while hovered or focused. `0` = until dismissed. Default 6000. */
  timeout?: number;
}

export interface Notification {
  readonly element: HTMLElement;
  readonly open: boolean;
  dismiss(): void;
}

export interface Notifier {
  /** The stack (`role=status`, `aria-live=polite`); the root for `menuNav`. */
  readonly element: HTMLElement;
  readonly count: number;
  notify(opts: NotifyOptions): Notification;
  dismissAll(): void;
  /** Focus the first action (or close button) of the newest notification, for pad users. */
  focus(): boolean;
  dispose(): void;
}

/** A notifier stacked top-right in `container` (the overlay's `toasts` layer). */
export function createNotifier(container: HTMLElement, max = 4): Notifier {
  const doc = container.ownerDocument;
  ensureNotifyStyles(doc);
  const element = h('div', { class: 'tc-notify', role: 'status', 'aria-live': 'polite' });
  container.append(element);
  const live: Notification[] = [];

  const notifier: Notifier = {
    element,
    get count() {
      return live.length;
    },
    notify(opts) {
      const tone = opts.tone ?? 'info';
      const actions = (opts.actions ?? []).map((a) =>
        button(
          a.label,
          () => {
            a.onClick();
            if (!a.keep) handle.dismiss();
          },
          { variant: 'ghost', className: 'tc-notification-action' },
        ),
      );
      const close = button('×', () => handle.dismiss(), {
        variant: 'ghost',
        className: 'tc-notification-close',
        ariaLabel: 'Dismiss',
      });
      const card = h(
        'div',
        { class: 'tc-notification', dataset: { tone }, tabindex: '-1' },
        opts.icon !== undefined
          ? h('span', { class: 'tc-notification-icon', 'aria-hidden': 'true' }, opts.icon)
          : null,
        h(
          'div',
          { class: 'tc-notification-main' },
          h('div', { class: 'tc-notification-title' }, opts.title),
          opts.body !== undefined ? h('div', { class: 'tc-notification-body' }, opts.body) : null,
          actions.length > 0 ? h('div', { class: 'tc-notification-actions' }, ...actions) : null,
        ),
        close,
      );
      let timer: ReturnType<typeof setTimeout> | null = null;
      let open = true;
      const timeout = opts.timeout ?? 6000;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = timeout > 0 ? setTimeout(() => handle.dismiss(), timeout) : null;
      };
      const pause = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const handle: Notification = {
        element: card,
        get open() {
          return open;
        },
        dismiss() {
          if (!open) return;
          open = false;
          pause();
          const i = live.indexOf(handle);
          if (i >= 0) live.splice(i, 1);
          const hadFocus = card.contains(doc.activeElement);
          card.remove();
          // Keep a pad user on the stack rather than dropping focus to the body.
          if (hadFocus) notifier.focus();
        },
      };
      card.addEventListener('pointerenter', pause);
      card.addEventListener('pointerleave', arm);
      card.addEventListener('focusin', pause);
      card.addEventListener('focusout', (e) => {
        if (!card.contains(e.relatedTarget as Node | null)) arm();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          handle.dismiss();
        }
      });
      element.prepend(card);
      live.push(handle);
      while (live.length > max) live[0]!.dismiss();
      arm();
      return handle;
    },
    dismissAll() {
      for (const n of [...live]) n.dismiss();
    },
    focus() {
      const first = element.querySelector<HTMLElement>('.tc-notification button');
      if (!first) return false;
      first.focus();
      return true;
    },
    dispose() {
      notifier.dismissAll();
      element.remove();
    },
  };
  return notifier;
}

/**
 * Stylesheet for notifications (design px, theme tokens).
 */
export const NOTIFY_CSS = toFrameUnits(`
.tc-notify { position: absolute; top: var(--tc-space-5); right: var(--tc-space-5); display: flex; flex-direction: column;
  gap: var(--tc-space-2); width: min(560px, calc(100% - 2 * var(--tc-space-5))); pointer-events: none; }
.tc-notification { display: flex; align-items: flex-start; gap: var(--tc-space-3); pointer-events: auto;
  padding: var(--tc-space-3) var(--tc-space-3) var(--tc-space-3) var(--tc-space-4); color: var(--tc-color-text);
  font-family: var(--tc-font-ui); font-size: var(--tc-font-size-s); background: var(--tc-color-surface);
  border: var(--tc-border-width) solid var(--tc-color-border); border-left-width: 6px; border-left-color: var(--tc-color-info);
  border-radius: var(--tc-radius-m); box-shadow: var(--tc-shadow); animation: tc-drop var(--tc-duration-normal) var(--tc-easing); outline: none; }
.tc-notification[data-tone="success"] { border-left-color: var(--tc-color-success); }
.tc-notification[data-tone="warn"] { border-left-color: var(--tc-color-warn); }
.tc-notification[data-tone="danger"] { border-left-color: var(--tc-color-danger); }
.tc-notification-icon { flex: none; font-size: var(--tc-font-size-m); line-height: 1.2; }
.tc-notification-main { flex: 1 1 auto; min-width: 0; display: grid; gap: var(--tc-space-1); }
.tc-notification-title { font-weight: 700; }
.tc-notification-body { color: var(--tc-color-text-muted); overflow-wrap: break-word; }
.tc-notification-actions { display: flex; flex-wrap: wrap; gap: var(--tc-space-2); margin-top: var(--tc-space-1); }
.tc-notification-close { flex: none; margin: calc(-1 * var(--tc-space-2)) calc(-1 * var(--tc-space-2)) 0 0; }
@media (prefers-reduced-motion: reduce) { .tc-notification { animation: none; } }
`);

const STYLE_ID = 'tc-ui-notify';

/** Add `NOTIFY_CSS` to `doc` once (the first notification does it). */
export function ensureNotifyStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = NOTIFY_CSS;
  doc.head.appendChild(style);
}
