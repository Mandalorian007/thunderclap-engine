/**
 * Layout harness page (D-041 Phase 2, ws/layout): a CSS-px overlay over the whole viewport with
 * `createLayout` and a widget in every region, so e2e/layout.spec.ts can check region placement,
 * safe areas, tap sizes and orientation changes on every matrix row. Noun-free; no WebGPU.
 *
 * - `top`: a title and a menu button; upright phones also take the help button here.
 * - `left` / `right`: icon buttons (rails); on an upright phone left keeps back and undo, right
 *   keeps options.
 * - `bottom`: a toggle and a slider.
 * - `cardLane`: a short text card.
 * - `captionLane`: the overlay's caption card, docked.
 * - `fill`: nothing; a dashed outline below the overlay shows `freeRect` (the world's space).
 * - `free`: one badge, the escape hatch, pinned to the top-right corner of `freeRect`.
 */
import { button, createLayout, createOverlay, h, slider, toggle } from '../src/ui';
import { applyTextScale } from '../src/ui/text-scale';
import type { HarnessLayoutApi, HarnessLayoutState } from './layout-state';

const root = document.getElementById('root') as HTMLElement;
const world = h('div', {
  class: 'probe-world',
  style: { position: 'absolute', border: '2px dashed #3a6', boxSizing: 'border-box' },
});
const home = h('div', { id: 'home', tabindex: '-1', 'aria-label': 'Home' });
root.append(world, home);

const ui = createOverlay({
  parent: root,
  legacyScale: false,
  focusHome: () => home,
  caption: { reducedMotion: true },
});
ui.setRect({ x: 0, y: 0, width: root.clientWidth, height: root.clientHeight });
const layout = createLayout(ui);

const state: HarnessLayoutState = {
  ready: false,
  formFactor: null,
  regions: {} as HarnessLayoutState['regions'],
  freeRect: null,
  safeArea: null,
  freeUses: [],
  changes: 0,
  placed: {},
};

const icon = (id: string, glyph: string, label: string) => {
  const b = button(glyph, () => {}, { ariaLabel: label });
  b.id = id;
  b.classList.add('probe-widget');
  return b;
};
const widget = <T extends HTMLElement>(el: T, id: string): T => {
  el.id = id;
  el.classList.add('probe-widget');
  return el;
};

const handles = [
  layout.add(
    widget(
      h(
        'div',
        { style: { fontSize: 'var(--tc-font-size-l)', fontFamily: 'var(--tc-font-display)' } },
        'Title',
      ),
      'w-title',
    ),
    { place: { default: 'top' } },
  ),
  layout.add(icon('w-menu', '☰', 'Menu'), { place: { default: 'top' }, order: 1 }),
  layout.add(icon('w-back', '←', 'Back'), { place: { default: 'left' } }),
  layout.add(icon('w-undo', '↶', 'Undo'), { place: { default: 'left' } }),
  layout.add(icon('w-options', '⚙', 'Options'), { place: { default: 'right' } }),
  layout.add(icon('w-help', '?', 'Help'), {
    place: { default: 'right', 'phone-portrait': 'top' },
    order: 2,
  }),
  layout.add(widget(toggle('Toggle', true, () => {}).element, 'w-toggle'), {
    place: { default: 'bottom' },
  }),
  layout.add(widget(slider('Level', 0.5, () => {}).element, 'w-slider'), {
    place: { default: 'bottom' },
  }),
  layout.add(
    widget(
      h(
        'div',
        {
          class: 'tc-card',
          style: { padding: 'var(--tc-space-3)', fontSize: 'var(--tc-font-size-s)' },
        },
        'A card with a few words of text.',
      ),
      'w-card',
    ),
    { place: { default: 'cardLane' } },
  ),
  layout.add(
    widget(
      h(
        'div',
        {
          class: 'tc-card',
          style: { padding: '2px 6px', fontSize: 'var(--tc-font-size-s)', boxSizing: 'border-box' },
        },
        'Free',
      ),
      'w-free',
    ),
    {
      place: {
        default: {
          region: 'free',
          reason: 'harness: escape-hatch probe pinned to the corner of freeRect',
          rect: (s) => ({
            x: s.freeRect.x + s.freeRect.width - 64,
            y: s.freeRect.y + 8,
            width: 56,
            height: 28,
          }),
        },
      },
    },
  ),
];
// ⚙ opens Options through `stack.replace`, the pattern a game menu uses, so tapping it again
// (or spamming it) never stacks a second copy.
const openOptions = () =>
  ui.stack.replace({ title: 'Options', content: button('Done', () => ui.stack.pop()) });
document.getElementById('w-options')!.addEventListener('click', openOptions);
const caption = layout.dockCaption();
ui.caption.say('A caption line in its lane.', { speaker: 'Speaker', hold: 0 });

const publish = () => {
  const s = layout.state;
  state.formFactor = s.formFactor;
  state.regions = JSON.parse(JSON.stringify(s.regions));
  state.freeRect = { ...s.freeRect };
  state.safeArea = { ...s.safeArea };
  state.freeUses = [...layout.freeUses];
  state.placed = Object.fromEntries(handles.map((hd) => [hd.element.id, hd.region]));
  state.placed.caption = caption.region;
  Object.assign(world.style, {
    left: `${s.freeRect.x}px`,
    top: `${s.freeRect.y}px`,
    width: `${s.freeRect.width}px`,
    height: `${s.freeRect.height}px`,
  });
};
layout.onChange(() => {
  state.changes++;
  publish();
});
publish();

window.addEventListener('resize', () => {
  ui.setRect({ x: 0, y: 0, width: root.clientWidth, height: root.clientHeight });
});

const api: HarnessLayoutApi = {
  state,
  setTextScale(s) {
    applyTextScale(ui.root, s, (t) => ui.setTheme(t));
  },
  refresh() {
    layout.refresh();
  },
  openPanel(items) {
    const content = h('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 'var(--tc-space-2)' },
    });
    for (let i = 1; i <= items; i++) {
      content.append(button(i === items ? 'Last' : `Item ${i}`, () => {}));
    }
    ui.stack.push({ title: 'Panel', content });
  },
  spamOptions(times) {
    for (let i = 0; i < times; i++) openOptions();
  },
  panels: () => ({ stack: ui.stack.size, dom: ui.root.querySelectorAll('.tc-panel').length }),
};
window.__harnessLayout = api;
state.ready = true;
