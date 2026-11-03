import { h } from './dom';

export interface ButtonOptions {
  variant?: 'default' | 'primary' | 'ghost';
  disabled?: boolean;
  /** Accessible name when the label is an icon. */
  ariaLabel?: string;
  className?: string;
}

export function button(
  label: string | Node,
  onClick: (e: MouseEvent) => void,
  opts: ButtonOptions = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: ['tc-button', opts.className ?? ''].join(' ').trim(),
      dataset: { variant: opts.variant ?? 'default' },
      disabled: opts.disabled ?? false,
      'aria-label': opts.ariaLabel,
      on: { click: onClick },
    },
    label,
  );
}

export interface SliderOptions {
  min?: number;
  max?: number;
  step?: number;
  /** Format the value for `aria-valuetext` (e.g. `v => Math.round(v*100)+'%'`). */
  format?: (v: number) => string;
}

/** Labelled range input. `onInput` fires continuously while dragging. */
export function slider(
  label: string,
  value: number,
  onInput: (v: number) => void,
  opts: SliderOptions = {},
): { element: HTMLLabelElement; input: HTMLInputElement; set(v: number): void } {
  const { min = 0, max = 1, step = 0.01, format } = opts;
  const input = h('input', { type: 'range', min, max, step });
  const setText = () => {
    if (format) input.setAttribute('aria-valuetext', format(Number(input.value)));
  };
  input.value = String(value);
  setText();
  input.addEventListener('input', () => {
    setText();
    onInput(Number(input.value));
  });
  const element = h('label', { class: 'tc-field' }, h('span', null, label), input);
  return {
    element,
    input,
    set(v) {
      input.value = String(v);
      setText();
    },
  };
}

/** Labelled checkbox. */
export function toggle(
  label: string,
  checked: boolean,
  onChange: (v: boolean) => void,
): { element: HTMLLabelElement; input: HTMLInputElement; set(v: boolean): void } {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const element = h('label', { class: 'tc-field' }, input, h('span', null, label));
  return {
    element,
    input,
    set(v) {
      input.checked = v;
    },
  };
}
