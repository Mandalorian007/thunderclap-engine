import { describe, expect, it } from 'vitest';
import { BASE_CSS } from './styles';

/** The rule (selector and body) whose body contains `needle`. */
function ruleWith(needle: string): { selector: string; body: string } {
  const css = BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[2].includes(needle));
  if (!hit) throw new Error(`no rule with ${needle}`);
  return { selector: hit[1].trim(), body: hit[2] };
}

const ZOOM = 'zoom: var(--tc-zoom, 1)';
const FIX = 'calc(var(--tc-font-size-s) / var(--tc-zoom, 1))';
const RING = 'outline-width: calc(var(--tc-focus-ring) / var(--tc-zoom, 1)';

describe('BASE_CSS', () => {
  it('zooms native selects on frame layers and divides the theme tokens they read back out', () => {
    // The zoom rule: a select or slider on a frame layer scales by --tc-zoom with 1px units.
    const zoom = ruleWith(ZOOM);
    expect(zoom.selector).toContain('[data-layer="hud"]');
    expect(zoom.selector).toContain('select');
    expect(zoom.body).toMatch(/^\s*zoom: var\(--tc-zoom, 1\); --tc-unit: 1px;/);
    // Theme tokens resolve on the root in frame px already, so the zoomed select divides them
    // back out (ws/ui-3), otherwise it drew at --tc-dpx squared.
    const fix = ruleWith(FIX);
    expect(fix.selector).toContain('[data-layer="hud"]');
    for (const token of [
      '--tc-font-size-s',
      '--tc-space-2',
      '--tc-space-3',
      '--tc-border-width',
      '--tc-radius-m',
    ])
      expect(fix.body).toContain(`calc(var(${token}) / var(--tc-zoom, 1))`);
    // The slider is not touched by the fix (its token use is already in --tc-unit px).
    expect(fix.selector).not.toContain('range');
  });

  it('keeps the zoomed-select rules below ordinary game rules (#3)', () => {
    // Zoom and token fix for any select: the whole selector list is one :where(), so the
    // specificity is (0,0,0) and a game's `.my-panel select` (0,1,1) wins.
    expect(ruleWith(ZOOM).selector).toMatch(/^:where\([\s\S]*\)$/);
    const [generic, widget] = ruleWith(FIX).selector.split(/\),\s*:where\(/);
    expect(generic).toMatch(/^:where\(/);
    expect(generic).toContain('select');
    // The engine's own select widget keeps the fix over its (0,1,1) `.tc-ui-select select`
    // rule: the context in :where(), then `.tc-field.tc-ui-select select` (0,2,1).
    expect(widget).toMatch(/\)\s*\.tc-field\.tc-ui-select select$/);
    // The focus ring: the context in :where(), then (0,2,1), just over `.tc-overlay :focus-visible`.
    expect(ruleWith(RING).selector).toMatch(
      /^:where\([\s\S]*\)\s*:is\(input\[type="range"\], select\):focus-visible$/,
    );
  });
});
