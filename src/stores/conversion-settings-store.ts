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
import { createSignal } from 'solid-js';

export const DEFAULT_CONVERSION_SETTINGS: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 1.0,
  trimStart: 0,
  trimEnd: 0,
  smartFrameSkip: 'off',
};

const SETTINGS_STORAGE_KEY = 'conversion-settings';

/**
 * Validate a value is a member of a readonly array (type-narrowing guard).
 */
function isInTuple<T extends string | number>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.includes(value as T);
}

const getInitialConversionSettings = (): ConversionSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ConversionSettings>;
      if (
        parsed.format &&
        isInTuple(parsed.format, CONVERSION_FORMATS) &&
        parsed.quality &&
        isInTuple(parsed.quality, CONVERSION_QUALITIES) &&
        typeof parsed.scale === 'number' &&
        isInTuple(parsed.scale, CONVERSION_SCALES) &&
        parsed.smartFrameSkip &&
        isInTuple(parsed.smartFrameSkip, SMART_FRAME_SKIP_MODES)
      ) {
        const trimStart =
          typeof parsed.trimStart === 'number' && parsed.trimStart >= 0 ? parsed.trimStart : 0;
        const trimEnd =
          typeof parsed.trimEnd === 'number' && parsed.trimEnd >= 0 ? parsed.trimEnd : 0;
        return {
          ...DEFAULT_CONVERSION_SETTINGS,
          format: parsed.format,
          quality: parsed.quality,
          scale: parsed.scale,
          trimStart,
          trimEnd,
          smartFrameSkip: parsed.smartFrameSkip,
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
