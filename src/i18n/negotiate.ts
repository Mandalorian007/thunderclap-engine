/** Locale matching and text direction. No `Intl.Locale` needed: BCP 47 tags split on `-`. */

export type TextDirection = 'ltr' | 'rtl';

/** Language subtags written right to left. Scripts are not consulted: `ar-Latn` is rare in games. */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'ha',
  'he',
  'iw',
  'khw',
  'ks',
  'ku',
  'ps',
  'sd',
  'syr',
  'ug',
  'ur',
  'yi',
]);

/** The language subtag of a BCP 47 tag, lower case: `pt-BR` → `pt`. */
export function languageOf(locale: string): string {
  return locale.split(/[-_]/, 1)[0].toLowerCase();
}

/** `'rtl'` when the language subtag is in `RTL_LANGUAGES`, else `'ltr'`. */
export function directionOf(locale: string): TextDirection {
  return RTL_LANGUAGES.has(languageOf(locale)) ? 'rtl' : 'ltr';
}

/** What the browser asks for, most preferred first; empty outside a browser. */
export function requestedLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * Picks the locale from `available` that best matches `requested` (most preferred first,
 * `navigator.languages` by default). For each requested tag in order: an exact match
 * (case-insensitive), else the first available tag sharing its language subtag (`en-US` → `en`
 * or `en-GB`). When nothing matches, `fallback` (the first entry of `available`).
 */
export function negotiateLocale(
  available: readonly string[],
  requested: readonly string[] = requestedLocales(),
  fallback: string = available[0],
): string {
  if (available.length === 0) return fallback;
  for (const want of requested) {
    const w = want.toLowerCase();
    const exact = available.find((a) => a.toLowerCase() === w);
    if (exact !== undefined) return exact;
    const lang = languageOf(want);
    const partial = available.find((a) => languageOf(a) === lang);
    if (partial !== undefined) return partial;
  }
  return fallback;
}
