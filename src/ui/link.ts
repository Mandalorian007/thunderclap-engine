/**
 * External link widget (D-036): a real new-tab link, a "Copy link" button beside it with
 * "Copied" feedback, and a fallback popover with the URL in a selected read-only field for when
 * the browser blocks the copy or the new tab. Opening and copying go through the host
 * (`Host.openExternal`, `Host.copyText`; engine/host).
 *
 * - Mouse and Enter use the anchor natively (a user gesture, so popup blockers allow it).
 * - A gamepad press is not a gesture: route it through `activateLink(el, 'gamepad')`
 *   (PadNav does this for modals), which opens through the host with block detection (the web
 *   host uses `window.open`) and shows the fallback if blocked.
 * - Nothing opens or copies without the player acting. No network calls.
 * Labels come from the caller; the look comes from theme tokens (override the `tc-link-*` classes).
 */
import { defaultHost } from '../host/default';
import type { Host } from '../host/types';
import {
  type CopyResult,
  type LinkActivation,
  type OpenResult,
  safeExternalUrl,
} from '../platform/links';
import { type Child, h } from './dom';

export interface ExternalLinkLabels {
  /** Copy button text, e.g. "Copy link". */
  copy: string;
  /** Shown on the button for a moment after a copy, e.g. "Copied!". */
  copied: string;
  /** Read by screen readers after a copy, e.g. "Link copied." */
  copiedAnnounce: string;
  /** Copy button's accessible name; should start with `copy` (WCAG 2.5.3). Default: `copy`. */
  copyAriaLabel?: string;
  /** Fallback heading when copying failed, e.g. "Your browser blocked copying. Copy the link:". */
  copyBlocked: string;
  /** Fallback heading when the new tab was blocked, e.g. "Your browser blocked the new tab. Copy the link:". */
  popupBlocked: string;
  /** The fallback's close button, e.g. "Close". */
  close: string;
}

export interface ExternalLinkOptions {
  url: string;
  /** Opens and copies the link. Default: `defaultHost()`. */
  host?: Pick<Host, 'openExternal' | 'copyText'>;
  /** The link's visible content (text, icon). */
  content: Child | Child[];
  labels: ExternalLinkLabels;
  /** Extra class on the wrapper. */
  className?: string;
  /** Class on the anchor. */
  linkClass?: string;
  /**
   * `data-action` names for tests and analytics-free debugging: the anchor gets `action`, the
   * parts get `<action>-copy`, `<action>-fallback`, `<action>-close`.
   */
  action?: string;
  /** Where the fallback popover opens relative to the row. Default `below`. */
  place?: 'above' | 'below';
  /** How the popover lines up with the row. Default `center`. */
  align?: 'start' | 'center' | 'end';
  /** How long "Copied" shows, ms. Default 2200. */
  copiedMs?: number;
}

export interface ExternalLink {
  /** Wrapper to insert into the page. */
  readonly element: HTMLElement;
  readonly anchor: HTMLAnchorElement;
  readonly copyButton: HTMLButtonElement;
  /** Opens the link for `activation`; on `blocked` the fallback appears. */
  open(activation: LinkActivation): OpenResult;
  /** Copies the URL (the Copy button calls this); on `manual` the fallback appears. */
  copy(): Promise<CopyResult>;
  showFallback(reason: 'copy' | 'popup'): void;
  hideFallback(): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const registry = new WeakMap<Element, ExternalLink>();
let ids = 0;

function copyIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'tc-link-copy-icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ['M8 8h11v13H8z', 'M5 16H4V3h11v1']) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/**
 * Builds the widget, or returns null when the URL is not a safe https link (hide the control).
 */
export function externalLink(opts: ExternalLinkOptions): ExternalLink | null {
  const url = safeExternalUrl(opts.url);
  if (!url) return null;
  const { labels } = opts;
  const host = opts.host ?? defaultHost();
  const act = (part: string) => (opts.action ? { action: `${opts.action}${part}` } : undefined);

  const anchor = h(
    'a',
    {
      class: ['tc-link-anchor', opts.linkClass ?? ''].join(' ').trim(),
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      dataset: act(''),
    },
    ...(Array.isArray(opts.content) ? opts.content : [opts.content]),
  );

  const copyLabel = h('span', null, labels.copy);
  const copyButton = h(
    'button',
    {
      type: 'button',
      class: 'tc-link-copy',
      'aria-label': labels.copyAriaLabel ?? labels.copy,
      dataset: act('-copy'),
    },
    copyIcon(),
    copyLabel,
  );

  const fieldId = `tc-link-field-${++ids}`;
  const message = h('label', { class: 'tc-link-message', for: fieldId }, '');
  const field = h('input', {
    id: fieldId,
    class: 'tc-link-field',
    type: 'text',
    readonly: true,
    value: url,
    // Wide enough to show the whole URL; the popover grows to fit (text scale included).
    size: url.length + 1,
    spellcheck: 'false',
    autocomplete: 'off',
    on: { focus: () => field.select(), click: () => field.select() },
  });
  const close = h(
    'button',
    { type: 'button', class: 'tc-link-close', dataset: act('-close') },
    labels.close,
  );
  const fallback = h(
    'div',
    {
      class: 'tc-link-fallback',
      dataset: { ...act('-fallback'), place: opts.place ?? 'below', align: opts.align ?? 'center' },
    },
    h('div', { class: 'tc-link-fallback-head' }, message, close),
    field,
  );
  fallback.hidden = true;
  const live = h('span', { class: 'tc-sr-only', 'aria-live': 'polite' }, '');

  const element = h(
    'div',
    { class: ['tc-link', opts.className ?? ''].join(' ').trim() },
    h('div', { class: 'tc-link-row' }, anchor, copyButton),
    fallback,
    live,
  );

  const announce = (text: string) => {
    // Cleared first, so the same message twice is still read.
    live.textContent = '';
    setTimeout(() => {
      live.textContent = text;
    }, 60);
  };

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const widget: ExternalLink = {
    element,
    anchor,
    copyButton,
    open(activation) {
      const r = host.openExternal(url, { activation });
      if (r === 'blocked') widget.showFallback('popup');
      return r;
    },
    async copy() {
      const r = await host.copyText(url);
      if (r === 'manual') {
        widget.showFallback('copy');
        return r;
      }
      copyLabel.textContent = labels.copied;
      copyButton.dataset.copied = '';
      announce(labels.copiedAnnounce);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyLabel.textContent = labels.copy;
        delete copyButton.dataset.copied;
      }, opts.copiedMs ?? 2200);
      return r;
    },
    showFallback(reason) {
      const text = reason === 'popup' ? labels.popupBlocked : labels.copyBlocked;
      message.textContent = text;
      field.value = url;
      fallback.hidden = false;
      field.focus({ preventScroll: true });
      field.select();
      announce(text);
    },
    hideFallback() {
      const had = !fallback.hidden;
      fallback.hidden = true;
      if (had) copyButton.focus({ preventScroll: true });
    },
  };

  copyButton.addEventListener('click', () => void widget.copy());
  close.addEventListener('click', () => widget.hideFallback());
  fallback.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    widget.hideFallback();
  });
  registry.set(anchor, widget);
  return widget;
}

/**
 * Activates `el` for a non-native input (a gamepad press): an external-link anchor opens through
 * its host with block detection (`window.open` on the web); anything else is clicked. Returns the open result for an
 * external link, else null.
 */
export function activateLink(el: HTMLElement, activation: LinkActivation): OpenResult | null {
  const w = registry.get(el);
  if (w) return w.open(activation);
  el.click();
  return null;
}
