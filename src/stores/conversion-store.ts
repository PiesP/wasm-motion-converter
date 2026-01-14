/**
 * Conversion Store
 *
 * Central store for video conversion state management.
 * Manages input file, video metadata, conversion settings, progress tracking,
 * results, and error states. Settings are persisted to localStorage.
 */

// External dependencies
import { createSignal } from 'solid-js';
// Type imports
import type {
  ConversionResult,
  ConversionSettings,
  ErrorContext,
  PerformanceWarning,
  VideoMetadata,
} from '@t/conversion-types';
// Internal imports
import { logger } from '@utils/logger';

/**
 * Input video file selected by user
 *
 * Null when no file is selected. Set when user drops or selects a video file.
 */
export const [inputFile, setInputFile] = createSignal<File | null>(null);

/**
 * Video metadata extracted from input file
 *
 * Includes duration, dimensions, codec, framerate, and bitrate.
 * Populated after video analysis.
 */
export const [videoMetadata, setVideoMetadata] = createSignal<VideoMetadata | null>(null);

/**
 * Object URL for video preview
 *
 * Blob URL created from input file for preview playback.
 * Must be revoked when no longer needed to prevent memory leaks.
 */
export const [videoPreviewUrl, setVideoPreviewUrl] = createSignal<string | null>(null);

/**
 * Default conversion settings
 *
 * Used as fallback when no saved settings exist or localStorage fails.
 */
export const DEFAULT_CONVERSION_SETTINGS: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 1.0,
};

/**
 * LocalStorage key for persisting conversion settings
 */
const SETTINGS_STORAGE_KEY = 'conversion-settings';

/**
 * Load conversion settings from localStorage
 *
 * Validates loaded settings to ensure they have valid values.
 * Falls back to defaults if no saved settings or invalid data.
 *
 * @returns Valid conversion settings object
 */
const getInitialConversionSettings = (): ConversionSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ConversionSettings>;
      // Validate that the loaded settings have all required fields
      if (
        parsed.format &&
        ['gif', 'webp'].includes(parsed.format) &&
        parsed.quality &&
        ['low', 'medium', 'high'].includes(parsed.quality) &&
        typeof parsed.scale === 'number' &&
        [0.5, 0.75, 1.0].includes(parsed.scale)
      ) {
        // NOTE: gifEncoder is intentionally not persisted anymore.
        return {
          ...DEFAULT_CONVERSION_SETTINGS,
          format: parsed.format,
          quality: parsed.quality,
          scale: parsed.scale,
        };
      }
    }
  } catch (error) {
    // If localStorage is unavailable or data is corrupted, fall back to defaults
    logger.warn('general', 'Failed to load conversion settings from localStorage', { error });
  }
  return DEFAULT_CONVERSION_SETTINGS;
};

/**
 * Save conversion settings to localStorage
 *
 * Persists settings for use across sessions. Fails silently if localStorage
 * is unavailable (e.g., private browsing mode).
 *
 * @param settings - Conversion settings to save
 */
export const saveConversionSettings = (settings: ConversionSettings): void => {
  try {
    // Persist only stable user-facing settings.
    // Encoder selection is now fully automatic and depends on runtime environment.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        format: settings.format,
        quality: settings.quality,
        scale: settings.scale,
      })
    );
  } catch (error) {
    // Silently fail if localStorage is unavailable
    logger.warn('general', 'Failed to save conversion settings to localStorage', { error });
  }
};

/**
 * Current conversion settings
 *
 * User-selected format (gif/webp), quality (low/medium/high), and scale (0.5/0.75/1.0).
 * Initialized from localStorage or defaults. Automatically persisted on change.
 */
export const [conversionSettings, setConversionSettings] = createSignal<ConversionSettings>(
  getInitialConversionSettings()
);

/**
 * Performance warnings from performance checker
 *
 * Array of warnings about video characteristics that may affect conversion
 * (e.g., large resolution, long duration, high bitrate).
 */
const [, setPerformanceWarnings] = createSignal<PerformanceWarning[]>([]);

export { setPerformanceWarnings };

/**
 * Conversion progress percentage (0-100)
 *
 * Updated during conversion to show user progress.
 * Reset to 0 when starting new conversion.
 */
export const [conversionProgress, setConversionProgress] = createSignal<number>(0);

/**
 * Conversion status message
 *
 * Human-readable message describing current conversion step.
 * Examples: "Extracting frames...", "Encoding GIF...", "Finalizing..."
 */
export const [conversionStatusMessage, setConversionStatusMessage] = createSignal<string>('');

/**
 * Maximum number of conversion results to keep
 *
 * Limits memory usage by preventing unlimited result accumulation.
 * Oldest results are discarded when limit is reached.
 */
export const MAX_RESULTS = 10;

/**
 * Array of completed conversion results
 *
 * Contains converted video blobs with metadata (format, size, duration).
 * Limited to MAX_RESULTS entries. Newest results appear first.
 */
export const [conversionResults, setConversionResults] = createSignal<ConversionResult[]>([]);

/**
 * Error message from failed conversion
 *
 * User-friendly error message displayed when conversion fails.
 * Null when no error has occurred.
 */
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

/**
 * Detailed error context for debugging
 *
 * Contains error type, suggestions, and additional details for error display.
 * Populated by error classification utility.
 */
export const [errorContext, setErrorContext] = createSignal<ErrorContext | null>(null);

/**
 * Flag indicating auto-applied performance recommendation
 *
 * True when performance checker automatically adjusted settings (e.g., reduced scale).
 * Used to show notification to user about automatic changes.
 */
const [, setAutoAppliedRecommendation] = createSignal<boolean>(false);

export { setAutoAppliedRecommendation };
