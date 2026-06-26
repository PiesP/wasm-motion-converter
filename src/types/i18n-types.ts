// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * i18n Type Definitions
 *
 * Type-safe translation system for wasm-motion-converter.
 * Uses flat keys (section.component.element) for consistency.
 */

/** Supported locale identifiers (BCP 47) */
export type Locale = 'en' | 'ko' | 'ja' | 'zh-CN' | 'es' | 'ar';

/** Locale metadata */
export interface LocaleInfo {
  code: Locale;
  name: string; // Native name
  englishName: string;
  dir: 'ltr' | 'rtl';
}

/** Available locales */
export const LOCALES: LocaleInfo[] = [
  { code: 'en', name: 'English', englishName: 'English', dir: 'ltr' },
  { code: 'ko', name: '한국어', englishName: 'Korean', dir: 'ltr' },
  { code: 'ja', name: '日本語', englishName: 'Japanese', dir: 'ltr' },
  { code: 'zh-CN', name: '简体中文', englishName: 'Chinese (Simplified)', dir: 'ltr' },
  { code: 'es', name: 'Español', englishName: 'Spanish', dir: 'ltr' },
  { code: 'ar', name: 'العربية', englishName: 'Arabic', dir: 'rtl' },
];

/** Default locale */
export const DEFAULT_LOCALE: Locale = 'en';

/** Translation namespace keys */
export interface TranslationKeys {
  // App-level
  'app.title': string;
  'app.subtitle': string;
  'app.skipToMain': string;
  'app.error.title': string;
  'app.error.description': string;
  'app.error.details': string;

  // Header / Footer
  'header.exportLogs': string;
  'header.exportLogsTooltip': string;
  'footer.viewLicenses': string;
  'footer.openIssue': string;

  // Dropzone
  'dropzone.dropHere': string;
  'dropzone.clickSelect': string;
  'dropzone.dragActive': string;
  'dropzone.selectFile': string;
  'dropzone.cancelConversion': string;
  'dropzone.preview': string;
  'dropzone.processing': string;

  // Metadata
  'metadata.detecting': string;

  // Settings Panel
  'settings.title': string;
  'settings.selectVideo': string;
  'settings.convert': string;
  'settings.stopConversion': string;
  'settings.tooltip.quality': string;
  'settings.tooltip.scale': string;

  // Format Selector
  'format.title': string;
  'format.gif': string;
  'format.gifDesc': string;
  'format.webp': string;
  'format.webpDesc': string;

  // Quality Selector
  'quality.title': string;
  'quality.low': string;
  'quality.lowDesc': string;
  'quality.medium': string;
  'quality.mediumDesc': string;
  'quality.high': string;
  'quality.highDesc': string;

  // Scale Selector
  'scale.title': string;

  // Smart Frame Skip
  'frameSkip.title': string;
  'frameSkip.off': string;
  'frameSkip.offDesc': string;
  'frameSkip.low': string;
  'frameSkip.lowDesc': string;
  'frameSkip.medium': string;
  'frameSkip.mediumDesc': string;
  'frameSkip.high': string;
  'frameSkip.highDesc': string;
  'frameSkip.tooltip': string;

  // Trim
  'trim.full': string;
  'trim.first5s': string;
  'trim.last5s': string;
  'trim.first15s': string;
  'trim.last15s': string;
  'trim.first30s': string;
  'trim.last30s': string;
  'trim.firstHalf': string;
  'trim.secondHalf': string;
  'trim.range': string;
  'trim.start': string;
  'trim.end': string;
  'trim.reset': string;

  // Progress
  'progress.demux': string;
  'progress.decode': string;
  'progress.encode': string;
  'progress.final': string;
  'progress.demuxing': string;
  'progress.decoding': string;
  'progress.encoding': string;
  'progress.assembling': string;
  'progress.analyzing': string;
  'progress.readingMetadata': string;
  'progress.preparing': string;
  'progress.finalizing': string;
  'progress.converting': string;
  'progress.cancelling': string;

  // Result
  'result.download': string;
  'result.originalSize': string;
  'result.outputSize': string;
  'result.format': string;
  'result.quality': string;
  'result.scale': string;
  'result.convertedAnimation': string;

  // Errors
  'error.format': string;
  'error.codec': string;
  'error.timeout': string;
  'error.memory': string;
  'error.unknown': string;
  'error.conversionFailed': string;
  'error.dismiss': string;
  'error.retry': string;
  'error.selectDifferent': string;
  'error.selectDifferentFallback': string;

  // Validation
  'validation.fileTooLarge': string;
  'validation.unsupportedFormat': string;
  'validation.unsupportedMimeType': string;
  'validation.invalidDuration': string;
  'validation.extractDurationFailed': string;
  'validation.noValidation': string;
  'validation.noValidationDetail': string;

  // Memory Warning
  'memory.title': string;
  'memory.titleActive': string;
  'memory.description': string;
  'memory.descriptionActive': string;
  'memory.cancelRetry': string;
  'memory.reduceStart': string;
  'memory.cancel': string;
  'memory.dismiss': string;

  // Confirmation Modal
  'modal.title': string;
  'modal.cancel': string;
  'modal.confirm': string;

  // Environment Warning
  'env.available': string;
  'env.unavailable': string;
  'env.logCapabilities': string;
  'env.showDetails': string;
  'env.hideDetails': string;

  // Offline
  'offline.message': string;

  // Language Switcher
  'lang.label': string;
  'lang.select': string;
}

/** Type-safe translation accessor */
export type TFunction = <K extends keyof TranslationKeys>(key: K) => TranslationKeys[K];

/** Individual translation key */
export type TranslationKey = keyof TranslationKeys;

/** Partial translation for incomplete locales */
export type PartialTranslations = Partial<TranslationKeys>;

/** Complete translation set */
export type Translations = { [K in keyof TranslationKeys]: TranslationKeys[K] };
