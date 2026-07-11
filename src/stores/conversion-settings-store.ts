// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionSettings } from '@t/conversion-types';
import {
  CONVERSION_FORMATS,
  CONVERSION_QUALITIES,
  CONVERSION_SCALES,
  SMART_FRAME_SKIP_MODES,
} from '@t/conversion-types';
import { logger } from '@utils/logger';
import { isInTuple } from '@utils/type-utils';
import { createSignal } from 'solid-js';

export const DEFAULT_CONVERSION_SETTINGS: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 0.75, // 1.0 → 0.75: GIF files are inherently large;
  // defaulting to 75% scale reduces output ~44% (75%×75% = 56% pixels)
  // while still producing good quality for typical screen viewing
  trimStart: 0,
  trimEnd: 0,
  smartFrameSkip: 'off',
};

const SETTINGS_STORAGE_KEY = 'conversion-settings';

const getInitialConversionSettings = (): ConversionSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      // Type guard: ensure parsed is a non-null object before accessing properties
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return DEFAULT_CONVERSION_SETTINGS;
      }
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj.format === 'string' &&
        isInTuple(obj.format, CONVERSION_FORMATS) &&
        typeof obj.quality === 'string' &&
        isInTuple(obj.quality, CONVERSION_QUALITIES) &&
        typeof obj.scale === 'number' &&
        isInTuple(obj.scale, CONVERSION_SCALES) &&
        typeof obj.smartFrameSkip === 'string' &&
        isInTuple(obj.smartFrameSkip, SMART_FRAME_SKIP_MODES)
      ) {
        const trimStart =
          typeof obj.trimStart === 'number' && obj.trimStart >= 0 ? obj.trimStart : 0;
        const trimEnd = typeof obj.trimEnd === 'number' && obj.trimEnd >= 0 ? obj.trimEnd : 0;
        // Validate trim range: trimStart must be strictly before trimEnd.
        // If both are set but inverted or equal, reset both to defaults.
        const validTrim =
          trimStart === 0 && trimEnd === 0
            ? true
            : trimStart > 0 && trimEnd > 0 && trimStart < trimEnd;
        if (!validTrim) {
          return DEFAULT_CONVERSION_SETTINGS;
        }
        return {
          ...DEFAULT_CONVERSION_SETTINGS,
          format: obj.format,
          quality: obj.quality,
          scale: obj.scale,
          trimStart,
          trimEnd,
          smartFrameSkip: obj.smartFrameSkip,
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
        trimStart: settings.trimStart,
        trimEnd: settings.trimEnd,
        smartFrameSkip: settings.smartFrameSkip,
      })
    );
  } catch (error) {
    logger.warn('general', 'Failed to save conversion settings to localStorage', { error });
  }
};

export const [conversionSettings, setConversionSettings] = createSignal<ConversionSettings>(
  getInitialConversionSettings()
);
