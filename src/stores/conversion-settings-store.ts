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
import {
  CONVERSION_SETTINGS_SCHEMA_VERSION,
  CONVERSION_SETTINGS_STORAGE_KEY,
} from './conversion-settings-constants';

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

// ── Migration chain ─────────────────────────────────────────────────────

/**
 * Ordered list of migration functions. Each function receives settings from
 * the previous version and must return settings for the next version.
 *
 * To add a new migration (e.g., v1 → v2):
 * 1. Add a new function: `(s) => ({ ...s, newField: defaultValue })`
 * 2. Bump CONVERSION_SETTINGS_SCHEMA_VERSION in conversion-settings-constants.ts
 */
const MIGRATIONS: ReadonlyArray<(settings: Record<string, unknown>) => Record<string, unknown>> = [
  // v0 → v1: Initial schema versioning (no field changes)
  (_settings) => _settings,
];

// ── Load ─────────────────────────────────────────────────────────────────

/**
 * Pure type guard: returns true for finite, non-negative numbers.
 * Rejects NaN, Infinity, -Infinity, negative numbers, and non-numbers.
 */
function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseStoredSettings(raw: Record<string, unknown>): ConversionSettings | null {
  if (
    typeof raw.format === 'string' &&
    isInTuple(raw.format, CONVERSION_FORMATS) &&
    typeof raw.quality === 'string' &&
    isInTuple(raw.quality, CONVERSION_QUALITIES) &&
    typeof raw.scale === 'number' &&
    Number.isFinite(raw.scale) &&
    isInTuple(raw.scale, CONVERSION_SCALES) &&
    typeof raw.smartFrameSkip === 'string' &&
    isInTuple(raw.smartFrameSkip, SMART_FRAME_SKIP_MODES)
  ) {
    const trimStart = isFiniteNonNegativeNumber(raw.trimStart) ? raw.trimStart : 0;
    const trimEnd = isFiniteNonNegativeNumber(raw.trimEnd) ? raw.trimEnd : 0;
    const validTrim =
      trimStart === 0 && trimEnd === 0 ? true : trimStart > 0 && trimEnd > 0 && trimStart < trimEnd;
    return {
      ...DEFAULT_CONVERSION_SETTINGS,
      format: raw.format,
      quality: raw.quality,
      scale: raw.scale,
      trimStart: validTrim ? trimStart : 0,
      trimEnd: validTrim ? trimEnd : 0,
      smartFrameSkip: raw.smartFrameSkip,
    };
  }
  return null;
}

const getInitialConversionSettings = (): ConversionSettings => {
  try {
    const stored = localStorage.getItem(CONVERSION_SETTINGS_STORAGE_KEY);
    if (!stored) return DEFAULT_CONVERSION_SETTINGS;

    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_CONVERSION_SETTINGS;
    }

    const obj = parsed as Record<string, unknown>;
    const rawVersion = typeof obj.__schemaVersion === 'number' ? obj.__schemaVersion : 0;
    // Clamp version to prevent infinite loops from NaN/-Infinity/negative values.
    // NaN < VERSION is false and NaN is not finite, so it normalizes to 0.
    // -Infinity++ stays -Infinity forever — clamp prevents the infinite loop.
    const storedVersion =
      Number.isFinite(rawVersion) && rawVersion >= 0
        ? Math.min(rawVersion, CONVERSION_SETTINGS_SCHEMA_VERSION)
        : 0;

    // Run migration chain if stored version is behind
    let migrated: Record<string, unknown> = { ...obj };
    for (let v = storedVersion; v < CONVERSION_SETTINGS_SCHEMA_VERSION; v++) {
      const migrator = MIGRATIONS[v];
      if (migrator) {
        migrated = migrator(migrated);
      }
    }

    const settings = parseStoredSettings(migrated);
    if (!settings) return DEFAULT_CONVERSION_SETTINGS;

    // If we ran migrations, persist the updated settings asynchronously
    if (storedVersion < CONVERSION_SETTINGS_SCHEMA_VERSION) {
      queueMicrotask(() => {
        saveConversionSettings(settings);
      });
    }

    return settings;
  } catch (error) {
    logger.warn('general', 'Failed to load conversion settings from localStorage', { error });
  }

  return DEFAULT_CONVERSION_SETTINGS;
};

// ── Save ─────────────────────────────────────────────────────────────────

export const saveConversionSettings = (settings: ConversionSettings): void => {
  try {
    localStorage.setItem(
      CONVERSION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        __schemaVersion: CONVERSION_SETTINGS_SCHEMA_VERSION,
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
