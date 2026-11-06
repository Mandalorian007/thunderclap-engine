/**
 * What the localisation harness page (harness/i18n.html) publishes on `window.__harnessI18n`
 * for e2e/i18n.spec.ts. Shared by the page (harness/i18n.ts) and the spec.
 */
export interface HarnessI18nState {
  /** True once the starting locale is loaded and the page rendered. */
  ready: boolean;
  /** `i18n.locale`. */
  locale: string;
  /** `i18n.direction`. */
  direction: 'ltr' | 'rtl';
  /** `t('items', { count })`: the plural counter's text. */
  sample: string;
  /** The counter's value. */
  count: number;
  /** `negotiateLocale(i18n.locales)` against the browser's languages. */
  negotiated: string;
  /** Re-renders triggered by `subscribe`. */
  renders: number;
}

export interface HarnessI18nApi {
  state: HarnessI18nState;
  /** `i18n.setLocale`, then one render. */
  setLocale(locale: string): Promise<void>;
  setCount(n: number): void;
}

declare global {
  interface Window {
    __harnessI18n?: HarnessI18nApi;
  }
}
