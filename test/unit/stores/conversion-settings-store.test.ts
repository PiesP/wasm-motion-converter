// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
//
// Unit tests for conversion-settings-store:
//   F33 — localStorage settings save (saveConversionSettings)
//   F34 — localStorage settings restore (getInitialConversionSettings)
//
// Tests cover: default settings, serialization/deserialization, type validation,
// trim range validation, corrupted data recovery, and error handling.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConversionSettings } from '@t/conversion-types';

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
    vi.resetModules();

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
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  // ── Save / restore round-trip ──────────────────────────────────────

  it('saveConversionSettings persists to localStorage', async () => {
    const { saveConversionSettings } = await import('@stores/conversion-settings-store');
    const settings = makeTestSettings();
    saveConversionSettings(settings);

    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify({ __schemaVersion: 1, ...settings }),
    );
  });

  it('can restore saved settings on next call', async () => {
    // Save first
    const mod1 = await import('@stores/conversion-settings-store');
    const testSettings = makeTestSettings();
    mod1.saveConversionSettings(testSettings);

    // Reset modules to simulate fresh page load
    vi.resetModules();

    // Re-import — should read from localStorage
    const mod2 = await import('@stores/conversion-settings-store');
    expect(mod2.conversionSettings()).toEqual(testSettings);
  });

  it('strips out DTRIM_END_FULL_DURATION sentinel as 0 on restore (trimEnd=0 → 0)', async () => {
    const mod1 = await import('@stores/conversion-settings-store');
    // Save with trimEnd=0 (full duration sentinel)
    mod1.saveConversionSettings(makeTestSettings({ trimEnd: 0 }));

    vi.resetModules();
    const mod2 = await import('@stores/conversion-settings-store');
    const restored = mod2.conversionSettings();
    expect(restored.trimEnd).toBe(0);
  });

  // ── Type validation ────────────────────────────────────────────────

  it('returns defaults when format is invalid', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), format: 'bmp' }));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when quality is invalid', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), quality: 'ultra' }));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when scale is invalid', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), scale: 2.0 }));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when smartFrameSkip is invalid', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), smartFrameSkip: 'turbo' }));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when format is not a string', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), format: 42 }));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when scale is not a number', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...makeTestSettings(), scale: '100%' }));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  // ── Trim range validation ─────────────────────────────────────────

  it('resets trim but preserves other settings when trimStart >= trimEnd (inverted range)', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: 30, trimEnd: 5 })),
    );
    const { conversionSettings } = await import('@stores/conversion-settings-store');
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
      JSON.stringify(makeTestSettings({ trimStart: 10, trimEnd: 10 })),
    );
    const { conversionSettings } = await import('@stores/conversion-settings-store');
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
      JSON.stringify(makeTestSettings({ trimStart: 5, trimEnd: 30 })),
    );
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings().trimStart).toBe(5);
    expect(conversionSettings().trimEnd).toBe(30);
  });

  it('clamps negative trimStart to 0 and preserves other settings', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: -5, trimEnd: 10 })),
    );
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    const restored = conversionSettings();
    // Negative trimStart clamped to 0, but trimEnd=10 > 0 with trimStart=0
    // means one-sided trim is invalid → trim is reset, other settings preserved
    expect(restored.trimStart).toBe(0);
    expect(restored.trimEnd).toBe(0);
    expect(restored.format).toBe('webp');
    expect(restored.quality).toBe('high');
    expect(restored.scale).toBe(1.0);
    expect(restored.smartFrameSkip).toBe('off');
  });

  it('clamps negative trimEnd to 0 and preserves other settings', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeTestSettings({ trimStart: 5, trimEnd: -1 })),
    );
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    const restored = conversionSettings();
    // trimEnd clamped to 0, trimStart=5 — one-sided trim is invalid
    // → trim is reset, other settings preserved
    expect(restored.trimStart).toBe(0);
    expect(restored.trimEnd).toBe(0);
    expect(restored.format).toBe('webp');
    expect(restored.quality).toBe('high');
    expect(restored.scale).toBe(1.0);
    expect(restored.smartFrameSkip).toBe('off');
  });

  // ── Corrupted / edge case data ────────────────────────────────────

  it('returns defaults when stored data is invalid JSON', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-json');
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is a primitive', async () => {
    window.localStorage.setItem(STORAGE_KEY, '"string"');
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is an array', async () => {
    window.localStorage.setItem(STORAGE_KEY, '["gif", "high"]');
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is null', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'null');
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored data is empty string', async () => {
    window.localStorage.setItem(STORAGE_KEY, '');
    // Empty string is falsy → not parsed → falls through to defaults
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores extra unknown properties', async () => {
    const stored = { ...makeTestSettings(), unknownField: 'test', another: 123 };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings().format).toBe('webp');
    expect(conversionSettings().quality).toBe('high');
    expect(conversionSettings().scale).toBe(1.0);
  });

  it('handles missing trimStart/trimEnd keys (defaults both to 0)', async () => {
    const partial = { format: 'gif', quality: 'medium', scale: 0.75, smartFrameSkip: 'off' };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(partial));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
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
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('handles localStorage setItem throwing (quota exceeded)', async () => {
    window.localStorage.setItem = vi.fn(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const { saveConversionSettings } = await import('@stores/conversion-settings-store');
    // Should not throw — catch block logs warning
    expect(() => saveConversionSettings(makeTestSettings())).not.toThrow();
  });

  // ── Signal integration ────────────────────────────────────────────

  it('createSignal is initialized with getInitialConversionSettings() return value', async () => {
    // Pre-set a valid value
    const stored = makeTestSettings({ format: 'gif', scale: 0.5 });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { conversionSettings } = await import('@stores/conversion-settings-store');
    expect(conversionSettings().format).toBe('gif');
    expect(conversionSettings().scale).toBe(0.5);
  });

  it('saveConversionSettings serializes only known keys', async () => {
    const { saveConversionSettings } = await import('@stores/conversion-settings-store');
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
      const stored = makeTestSettings({ scale: NaN });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().scale).toBe(0.75); // DEFAULT
    });

    it('rejects Infinity scale and falls back to defaults', async () => {
      const stored = makeTestSettings({ scale: Infinity });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().scale).toBe(0.75);
    });

    it('rejects -Infinity scale and falls back to defaults', async () => {
      const stored = makeTestSettings({ scale: -Infinity });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().scale).toBe(0.75);
    });

    it('rejects NaN trimStart and resets to 0', async () => {
      const stored = makeTestSettings({ trimStart: NaN, trimEnd: 30 });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().trimStart).toBe(0);
    });

    it('rejects Infinity trimEnd and resets to 0', async () => {
      const stored = makeTestSettings({ trimStart: 5, trimEnd: Infinity });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().trimEnd).toBe(0);
    });

    it('rejects negative trimStart and resets to 0', async () => {
      const stored = makeTestSettings({ trimStart: -1, trimEnd: 30 });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().trimStart).toBe(0);
    });

    it('clamps NaN __schemaVersion to 0 and migrates from scratch', async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        __schemaVersion: NaN,
        format: 'gif',
        quality: 'low',
        scale: 0.5,
        trimStart: 0,
        trimEnd: 0,
        smartFrameSkip: 'off',
      }));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().quality).toBe('low');
    });

    it('clamps -Infinity __schemaVersion and does not hang', async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        __schemaVersion: -Infinity,
        format: 'webp',
        quality: 'high',
        scale: 1.0,
        trimStart: 0,
        trimEnd: 0,
        smartFrameSkip: 'off',
      }));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().format).toBe('webp');
    });

    it('clamps future __schemaVersion to current to prevent migration gaps', async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        __schemaVersion: 999,
        format: 'gif',
        quality: 'low',
        scale: 0.5,
        trimStart: 0,
        trimEnd: 0,
        smartFrameSkip: 'off',
      }));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().format).toBe('gif');
    });

    it('rejects numeric string for enum field (format)', async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        __schemaVersion: 1,
        format: '123',
        quality: 'low',
        scale: 0.5,
        trimStart: 0,
        trimEnd: 0,
        smartFrameSkip: 'off',
      }));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().format).toBe('gif'); // DEFAULT
    });

    it('rejects null for enum field and falls back to defaults', async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        __schemaVersion: 1,
        format: null,
        quality: 'low',
        scale: 0.5,
        trimStart: 0,
        trimEnd: 0,
        smartFrameSkip: 'off',
      }));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().format).toBe('gif'); // DEFAULT
    });

    it('rejects boolean for enum field (format)', async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        __schemaVersion: 1,
        format: true,
        quality: 'low',
        scale: 0.5,
        trimStart: 0,
        trimEnd: 0,
        smartFrameSkip: 'off',
      }));
      const { conversionSettings } = await import('@stores/conversion-settings-store');
      expect(conversionSettings().format).toBe('gif'); // DEFAULT
    });
  });
});
