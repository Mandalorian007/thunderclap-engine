// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createRotateCard, type RotateCard } from './rotate-card';

function viewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

function fakeDevice(phone: boolean, touch: boolean) {
  const subs = new Set<() => void>();
  return {
    phone,
    touch,
    onChange(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    emit() {
      for (const f of subs) f();
    },
  };
}

let card: RotateCard | null = null;
afterEach(() => {
  card?.destroy();
  card = null;
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('rotate card', () => {
  it('renders the game’s words as a labelled dialog', () => {
    card = createRotateCard({
      title: 'Turn it',
      lines: ['Line one.', 'Line two.'],
      note: { tag: 'TAG', text: 'A note.' },
    });
    const el = card.element;
    expect(el.parentElement).toBe(document.body);
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-label')).toBe('Turn it');
    expect(el.querySelector('h2')?.textContent).toBe('Turn it');
    expect([...el.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Line one.',
      'Line two.',
      'TAGA note.',
    ]);
    expect(document.querySelectorAll('style[data-tc="rotate-card"]').length).toBe(1);
  });

  it('applies colours as custom properties on the card', () => {
    card = createRotateCard({ title: 'T', colors: { accent: '#123456', background: 'black' } });
    expect(card.element.style.getPropertyValue('--tc-rotate-accent')).toBe('#123456');
    expect(card.element.style.getPropertyValue('--tc-rotate-bg')).toBe('black');
    expect(card.element.style.getPropertyValue('--tc-rotate-text')).toBe('');
  });

  it('shows upright on a phone in hand and hides when it turns', () => {
    viewport(844, 390);
    const device = fakeDevice(true, true);
    card = createRotateCard({ title: 'T', device });
    expect(card.visible).toBe(false);
    viewport(390, 844);
    expect(card.visible).toBe(true);
    viewport(844, 390);
    expect(card.visible).toBe(false);
  });

  it('never shows for a narrow window without a finger on a phone-scale screen', () => {
    viewport(390, 844);
    const device = fakeDevice(true, false);
    card = createRotateCard({ title: 'T', device });
    expect(card.visible).toBe(false);
    device.touch = true;
    device.emit();
    expect(card.visible).toBe(true);
  });

  it('destroy removes the card and its listeners', () => {
    viewport(390, 844);
    const device = fakeDevice(true, true);
    card = createRotateCard({ title: 'T', device });
    const el = card.element;
    card.destroy();
    card = null;
    expect(el.isConnected).toBe(false);
  });
});
