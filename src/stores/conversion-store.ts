import { createSignal } from 'solid-js';
import type {
  ConversionResult,
  ConversionSettings,
  ErrorContext,
  PerformanceWarning,
  VideoMetadata,
} from '../types/conversion-types';

export const [inputFile, setInputFile] = createSignal<File | null>(null);
export const [videoMetadata, setVideoMetadata] = createSignal<VideoMetadata | null>(null);
export const [videoThumbnail, setVideoThumbnail] = createSignal<string | null>(null);
export const DEFAULT_CONVERSION_SETTINGS: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 1.0,
};

const SETTINGS_STORAGE_KEY = 'conversion-settings';

/**
 * Load conversion settings from localStorage
 * Falls back to defaults if no saved settings or invalid data
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
        return parsed as ConversionSettings;
      }
    }
  } catch (error) {
    // If localStorage is unavailable or data is corrupted, fall back to defaults
    console.warn('Failed to load conversion settings from localStorage:', error);
  }
  return DEFAULT_CONVERSION_SETTINGS;
};

/**
 * Save conversion settings to localStorage
 */
export const saveConversionSettings = (settings: ConversionSettings): void => {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    // Silently fail if localStorage is unavailable (e.g., private browsing)
    console.warn('Failed to save conversion settings to localStorage:', error);
  }
};

export const [conversionSettings, setConversionSettings] = createSignal<ConversionSettings>(
  getInitialConversionSettings()
);
export const [performanceWarnings, setPerformanceWarnings] = createSignal<PerformanceWarning[]>([]);
export const [conversionProgress, setConversionProgress] = createSignal(0);
export const [conversionStatusMessage, setConversionStatusMessage] = createSignal<string>('');
export const MAX_RESULTS = 10;
export const [conversionResults, setConversionResults] = createSignal<ConversionResult[]>([]);
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [errorContext, setErrorContext] = createSignal<ErrorContext | null>(null);
export const [autoAppliedRecommendation, setAutoAppliedRecommendation] = createSignal(false);
