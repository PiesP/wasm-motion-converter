import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type LocaleInfo,
  type TranslationKeys,
  type Translations,
} from '@t/i18n-types';
import { updateDocumentLang } from '@utils/intl-utils';
import type { Component, JSX } from 'solid-js';
import { createContext, createEffect, createSignal, Show, useContext } from 'solid-js';

const LOCALE_STORAGE_KEY = 'dropconvert.locale';

export interface LocaleContextValue {
  locale: () => Locale;
  setLocale: (locale: Locale) => void;
  t: <K extends keyof TranslationKeys>(
    key: K,
    params?: Record<string, string | number>
  ) => TranslationKeys[K];
  localeInfo: () => LocaleInfo;
  isRTL: () => boolean;
  supportedLocales: typeof LOCALES;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

const translationCache = new Map<Locale, Translations>();

async function importLocale(locale: Locale): Promise<Translations> {
  const translations = (await import(`@i18n/${locale}.json`)) as {
    default: Translations;
  };
  return translations.default;
}

async function loadTranslations(locale: Locale): Promise<Translations> {
  const cached = translationCache.get(locale);
  if (cached) return cached;
  try {
    const translations = await importLocale(locale);
    translationCache.set(locale, translations);
    return translations;
  } catch {
    console.warn(`[i18n] Failed to load translations for "${locale}"`);
    if (locale !== DEFAULT_LOCALE) return loadTranslations(DEFAULT_LOCALE);
    throw new Error(`Failed to load default translations: ${DEFAULT_LOCALE}`);
  }
}

function getStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && LOCALES.some((l) => l.code === stored)) return stored as Locale;
  } catch {
    /* noop */
  }
  return null;
}

function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* noop */
  }
}

function detectInitialLocale(): Locale {
  const stored = getStoredLocale();
  if (stored) return stored;
  if (typeof navigator !== 'undefined') {
    const browserLangs = navigator.languages ?? (navigator.language ? [navigator.language] : []);
    for (const lang of browserLangs) {
      if (!lang) continue;
      const baseLang = lang.split('-')[0]?.toLowerCase() ?? lang.toLowerCase();
      const match = LOCALES.find(
        (l) =>
          l.code.toLowerCase() === lang.toLowerCase() || l.code.toLowerCase().startsWith(baseLang)
      );
      if (match) return match.code;
    }
  }
  return DEFAULT_LOCALE;
}

export interface LocaleProviderProps {
  children: JSX.Element;
  initialLocale?: Locale;
}

const Provider = LocaleContext.Provider;

export const LocaleProvider: Component<LocaleProviderProps> = (props) => {
  const [locale, setLocaleSignal] = createSignal<Locale>(
    props.initialLocale ?? detectInitialLocale()
  );
  const [translations, setTranslations] = createSignal<Translations | null>(null);

  // Load translations when locale changes.
  // The effect tracks locale() so it re-runs on language switch.
  // On re-run: sync document attr update, async load translations, then
  // update the translations signal — which triggers re-renders in every
  // component that calls t() (because t() reads translations()).
  // We do NOT unmount children mid-switch; <Show when={translations()}>
  // keeps them mounted once translations are first loaded.
  createEffect(() => {
    const currentLocaleValue = locale();
    const info = LOCALES.find((l) => l.code === currentLocaleValue)!;
    updateDocumentLang(currentLocaleValue, info.dir);
    loadTranslations(currentLocaleValue).then(setTranslations);
  });

  const setLocale = (newLocale: Locale): void => {
    setLocaleSignal(newLocale);
    saveLocale(newLocale);
  };

  const t = <K extends keyof TranslationKeys>(
    key: K,
    params?: Record<string, string | number>
  ): TranslationKeys[K] => {
    const loaded = translations();
    if (loaded) {
      let value = loaded[key];
      if (params && typeof value === 'string') {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(`{${k}}`, String(v)) as TranslationKeys[K];
        }
      }
      return value;
    }
    return key as unknown as TranslationKeys[K];
  };

  const localeInfo = (): LocaleInfo => LOCALES.find((l) => l.code === locale())!;
  const isRTL = (): boolean => localeInfo().dir === 'rtl';

  const value: LocaleContextValue = {
    locale,
    setLocale,
    t,
    localeInfo,
    isRTL,
    supportedLocales: LOCALES,
  };

  return (
    <Show
      when={translations()}
      fallback={
        <div class="flex min-h-screen items-center justify-center bg-[#08090a]">
          <div class="animate-pulse text-[#5e6ad2]">Loading...</div>
        </div>
      }
    >
      <Provider value={value}>{props.children}</Provider>
    </Show>
  );
};

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used within a LocaleProvider');
  return context;
}
