// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  applyTextScale,
  scaledPx,
  scaleFontSizes,
  scalePxCss,
  TEXT_MIN_VAR,
  TEXT_SCALE_VAR,
  textScaleTokens,
} from './text-scale';

describe('text scale', () => {
  it('names the density tokens', () => {
    expect(TEXT_SCALE_VAR).toBe('--tc-text-scale');
    expect(TEXT_MIN_VAR).toBe('--tc-text-min');
  });

  it('scales body text fully and big display text only as far as body text', () => {
    expect(scaledPx(24, 1.5)).toBe(36);
    expect(scaledPx(30, 1.5)).toBe(45);
    expect(scaledPx(40, 1.5)).toBe(45);
    expect(scaledPx(56, 1.5)).toBe(56);
    expect(scaledPx(24, 1)).toBe(24);
    expect(scaledPx(84, 1.25)).toBe(84);
  });

  it('CSS lengths follow the variable and agree with scaledPx', () => {
    expect(scalePxCss(20)).toBe(
      'max(calc(20px * var(--tc-text-scale, 1)), var(--tc-text-min, 0px))',
    );
    expect(scalePxCss(40)).toBe(
      'max(40px, calc(30px * var(--tc-text-scale, 1)), var(--tc-text-min, 0px))',
    );
    expect(scalePxCss(62)).toBe('62px');
  });

  it('rewrites font-size declarations and the font shorthand', () => {
    const css =
      '.a { font-size: 19px; } .b { font: 400 26px/1.4 system-ui; } .c { font-size: 62px; }';
    const out = scaleFontSizes(css);
    expect(out).toContain(
      '.a { font-size: max(calc(19px * var(--tc-text-scale, 1)), var(--tc-text-min, 0px)); }',
    );
    expect(out).toContain(
      '.b { font: 400 max(calc(26px * var(--tc-text-scale, 1)), var(--tc-text-min, 0px))/1.4 system-ui; }',
    );
    expect(out).toContain('.c { font-size: 62px; }');
    // Other lengths are left alone.
    expect(scaleFontSizes('.d { width: 24px; margin: 30px; }')).toBe(
      '.d { width: 24px; margin: 30px; }',
    );
  });

  it('engine font tokens', () => {
    expect(textScaleTokens(1)).toEqual({
      fontSizeS: 'max(24px, var(--tc-text-min, 0px))',
      fontSizeM: 'max(30px, var(--tc-text-min, 0px))',
      fontSizeL: 'max(40px, var(--tc-text-min, 0px))',
      fontSizeXl: '56px',
      fontSizeXxl: '84px',
    });
    expect(textScaleTokens(1.5).fontSizeS).toBe('max(36px, var(--tc-text-min, 0px))');
    expect(textScaleTokens(1.5).fontSizeL).toBe('max(45px, var(--tc-text-min, 0px))');
  });

  it('applyTextScale sets the token, the percent flag and the theme', () => {
    const root = document.createElement('div');
    let theme: Record<string, string> = {};
    applyTextScale(root, 1.25, (t) => {
      theme = t;
    });
    expect(root.style.getPropertyValue('--tc-text-scale')).toBe('1.25');
    expect(root.dataset.textScale).toBe('125');
    expect(theme.fontSizeS).toBe('max(30px, var(--tc-text-min, 0px))');
    applyTextScale(root, 1);
    expect(root.style.getPropertyValue('--tc-text-scale')).toBe('1');
    expect(root.dataset.textScale).toBeUndefined();
  });
});
