/** Tiny DOM helpers. */

export type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  /** An object of properties (`--custom` ones included) or a `cssText` string. */
  style?: Partial<CSSStyleDeclaration> | Record<string, string> | string;
  dataset?: Record<string, string>;
  /** Event listeners: `on: { click: fn }`. */
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
  [attr: string]: unknown;
};

/**
 * Hyperscript: `h('div', { class: 'row', 'aria-label': 'x', on: { click } }, 'text', child)`.
 * Unknown props become attributes (`true` → empty attribute, `false`/null → omitted). `style`
 * takes an object (`--custom` properties included) or a `cssText` string.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') {
          el.style.cssText = v;
          continue;
        }
        for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else (el.style as unknown as Record<string, string>)[sk] = sv;
        }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'on') {
        for (const [ev, fn] of Object.entries(v as Record<string, EventListener>))
          el.addEventListener(ev, fn);
      } else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Keyboard-focusable descendants in DOM order (skips `hidden` and `inert` subtrees). */
export function focusableWithin(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden], [inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/** Input types whose own arrow handling is only horizontal (the caret). */
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'password', 'tel']);
/** Input types that never use the arrow keys. */
const ARROWLESS_INPUTS = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'image',
  'file',
  'color',
]);

/**
 * Whether a focused `el` uses the arrow keys of an axis itself, so focus navigation (the panel
 * stack's arrows, `PadNav`'s d-pad) must leave them to it: a text field consumes left/right, a
 * textarea, select, slider (`type=range` or `role=slider`), radio, number, date or other value
 * input and a contenteditable consume both axes; buttons and checkboxes consume none.
 */
export function consumesArrows(el: Element, horizontal: boolean): boolean {
  if (el.getAttribute('role') === 'slider' || (el as HTMLElement).isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  if (ARROWLESS_INPUTS.has(type)) return false;
  if (TEXT_INPUTS.has(type)) return horizontal;
  return true;
}
