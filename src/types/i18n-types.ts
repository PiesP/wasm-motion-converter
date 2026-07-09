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
  'app.navigation': string;
  'app.error.title': string;
  'app.error.description': string;
  'app.error.details': string;
  'app.error.retry': string;
  'app.error.reload': string;

  // Header / Footer
  'header.exportLogs': string;
  'header.exportLogsTooltip': string;
  'footer.viewLicenses': string;
  'footer.openIssue': string;
  'footer.licenseAttribution': string;
  'footer.linkGitHub': string;
  'footer.questions': string;

  // Dropzone
  'dropzone.dropHere': string;
  'dropzone.clickSelect': string;
  'dropzone.selectFile': string;
  'dropzone.cancelConversion': string;
  'dropzone.preview': string;
  'dropzone.processing': string;
  'dropzone.changeFile': string;
  'dropzone.formats': string;

  // Metadata
  'metadata.title': string;
  'metadata.file': string;
  'metadata.resolution': string;
  'metadata.duration': string;
  'metadata.fps': string;
  'metadata.codec': string;
  'metadata.size': string;
  'metadata.bitrate': string;
  'metadata.detecting': string;

  // Settings Panel
  'settings.heading': string;
  'settings.selectVideo': string;
  'settings.convert': string;
  'settings.stopConversion': string;
  'settings.tooltip.quality': string;
  'settings.tooltip.scale': string;
  'settings.tooltip.format': string;

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
  'frameSkip.adaptive': string;
  'frameSkip.adaptiveDesc': string;
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
  'trim.tooShort': string;
  'trim.startLabel': string;
  'trim.endLabel': string;

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
  'progress.frameCounter': string;
  'progress.frameCounterOutput': string;
  'progress.eta': string;
  'progress.calculating': string;
  'progress.initialElapsed': string;

  // Result
  'result.download': string;
  'result.originalSize': string;
  'result.outputSize': string;
  'result.format': string;
  'result.quality': string;
  'result.scale': string;
  'result.convertedAnimation': string;
  'result.downloadFile': string;
  'result.downloadButton': string;
  'result.compressionSmaller': string;
  'result.compressionLarger': string;
  'result.previewFailed': string;
  'result.heading': string;
  'result.aria.previewAlt': string;
  'result.aria.sectionLabel': string;

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
  'error.technicalDetails': string;
  'error.suggestion': string;

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
  'memory.recommendation': string;

  // License Attribution
  'license.processingNote': string;

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
  'env.notSupported': string;
  'env.coiFalse': string;
  'env.sabUnavailable': string;
  'env.detected': string;
  'env.localDevHint': string;
  'env.deployedHint': string;

  // Offline
  'offline.message': string;

  // Language Switcher
  'lang.select': string;

  // Option Selector
  'option.aria.tooltipInfo': string;

  // Conversion Progress
  'conversionProgress.aria.label': string;
}

/** Type-safe translation accessor */
export type TFunction = <K extends keyof TranslationKeys>(
  key: K,
  params?: Record<string, string | number>
) => TranslationKeys[K];

/** Individual translation key */
export type TranslationKey = keyof TranslationKeys;

/** Complete translation set */
export type Translations = { [K in keyof TranslationKeys]: TranslationKeys[K] };
