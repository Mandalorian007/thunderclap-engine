/**
 * The layout spec: where the HUD goes on each form factor. The engine's `defaultForms` already
 * draw a sensible grid (top bar, side columns, card and caption lanes, bottom bar) per form
 * factor; this spec only overrides what this game wants, field by field. Regions a widget never
 * uses collapse, so the board (the `fill` region, `ctx.ui.layout.freeRect`) gets the rest.
 *
 * Tracks are CSS px, `'fill'`, or a fraction of the safe area clamped to `[min, max]`.
 */
import type { LayoutSpec } from '@thunderclap/engine/ui';

export const layoutSpec: LayoutSpec = {
  forms: {
    // A puzzle wants the board big: a slim top bar for the counters and a slim bottom bar for
    // the actions; no side columns, no card lane.
    desktop: {
      columns: ['fill'],
      rows: [64, 'fill', 72],
      areas: ['top', 'fill', 'bottom'],
    },
    tablet: {
      columns: ['fill'],
      rows: [68, 'fill', 76],
      areas: ['top', 'fill', 'bottom'],
    },
    // Landscape phones are short: the counters stack in the `right` column beside the board (a
    // column region, so lines stack) and no vertical space is spent on bars.
    'phone-landscape': {
      columns: ['fill', { frac: 0.3, min: 150, max: 220 }],
      rows: ['fill', 'fill'],
      areas: ['fill right', 'fill bottom'],
      pad: 8,
    },
    'phone-portrait': {
      columns: ['fill'],
      rows: [56, 'fill', 72],
      areas: ['top', 'fill', 'bottom'],
      pad: 8,
    },
  },
};
