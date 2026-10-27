// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
//
// Unit tests for conversion-settings-store:
//   F33 — localStorage settings save (saveConversionSettings)
//   F34 — localStorage settings restore (getInitialConversionSettings)
//
// Tests cover: default settings, serialization/deserialization, type validation,
// trim range validation, corrupted data recovery, and error handling.

import type { ConversionSettings } from '@t/conversion-types';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// ── Mock logger to silence warnings ────────────────────────────────────
vi.mock('@utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const STORAGE_KEY = 'conversion-settings';
let moduleVersion = 0;

function importFreshSettingsStore(): Promise<typeof import('@stores/conversion-settings-store')> {
  const url = `/src/stores/conversion-settings-store.ts?browser-test=${++moduleVersion}`;
  return import(/* @vite-ignore */ url) as Promise<
    typeof import('@stores/conversion-settings-store')
  >;
}

const DEFAULT_SETTINGS: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 0.75,
  trimStart: 0,
  trimEnd: 0,
  smartFrameSkip: 'off',
};

// Helper: create a known-good settings object (different from defaults)
function makeTestSettings(overrides: Partial<ConversionSettings> = {}): ConversionSettings {
  return {
    format: 'webp',
    quality: 'high',
    scale: 1.0,
    trimStart: 5,
    trimEnd: 30,
    smartFrameSkip: 'off',
    ...overrides,
  };
}

