import { describe, expect, it } from 'vitest';
import { BASE_CSS } from './styles';

describe('BASE_CSS', () => {
  it('zooms native selects on frame layers and divides the theme tokens they read back out', () => {
    // The zoom rule: a select or slider on a frame layer scales by --tc-zoom with 1px units.
    expect(BASE_CSS).toMatch(
      /\[data-layer="hud"\][^{]*select[^{]*\{\s*zoom: var\(--tc-zoom, 1\); --tc-unit: 1px;/,
    );
    // Theme tokens resolve on the root in frame px already, so the zoomed select divides them
    // back out (ws/ui-3), otherwise it drew at --tc-dpx squared.
    const rule = BASE_CSS.match(
      /\[data-layer="hud"\][^{]*\bselect\s*,[^{]*\bselect\s*\{([^}]*)\}/g,
    );
    const fix = rule?.find((r) => r.includes('/ var(--tc-zoom, 1)'));
    expect(fix).toBeDefined();
    for (const token of [
      '--tc-font-size-s',
      '--tc-space-2',
      '--tc-space-3',
      '--tc-border-width',
      '--tc-radius-m',
    ])
      expect(fix).toContain(`calc(var(${token}) / var(--tc-zoom, 1))`);
    // The slider is not touched by the fix (its token use is already in --tc-unit px).
    expect(fix).not.toContain('range');
  });
});
