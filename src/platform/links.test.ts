// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { embedContext, safeExternalUrl } from './links';

describe('safeExternalUrl', () => {
  it('accepts plain https links and trims them', () => {
    expect(safeExternalUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1');
    expect(safeExternalUrl('  https://example.com  ')).toBe('https://example.com');
  });
  it('rejects blank, non-https, credentials and junk (hide the control)', () => {
    for (const bad of [
      '',
      '   ',
      null,
      undefined,
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//example.com',
      'example.com',
      'https://user:pw@example.com',
      'https://exa mple.com',
      'https://',
    ]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });
});

describe('embedContext', () => {
  it('top level when self is top', () => {
    const w = {} as { self: unknown; top: unknown };
    w.self = w;
    w.top = w;
    expect(embedContext(w as unknown as Window)).toBe('top');
  });
  it('same-origin frame when the parent location is readable', () => {
    const top = { location: { href: 'https://a.test/' } };
    expect(embedContext({ self: {}, top } as unknown as Window)).toBe('same-origin-frame');
  });
  it('cross-origin frame when reading the parent throws', () => {
    const top = {
      get location(): never {
        throw new DOMException('Blocked', 'SecurityError');
      },
    };
    expect(embedContext({ self: {}, top } as unknown as Window)).toBe('cross-origin-frame');
  });
});