describe('conversion-settings-store', () => {
  let localStorageStore: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock localStorage
    localStorageStore = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageStore[key] = value;
        }),
        removeItem: vi.fn((key: string) => {
          delete localStorageStore[key];
        }),
        clear: vi.fn(() => {
          localStorageStore = {};
        }),
        get length() {
          return Object.keys(localStorageStore).length;
        },
        key: vi.fn((index: number) => Object.keys(localStorageStore)[index] ?? null),
      },
      writable: true,
      configurable: true,
    });
  });

  // ── Default settings (empty localStorage) ──────────────────────────

  it('returns defaults when localStorage is empty', async () => {
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  // ── Save / restore round-trip ──────────────────────────────────────

  it('saveConversionSettings persists to localStorage', async () => {
    const { saveConversionSettings } = await importFreshSettingsStore();
    const settings = makeTestSettings();
    saveConversionSettings(settings);

    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify({ __schemaVersion: 1, ...settings })
    );
  });

  it('can restore saved settings on next call', async () => {
    // Save first
    const mod1 = await importFreshSettingsStore();
    const testSettings = makeTestSettings();
    mod1.saveConversionSettings(testSettings);

    // A unique module URL re-evaluates storage initialization in Browser Mode.

    // Re-import reads the value saved by the first module instance.
    const mod2 = await importFreshSettingsStore();
    expect(mod2.conversionSettings()).toEqual(testSettings);
  });

  it('preserves a last-segment trim that uses trimEnd=0 as the full-duration sentinel', async () => {
    const mod1 = await importFreshSettingsStore();
    mod1.saveConversionSettings(makeTestSettings({ trimStart: 5, trimEnd: 0 }));

    const mod2 = await importFreshSettingsStore();
    const restored = mod2.conversionSettings();
    expect(restored.trimStart).toBe(5);
    expect(restored.trimEnd).toBe(0);
  });

  // ── Type validation ────────────────────────────────────────────────

  it('returns defaults when format is invalid', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...makeTestSettings(), format: 'bmp' })
    );
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when quality is invalid', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...makeTestSettings(), quality: 'ultra' })
    );
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when scale is invalid', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), scale: 2.0 }));
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when smartFrameSkip is invalid', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...makeTestSettings(), smartFrameSkip: 'turbo' })
    );
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when format is not a string', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), format: 42 }));
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when scale is not a number', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...makeTestSettings(), scale: '100%' })
    );
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  // ── Trim range validation ─────────────────────────────────────────

  it('resets trim but preserves other settings when trimStart >= trimEnd (inverted range)', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: 30, trimEnd: 5 }))
    );
    const { conversionSettings } = await importFreshSettingsStore();
    const restored = conversionSettings();
    // Trim is invalid — only trim is reset, other settings are preserved
    expect(restored.trimStart).toBe(0);
    expect(restored.trimEnd).toBe(0);
    expect(restored.format).toBe('webp');
    expect(restored.quality).toBe('high');
    expect(restored.scale).toBe(1.0);
    expect(restored.smartFrameSkip).toBe('off');
  });

  it('resets trim but preserves other settings when trimStart === trimEnd (zero range)', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: 10, trimEnd: 10 }))
    );
    const { conversionSettings } = await importFreshSettingsStore();
    const restored = conversionSettings();
    // Trim is invalid — only trim is reset, other settings are preserved
    expect(restored.trimStart).toBe(0);
    expect(restored.trimEnd).toBe(0);
    expect(restored.format).toBe('webp');
    expect(restored.quality).toBe('high');
    expect(restored.scale).toBe(1.0);
    expect(restored.smartFrameSkip).toBe('off');
  });

  it('preserves valid trim range (start < end, both > 0)', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: 5, trimEnd: 30 }))
    );
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings().trimStart).toBe(5);
    expect(conversionSettings().trimEnd).toBe(30);
  });

  it('preserves a first-segment trim whose start is zero', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: 0, trimEnd: 5 }))
    );
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings().trimStart).toBe(0);
    expect(conversionSettings().trimEnd).toBe(5);
  });

  it('clamps negative trimStart to 0 and preserves other settings', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: -5, trimEnd: 10 }))
    );
    const { conversionSettings } = await importFreshSettingsStore();
    const restored = conversionSettings();
    // Invalid trimStart falls back to the beginning while preserving the valid end.
    expect(restored.trimStart).toBe(0);
    expect(restored.trimEnd).toBe(10);
    expect(restored.format).toBe('webp');
    expect(restored.quality).toBe('high');
    expect(restored.scale).toBe(1.0);
    expect(restored.smartFrameSkip).toBe('off');
  });

  it('clamps negative trimEnd to 0 and preserves other settings', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: 5, trimEnd: -1 }))
    );
    const { conversionSettings } = await importFreshSettingsStore();
    const restored = conversionSettings();
    // Invalid trimEnd falls back to the full-duration sentinel while preserving the start.
    expect(restored.trimStart).toBe(5);
    expect(restored.trimEnd).toBe(0);
    expect(restored.format).toBe('webp');
    expect(restored.quality).toBe('high');
    expect(restored.scale).toBe(1.0);
    expect(restored.smartFrameSkip).toBe('off');
  });

  // ── Corrupted / edge case data ────────────────────────────────────

  it('returns defaults when stored data is invalid JSON', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-json');
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is a primitive', async () => {
    window.localStorage.setItem(STORAGE_KEY, '"string"');
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is an array', async () => {
    window.localStorage.setItem(STORAGE_KEY, '["gif", "high"]');
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is null', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'null');
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is empty string', async () => {
    window.localStorage.setItem(STORAGE_KEY, '');
    // Empty string is falsy → not parsed → falls through to defaults
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores extra unknown properties', async () => {
    const stored = { ...makeTestSettings(), unknownField: 'test', another: 123 };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings().format).toBe('webp');
    expect(conversionSettings().quality).toBe('high');
    expect(conversionSettings().scale).toBe(1.0);
  });

  it('handles missing trimStart/trimEnd keys (defaults both to 0)', async () => {
    const partial = { format: 'gif', quality: 'medium', scale: 0.75, smartFrameSkip: 'off' };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(partial));
    const { conversionSettings } = await importFreshSettingsStore();
    const restored = conversionSettings();
    // trimStart/trimEnd are undefined → default to 0; both 0 → validTrim=true
    expect(restored.trimStart).toBe(0);
    expect(restored.trimEnd).toBe(0);
    // Other fields from partial are preserved
    expect(restored.format).toBe('gif');
    expect(restored.quality).toBe('medium');
    expect(restored.scale).toBe(0.75);
    expect(restored.smartFrameSkip).toBe('off');
  });

  // ── Error handling ────────────────────────────────────────────────

  it('handles localStorage getItem throwing an exception', async () => {
    window.localStorage.getItem = vi.fn(() => {
      throw new Error('storage error');
    });
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('handles localStorage setItem throwing (quota exceeded)', async () => {
    window.localStorage.setItem = vi.fn(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const { saveConversionSettings } = await importFreshSettingsStore();
    // Should not throw — catch block logs warning
    expect(() => saveConversionSettings(makeTestSettings())).not.toThrow();
  });

  // ── Signal integration ────────────────────────────────────────────

  it('createSignal is initialized with getInitialConversionSettings() return value', async () => {
    // Pre-set a valid value
    const stored = makeTestSettings({ format: 'gif', scale: 0.5 });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { conversionSettings } = await importFreshSettingsStore();
    expect(conversionSettings().format).toBe('gif');
    expect(conversionSettings().scale).toBe(0.5);
  });

  it('saveConversionSettings serializes only known keys', async () => {
    const { saveConversionSettings } = await importFreshSettingsStore();
    const settings = makeTestSettings();
    saveConversionSettings(settings);

    const savedJson = localStorageStore[STORAGE_KEY]!;
    const parsed = JSON.parse(savedJson);
    expect(parsed).toEqual({
      __schemaVersion: 1,
      format: 'webp',
      quality: 'high',
      scale: 1.0,
      trimStart: 5,
      trimEnd: 30,
      smartFrameSkip: 'off',
    });
    // Ensure no extra keys leaked
    expect(Object.keys(parsed).sort()).toEqual([
      '__schemaVersion',
      'format',
      'quality',
      'scale',
      'smartFrameSkip',
      'trimEnd',
      'trimStart',
    ]);
  });

  // ── Malformed input (runtime validation hardening) ────────────────
  describe('malformed input rejection', () => {
    it('rejects NaN scale and falls back to defaults', async () => {
      const stored = { ...makeTestSettings(), scale: NaN };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().scale).toBe(0.75); // DEFAULT
    });

    it('rejects Infinity scale and falls back to defaults', async () => {
      const stored = { ...makeTestSettings(), scale: Infinity };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().scale).toBe(0.75);
    });

    it('rejects -Infinity scale and falls back to defaults', async () => {
      const stored = { ...makeTestSettings(), scale: -Infinity };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().scale).toBe(0.75);
    });

    it('rejects NaN trimStart and resets to 0', async () => {
      const stored = makeTestSettings({ trimStart: NaN, trimEnd: 30 });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().trimStart).toBe(0);
    });

    it('rejects Infinity trimEnd and resets to 0', async () => {
      const stored = makeTestSettings({ trimStart: 5, trimEnd: Infinity });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().trimEnd).toBe(0);
    });

    it('rejects negative trimStart and resets to 0', async () => {
      const stored = makeTestSettings({ trimStart: -1, trimEnd: 30 });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().trimStart).toBe(0);
    });

    it('clamps NaN __schemaVersion to 0 and migrates from scratch', async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          __schemaVersion: NaN,
          format: 'gif',
          quality: 'low',
          scale: 0.5,
          trimStart: 0,
          trimEnd: 0,
          smartFrameSkip: 'off',
        })
      );
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().quality).toBe('low');
    });

    it('clamps -Infinity __schemaVersion and does not hang', async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          __schemaVersion: -Infinity,
          format: 'webp',
          quality: 'high',
          scale: 1.0,
          trimStart: 0,
          trimEnd: 0,
          smartFrameSkip: 'off',
        })
      );
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().format).toBe('webp');
    });

    it('clamps future __schemaVersion to current to prevent migration gaps', async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          __schemaVersion: 999,
          format: 'gif',
          quality: 'low',
          scale: 0.5,
          trimStart: 0,
          trimEnd: 0,
          smartFrameSkip: 'off',
        })
      );
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().format).toBe('gif');
    });

    it('rejects numeric string for enum field (format)', async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          __schemaVersion: 1,
          format: '123',
          quality: 'low',
          scale: 0.5,
          trimStart: 0,
          trimEnd: 0,
          smartFrameSkip: 'off',
        })
      );
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().format).toBe('gif'); // DEFAULT
    });

    it('rejects null for enum field and falls back to defaults', async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          __schemaVersion: 1,
          format: null,
          quality: 'low',
          scale: 0.5,
          trimStart: 0,
          trimEnd: 0,
          smartFrameSkip: 'off',
        })
      );
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().format).toBe('gif'); // DEFAULT
    });

    it('rejects boolean for enum field (format)', async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          __schemaVersion: 1,
          format: true,
          quality: 'low',
          scale: 0.5,
          trimStart: 0,
          trimEnd: 0,
          smartFrameSkip: 'off',
        })
      );
      const { conversionSettings } = await importFreshSettingsStore();
      expect(conversionSettings().format).toBe('gif'); // DEFAULT
    });
  });
});
