// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * use-i18n Hook
 *
 * Provides reactive i18n functionality to SolidJS components.
 * Reads locale from localStorage (key: 'app-locale'), defaults to browser language.
 * Supports: 'en', 'ko' (extensible).
 */

import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type PartialTranslations,
  type TranslationKeys,
} from '@t/i18n-types';
import { type Accessor, createEffect, createMemo, createSignal } from 'solid-js';
import { detectInitialLocale } from './locale-store';

/** Storage key for locale preference */
const LOCALE_STORAGE_KEY = 'app-locale';

/** Translation cache to avoid re-loading */
const translationCache = new Map<Locale, PartialTranslations>();

/**
 * Load translations for a given locale (async, cached).
 */
async function loadTranslations(locale: Locale): Promise<PartialTranslations> {
  const cached = translationCache.get(locale);
  if (cached) return cached;

  try {
    const translations = (await import(`./locales/${locale}.json`)) as {
      default: PartialTranslations;
    };
    translationCache.set(locale, translations.default);
    return translations.default;
  } catch {
    console.warn(`[i18n] Failed to load translations for "${locale}"`);
    if (locale !== DEFAULT_LOCALE) {
      return loadTranslations(DEFAULT_LOCALE);
    }
    throw new Error(`Failed to load default translations: ${DEFAULT_LOCALE}`);
  }
}

/**
 * Store interface returned by useI18n hook.
 */
export interface UseI18nReturn {
  /** Current locale (reactive accessor) */
  locale: Accessor<Locale>;
  /** Set locale and persist to localStorage */
  setLocale: (locale: Locale) => void;
  /** Translation function */
  t: <K extends keyof TranslationKeys>(key: K) => TranslationKeys[K];
  /** All supported locales */
  locales: typeof LOCALES;
  /** Whether translations are currently loading */
  isLoading: Accessor<boolean>;
  /** Current locale info */
  localeInfo: Accessor<(typeof LOCALES)[number] | undefined>;
  /** Is RTL layout */
  isRTL: Accessor<boolean>;
}

/**
 * useI18n hook for reactive internationalization.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { t, locale, setLocale } = useI18n();
 *   return (
 *     <div>
 *       <p>{t('settings.convert')}</p>
 *       <button onClick={() => setLocale('ko')}>한국어</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useI18n(): UseI18nReturn {
  const [locale, setLocaleSignal] = createSignal<Locale>(detectInitialLocale());
  const [isLoading, setIsLoading] = createSignal(true);

  // Load translations when locale changes (SolidJS createEffect doesn't support async)
  createEffect(() => {
    const currentLocale = locale();
    setIsLoading(true);
    loadTranslations(currentLocale)
      .then(() => {
        setIsLoading(false);
      })
      .catch(() => {
        setIsLoading(false);
      });
  });

  // Update documentElement lang on locale change
  createEffect(() => {
    const currentLocale = locale();
    document.documentElement.lang = currentLocale;
    const info = LOCALES.find((l) => l.code === currentLocale);
    if (info) {
      document.documentElement.dir = info.dir;
    }
  });

  /**
   * Translation function.
   * Falls back to the key value if translation is missing.
   */
  const t = <K extends keyof TranslationKeys>(key: K): TranslationKeys[K] => {
    const currentLocale = locale();
    const cache = translationCache.get(currentLocale);
    if (cache) {
      return cache[key] as TranslationKeys[K];
    }
    // Fallback: try default locale
    const defaultCache = translationCache.get(DEFAULT_LOCALE);
    if (defaultCache) {
      return defaultCache[key] as TranslationKeys[K];
    }
    // Last resort: return the key itself
    return key as unknown as TranslationKeys[K];
  };

  /** Set locale and persist */
  const setLocaleWithPersistence = (newLocale: Locale): void => {
    setLocaleSignal(newLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    } catch {
      /* localStorage unavailable */
    }
  };

  /** Current locale info */
  const localeInfo = createMemo(() => LOCALES.find((l) => l.code === locale()));

  /** Is RTL */
  const isRTL = createMemo(() => localeInfo()?.dir === 'rtl');

  return {
    locale,
    setLocale: setLocaleWithPersistence,
    t,
    locales: LOCALES,
    isLoading,
    localeInfo,
    isRTL,
  };
}

export type { Locale, TranslationKeys };
