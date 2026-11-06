import { describe, expect, it, vi } from 'vitest';
import { directionOf, languageOf, negotiateLocale, RTL_LANGUAGES } from './negotiate';

describe('negotiateLocale', () => {
  const available = ['en', 'pt-BR', 'ru'];

  it('exact match wins, case-insensitively', () => {
    expect(negotiateLocale(available, ['ru'])).toBe('ru');
    expect(negotiateLocale(available, ['PT-br'])).toBe('pt-BR');
  });

  it('the request order wins: a language match earlier beats an exact match later', () => {
    expect(negotiateLocale(available, ['en-US', 'ru'])).toBe('en');
    expect(negotiateLocale(['en', 'en-GB'], ['en-GB', 'en-US'])).toBe('en-GB');
    expect(negotiateLocale(['en', 'en-GB'], ['en-AU', 'en-GB'])).toBe('en');
  });

  it('language match: en-US → en, pt → pt-BR, en-GB → en', () => {
    expect(negotiateLocale(available, ['en-US'])).toBe('en');
    expect(negotiateLocale(available, ['pt'])).toBe('pt-BR');
    expect(negotiateLocale(available, ['en-GB'])).toBe('en');
    expect(negotiateLocale(available, ['pt-PT', 'ru'])).toBe('pt-BR');
  });

  it('falls back to the first available, or the given fallback', () => {
    expect(negotiateLocale(available, ['ja', 'ko'])).toBe('en');
    expect(negotiateLocale(available, ['ja'], 'ru')).toBe('ru');
    expect(negotiateLocale(available, [])).toBe('en');
    expect(negotiateLocale([], ['en'], 'x')).toBe('x');
  });

  it('defaults the request to navigator.languages when there is one', () => {
    vi.stubGlobal('navigator', { languages: ['ru-RU', 'en'], language: 'ru-RU' });
    try {
      expect(negotiateLocale(available)).toBe('ru');
      vi.stubGlobal('navigator', { languages: [], language: 'pt-BR' });
      expect(negotiateLocale(available)).toBe('pt-BR');
      vi.stubGlobal('navigator', undefined);
      expect(negotiateLocale(available)).toBe('en');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('direction', () => {
  it('languageOf lower-cases the first subtag, with - or _', () => {
    expect(languageOf('pt-BR')).toBe('pt');
    expect(languageOf('EN_us')).toBe('en');
    expect(languageOf('ar')).toBe('ar');
  });

  it('rtl for the RTL set, ltr otherwise', () => {
    for (const l of ['ar', 'ar-EG', 'he', 'he-IL', 'fa', 'ur', 'yi'])
      expect(directionOf(l)).toBe('rtl');
    for (const l of ['en', 'ru', 'ja', 'zh-Hant', 'pt-BR', '']) expect(directionOf(l)).toBe('ltr');
    expect(RTL_LANGUAGES.has('ar')).toBe(true);
  });
});
