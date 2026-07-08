// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * i18n Type Definitions
 *
 * Type-safe translation system for wasm-motion-converter.
 * Uses flat keys (section.component.element) for consistency.
 * Extends the base types defined in @t/i18n-types.
 */

import type { TranslationKeys } from '@t/i18n-types';

/** Re-export LOCALES and DEFAULT_LOCALE for convenience */
export { DEFAULT_LOCALE, LOCALES } from '@t/i18n-types';
export type { Locale, LocaleInfo, TranslationKeys, Translations } from '@t/i18n-types';

/** Type-safe translation export function */
export type TFunction = <K extends keyof TranslationKeys>(key: K) => TranslationKeys[K];

/** Partial translation for incomplete locales */
export type PartialTranslations = Partial<TranslationKeys>;
