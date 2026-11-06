// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from './dom';
import { createOverlay } from './overlay';
import {
  bar,
  cooldown,
  ensureWidgets2Styles,
  keyPrompt,
  reticle,
  segmented,
  select,
  stepper,
  WIDGETS2_CSS,
} from './widgets-2';

const key = (el: Element, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('widgets-2 styles', () => {
  it('createOverlay injects WIDGETS2_CSS once, beside the base sheet, in design px', () => {
    const parent = h('div');
    document.body.append(parent);
    const a = createOverlay({ parent });
    const b = createOverlay({ parent });
    expect(document.querySelectorAll('#tc-ui-widgets-2').length).toBe(1);
    expect(document.querySelectorAll('#tc-ui-base').length).toBe(1);
    expect(document.getElementById('tc-ui-widgets-2')?.textContent).toBe(WIDGETS2_CSS);
    ensureWidgets2Styles();
    expect(document.querySelectorAll('#tc-ui-widgets-2').length).toBe(1);
    // Every px literal became a design-px calc; the theme variables are the existing set.
    expect(WIDGETS2_CSS.replaceAll('var(--tc-unit, 1px)', '')).not.toMatch(/\dpx\b/);
    expect(WIDGETS2_CSS).toContain('calc(16 * var(--tc-unit, 1px))');
    for (const m of WIDGETS2_CSS.matchAll(/var\((--tc-[a-z0-9-]+)/g)) {
      expect(m[1]).toMatch(
        /^--tc-(unit|ui-[a-z-]+|color-[a-z-]+|space-\d|radius-[sml]|border-width|font-(ui|mono|size-[a-z]+)|duration-(fast|normal)|easing)$/,
      );
    }
    a.destroy();
    b.destroy();
  });
});

describe('reticle', () => {
  it('draws four lines and a dot, sets the spread as a custom property, hides and flashes', () => {
    const r = reticle({ size: 64, thickness: 3, gap: 8, color: 'red' });
    expect(r.element.className).toBe('tc-ui-reticle');
    expect(r.element.getAttribute('aria-hidden')).toBe('true');
    expect(r.element.querySelectorAll('.tc-ui-reticle-line').length).toBe(4);
    expect(r.element.querySelectorAll('.tc-ui-reticle-dot').length).toBe(1);
    expect(r.element.style.getPropertyValue('--tc-ui-size')).toBe('64');
    expect(r.element.style.getPropertyValue('--tc-ui-thickness')).toBe('3');
    expect(r.element.style.getPropertyValue('--tc-ui-gap')).toBe('8');
    expect(r.element.style.getPropertyValue('--tc-ui-color')).toBe('red');
    r.set(0.5);
    expect(r.element.style.getPropertyValue('--tc-ui-spread')).toBe('0.5');
    r.set(3);
    expect(r.element.style.getPropertyValue('--tc-ui-spread')).toBe('1');
    r.hide();
    expect(r.element.hidden).toBe(true);
    r.show();
    expect(r.element.hidden).toBe(false);
    r.hit();
    expect(r.element.hasAttribute('data-hit')).toBe(true);
    r.hit();
    expect(r.element.hasAttribute('data-hit')).toBe(true);
    r.element.dispatchEvent(new Event('animationend'));
    expect(r.element.hasAttribute('data-hit')).toBe(false);
    expect(reticle({ dot: false }).element.querySelector('.tc-ui-reticle-dot')).toBeNull();
    expect(reticle().element.style.getPropertyValue('--tc-ui-color')).toBe('');
  });
});

describe('bar', () => {
  it('is a progressbar with valuetext, a scaleX fill, segments and tones', () => {
    const b = bar('Health', 50, { min: 0, max: 200, segments: 4, tone: 'danger' });
    const el = b.element;
    expect(el.getAttribute('role')).toBe('progressbar');
    expect(el.getAttribute('aria-label')).toBe('Health');
    expect(el.getAttribute('aria-valuemin')).toBe('0');
    expect(el.getAttribute('aria-valuemax')).toBe('200');
    expect(el.getAttribute('aria-valuenow')).toBe('50');
    expect(el.getAttribute('aria-valuetext')).toBe('25%');
    expect(el.style.getPropertyValue('--tc-ui-fill')).toBe('0.25');
    expect(el.dataset.segments).toBe('4');
    expect(el.style.getPropertyValue('--tc-ui-segments')).toBe('4');
    expect(el.dataset.tone).toBe('danger');
    b.set(300);
    expect(el.getAttribute('aria-valuenow')).toBe('200');
    expect(el.style.getPropertyValue('--tc-ui-fill')).toBe('1');
    b.tone('success');
    expect(el.dataset.tone).toBe('success');
    b.tone('accent');
    expect(el.dataset.tone).toBeUndefined();
    // No visible value without a format.
    expect(el.querySelector('.tc-ui-bar-value')?.textContent).toBe('');
  });

  it('format fills aria-valuetext and the visible value; set skips unchanged values', () => {
    const b = bar('Mana', 0.5, { format: (v) => `${v * 10}/10` });
    expect(b.element.getAttribute('aria-valuetext')).toBe('5/10');
    expect(b.element.querySelector('.tc-ui-bar-value')?.textContent).toBe('5/10');
    const spy = vi.spyOn(b.element, 'setAttribute');
    b.set(0.5);
    expect(spy).not.toHaveBeenCalled();
    b.set(1);
    expect(b.element.getAttribute('aria-valuetext')).toBe('10/10');
  });
});

describe('segmented', () => {
  const opts = [
    { value: 'low', label: 'Low' },
    { value: 'mid', label: 'Mid' },
    { value: 'high', label: 'High' },
  ] as const;

  it('is a radiogroup with roving tabindex; arrows move and wrap; clicks pick', () => {
    const onChange = vi.fn();
    const s = segmented('Quality', [...opts], 'mid', onChange);
    document.body.append(s.element);
    expect(s.element.getAttribute('role')).toBe('radiogroup');
    expect(s.element.getAttribute('aria-label')).toBe('Quality');
    const radios = [...s.element.querySelectorAll<HTMLElement>('[role=radio]')];
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);

    expect(key(radios[1], 'ArrowRight').defaultPrevented).toBe(true);
    expect(s.value).toBe('high');
    expect(onChange).toHaveBeenLastCalledWith('high');
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    expect(key(radios[2], 'ArrowRight').defaultPrevented).toBe(true);
    expect(s.value).toBe('low');
    expect(key(radios[0], 'ArrowLeft').defaultPrevented).toBe(true);
    expect(s.value).toBe('high');
    expect(onChange).toHaveBeenCalledTimes(3);

    // Only the arrows it uses: ArrowUp/Down and Tab pass to the panel's walk.
    expect(key(radios[2], 'ArrowUp').defaultPrevented).toBe(false);
    expect(key(radios[2], 'ArrowDown').defaultPrevented).toBe(false);
    expect(key(radios[2], 'Tab').defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(3);

    radios[0].click();
    expect(s.value).toBe('low');
    expect(onChange).toHaveBeenLastCalledWith('low');
    radios[0].click();
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('set selects without onChange', () => {
    const onChange = vi.fn();
    const s = segmented('Quality', [...opts], 'low', onChange);
    s.set('high');
    expect(s.value).toBe('high');
    expect(s.element.querySelector('[aria-checked=true]')?.textContent).toBe('High');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('select', () => {
  it('wraps a native select in a tc-field label', () => {
    const onChange = vi.fn();
    const s = select(
      'Language',
      [
        { value: 'en', label: 'English' },
        { value: 'fr', label: 'Français' },
      ],
      'fr',
      onChange,
    );
    expect(s.element.tagName).toBe('LABEL');
    expect(s.element.classList.contains('tc-field')).toBe(true);
    expect(s.element.classList.contains('tc-ui-select')).toBe(true);
    expect(s.element.querySelector('.tc-ui-label')?.textContent).toBe('Language');
    expect(s.select.value).toBe('fr');
    expect(s.select.options.length).toBe(2);
    s.select.value = 'en';
    s.select.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('en');
    s.set('fr');
    expect(s.select.value).toBe('fr');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('keyPrompt', () => {
  it('shows the key chip, the pad chip when given, and the action text', () => {
    const k = keyPrompt('Interact', { key: 'E' });
    const chips = k.element.querySelectorAll<HTMLElement>('kbd.tc-ui-key');
    expect(chips.length).toBe(2);
    expect(chips[0].dataset.kind).toBe('key');
    expect(chips[0].textContent).toBe('E');
    expect(chips[1].dataset.kind).toBe('pad');
    expect(chips[1].textContent).toBe('');
    expect(k.element.querySelector('.tc-ui-key-action')?.textContent).toBe('Interact');
    k.set('F', 'Ⓧ');
    expect(chips[0].textContent).toBe('F');
    expect(chips[1].textContent).toBe('Ⓧ');
    k.set('F');
    expect(chips[1].textContent).toBe('');
    expect(keyPrompt('Jump').element.querySelector('kbd')?.textContent).toBe('');
  });
});

describe('stepper', () => {
  it('is a spinbutton: buttons, ArrowUp/Down, Home/End, clamped and snapped', () => {
    const onChange = vi.fn();
    const s = stepper('Volume', 0.5, onChange, {
      min: 0,
      max: 1,
      step: 0.1,
      format: (v) => `${Math.round(v * 100)}%`,
    });
    document.body.append(s.element);
    const field = s.element.querySelector<HTMLElement>('[role=spinbutton]');
    if (!field) throw new Error('no spinbutton');
    expect(field.tabIndex).toBe(0);
    expect(field.getAttribute('aria-label')).toBe('Volume');
    expect(field.getAttribute('aria-valuemin')).toBe('0');
    expect(field.getAttribute('aria-valuemax')).toBe('1');
    expect(field.getAttribute('aria-valuenow')).toBe('0.5');
    expect(field.getAttribute('aria-valuetext')).toBe('50%');
    expect(field.textContent).toBe('50%');

    expect(key(field, 'ArrowUp').defaultPrevented).toBe(true);
    expect(s.value).toBe(0.6);
    expect(onChange).toHaveBeenLastCalledWith(0.6);
    expect(key(field, 'ArrowDown').defaultPrevented).toBe(true);
    expect(s.value).toBe(0.5);
    expect(key(field, 'End').defaultPrevented).toBe(true);
    expect(s.value).toBe(1);
    expect(key(field, 'ArrowUp').defaultPrevented).toBe(true);
    expect(s.value).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(key(field, 'Home').defaultPrevented).toBe(true);
    expect(s.value).toBe(0);
    // Not its keys.
    expect(key(field, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(key(field, 'Tab').defaultPrevented).toBe(false);

    const [dec, inc] = [...s.element.querySelectorAll<HTMLButtonElement>('button.tc-button')];
    expect(dec.disabled).toBe(true);
    expect(inc.disabled).toBe(false);
    inc.click();
    expect(s.value).toBe(0.1);
    expect(dec.disabled).toBe(false);
    dec.click();
    expect(s.value).toBe(0);

    s.set(0.34);
    expect(s.value).toBe(0.3);
    expect(field.getAttribute('aria-valuenow')).toBe('0.3');
    s.set(9);
    expect(s.value).toBe(1);
    expect(inc.disabled).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(6);
  });

  it('defaults the text to the number', () => {
    const s = stepper('Count', 3, () => {}, { min: 1, max: 5, step: 1 });
    expect(s.element.querySelector('[role=spinbutton]')?.textContent).toBe('3');
  });
});

describe('cooldown', () => {
  it('sweeps with a custom property, is ready at 1, aria-hidden', () => {
    const c = cooldown({ size: 80 });
    expect(c.element.getAttribute('aria-hidden')).toBe('true');
    expect(c.element.style.getPropertyValue('--tc-ui-size')).toBe('80');
    expect(c.ready).toBe(true);
    expect(c.element.hasAttribute('data-ready')).toBe(true);
    c.set(0.25);
    expect(c.element.style.getPropertyValue('--tc-ui-sweep')).toBe('0.25');
    expect(c.ready).toBe(false);
    expect(c.element.hasAttribute('data-ready')).toBe(false);
    c.set(1.5);
    expect(c.element.style.getPropertyValue('--tc-ui-sweep')).toBe('1');
    expect(c.ready).toBe(true);
    expect(c.element.hasAttribute('data-ready')).toBe(true);
    expect(cooldown().element.style.getPropertyValue('--tc-ui-size')).toBe('64');
  });
});
