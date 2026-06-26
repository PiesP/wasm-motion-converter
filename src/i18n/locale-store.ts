// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Locale Store
 *
 * SolidJS reactive store for locale management.
 * Persists locale choice to localStorage, defaults to browser language.
 */

import { DEFAULT_LOCALE, LOCALES, type Locale } from '@t/i18n-types';
import { createEffect, createSignal } from 'solid-js';

const LOCALE_STORAGE_KEY = 'app-locale';

/** Supported locale codes (extensible) */
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ko'] as const;

/**
 * Detect user's preferred locale from browser settings.
 */
function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;

  const browserLangs = navigator.languages ?? (navigator.language ? [navigator.language] : []);
  if (browserLangs.length === 0) return DEFAULT_LOCALE;

  for (const lang of browserLangs) {
    if (!lang) continue;
    const baseLang = lang.split('-')[0]?.toLowerCase() ?? lang.toLowerCase();

    // Try exact match first
    const exactMatch = LOCALES.find((l) => l.code.toLowerCase() === lang.toLowerCase());
    if (exactMatch) return exactMatch.code;

    // Try base language match
    const baseMatch = LOCALES.find(
      (l) => l.code.toLowerCase().startsWith(baseLang) || baseLang.startsWith(l.code.toLowerCase())
    );
    if (baseMatch) return baseMatch.code;
  }

  return DEFAULT_LOCALE;
}

/**
 * Get stored locale from localStorage.
 */
function getStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && LOCALES.some((l) => l.code === stored)) {
      return stored as Locale;
    }
  } catch {
    /* localStorage unavailable */
  }
  return null;
}

/**
 * Save locale to localStorage.
 */
function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Detect initial locale: stored preference → browser language → default.
 */
export function detectInitialLocale(): Locale {
  const stored = getStoredLocale();
  if (stored) return stored;
  return detectBrowserLocale();
}

// ─── Reactive Store ────────────────────────────────────────────────────────

let localeSignal: ReturnType<typeof createSignal<Locale>> | null = null;
let initialized = false;

/**
 * Initialize the locale store (call once at app startup).
 * Sets up the reactive signal and syncs with document.documentElement.lang.
 */
export function initLocaleStore(): void {
  if (initialized) return;
  initialized = true;

  localeSignal = createSignal<Locale>(detectInitialLocale());

  // Sync locale to document.documentElement.lang on change
  createEffect(() => {
    if (!localeSignal) return;
    const [locale] = localeSignal;
    const info = LOCALES.find((l) => l.code === locale());
    document.documentElement.lang = locale();
    if (info) {
      document.documentElement.dir = info.dir;
    }
  });
}

/**
 * Get the current locale signal (for use in components).
 * Must call initLocaleStore() first.
 */
export function getLocaleSignal(): ReturnType<typeof createSignal<Locale>> {
  if (!localeSignal) {
    initLocaleStore();
  }
  return localeSignal!;
}

/**
 * Set the current locale and persist it.
 */
export function setLocale(locale: Locale): void {
  const [_, setLocaleFn] = getLocaleSignal();
  setLocaleFn(locale);
  saveLocale(locale);
  const info = LOCALES.find((l) => l.code === locale);
  document.documentElement.lang = locale;
  if (info) {
    document.documentElement.dir = info.dir;
  }
}

/**
 * Hook-compatible locale store interface.
 */
export interface LocaleStore {
  locale: () => Locale;
  setLocale: (locale: Locale) => void;
  supportedLocales: typeof LOCALES;
}

/**
 * Create a locale store instance (for use with createSignal pattern).
 * Returns a tuple of [locale, setLocale, store API].
 */
export function createLocaleStore(): [() => Locale, (locale: Locale) => void, LocaleStore] {
  const [locale, setLocaleSignal] = createSignal<Locale>(detectInitialLocale());

  // Sync document lang on locale change
  createEffect(() => {
    const current = locale();
    const info = LOCALES.find((l) => l.code === current);
    document.documentElement.lang = current;
    if (info) {
      document.documentElement.dir = info.dir;
    }
  });

  const setLocaleWithPersistence = (newLocale: Locale): void => {
    setLocaleSignal(newLocale);
    saveLocale(newLocale);
    const info = LOCALES.find((l) => l.code === newLocale);
    document.documentElement.lang = newLocale;
    if (info) {
      document.documentElement.dir = info.dir;
    }
  };

  const store: LocaleStore = {
    locale,
    setLocale: setLocaleWithPersistence,
    supportedLocales: LOCALES,
  };

  return [locale, setLocaleWithPersistence, store];
}

export type { Locale } from '@t/i18n-types';
export { DEFAULT_LOCALE, LOCALES };
