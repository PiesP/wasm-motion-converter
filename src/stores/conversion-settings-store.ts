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

export type ConversionSettingsPersistenceStatus = 'writable' | 'future' | 'unreadable';

const [conversionSettingsPersistenceStatus, setConversionSettingsPersistenceStatus] =
  createSignal<ConversionSettingsPersistenceStatus>('writable');
export { conversionSettingsPersistenceStatus };

// A failed read gives no evidence that a newer record is absent. This tab must
// reload before it can safely become a writer again.
let recordReadUnknown = false;

const storedSchemaVersion = (record: Record<string, unknown>): number | null => {
  const value = record.__schemaVersion;
  if (value === undefined) return 0; // Unversioned legacy record.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
    // Either endpoint may use 0 as a sentinel: trimStart=0 means "from the
    // beginning" and trimEnd=0 means "through the full duration". Only a
    // closed range with both endpoints set can be inverted or empty.
    const validTrim = trimStart === 0 || trimEnd === 0 || trimStart < trimEnd;
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
  let stored: string | null;
  try {
    stored = localStorage.getItem(CONVERSION_SETTINGS_STORAGE_KEY);
  } catch (error) {
    recordReadUnknown = true;
    setConversionSettingsPersistenceStatus('unreadable');
    logger.warn('general', 'Failed to read conversion settings from localStorage', { error });
    return DEFAULT_CONVERSION_SETTINGS;
  }
  if (!stored) return DEFAULT_CONVERSION_SETTINGS;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed)) {
      return DEFAULT_CONVERSION_SETTINGS;
    }

    const obj = parsed;
    const version = storedSchemaVersion(obj);
    if (version !== null && version > CONVERSION_SETTINGS_SCHEMA_VERSION) {
      setConversionSettingsPersistenceStatus('future');
    }
    // An invalid version is not a supported migration source. Read known
    // settings for this session, then normalize only through the ordinary save.
    const storedVersion = version === null ? CONVERSION_SETTINGS_SCHEMA_VERSION : version;

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
    logger.warn('general', 'Failed to parse conversion settings from localStorage', { error });
  }

  return DEFAULT_CONVERSION_SETTINGS;
};

// ── Save ─────────────────────────────────────────────────────────────────

export const saveConversionSettings = (settings: ConversionSettings): void => {
  if (recordReadUnknown || conversionSettingsPersistenceStatus() === 'future') return;
  try {
    // An older open tab can observe a newer record after its initial load.
    // Check every writer, including queued migration and cleanup flushes.
    const current = localStorage.getItem(CONVERSION_SETTINGS_STORAGE_KEY);
    if (current) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(current);
      } catch {
        // An invalid JSON record follows the existing normalization behavior.
      }
      if (isRecord(parsed)) {
        const version = storedSchemaVersion(parsed);
        if (version !== null && version > CONVERSION_SETTINGS_SCHEMA_VERSION) {
          setConversionSettingsPersistenceStatus('future');
          return;
        }
      }
    }
  } catch (error) {
    recordReadUnknown = true;
    setConversionSettingsPersistenceStatus('unreadable');
    logger.warn('general', 'Failed to read conversion settings before save', { error });
    return;
  }
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
    setConversionSettingsPersistenceStatus('writable');
  } catch (error) {
    setConversionSettingsPersistenceStatus('unreadable');
    logger.warn('general', 'Failed to save conversion settings to localStorage', { error });
  }
};

export const [conversionSettings, setConversionSettings] = createSignal<ConversionSettings>(
  getInitialConversionSettings()
);
