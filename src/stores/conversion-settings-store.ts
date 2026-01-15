import type { ConversionSettings } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { createSignal } from 'solid-js';

export const DEFAULT_CONVERSION_SETTINGS: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 1.0,
};

const SETTINGS_STORAGE_KEY = 'conversion-settings';

const getInitialConversionSettings = (): ConversionSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ConversionSettings>;
      if (
        parsed.format &&
        ['gif', 'webp'].includes(parsed.format) &&
        parsed.quality &&
        ['low', 'medium', 'high'].includes(parsed.quality) &&
        typeof parsed.scale === 'number' &&
        [0.5, 0.75, 1.0].includes(parsed.scale)
      ) {
        return {
          ...DEFAULT_CONVERSION_SETTINGS,
          format: parsed.format,
          quality: parsed.quality,
          scale: parsed.scale,
        };
      }
    }
  } catch (error) {
    logger.warn('general', 'Failed to load conversion settings from localStorage', { error });
  }

  return DEFAULT_CONVERSION_SETTINGS;
};

export const saveConversionSettings = (settings: ConversionSettings): void => {
  try {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        format: settings.format,
        quality: settings.quality,
        scale: settings.scale,
      })
    );
  } catch (error) {
    logger.warn('general', 'Failed to save conversion settings to localStorage', { error });
  }
};

export const [conversionSettings, setConversionSettings] = createSignal<ConversionSettings>(
  getInitialConversionSettings()
);
