// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectInitialLocale,
  detectUserLocale,
  formatBytes,
  formatDurationLocale,
  formatDurationSeconds,
  formatFileSizeLocale,
  updateDocumentLang,
} from '@utils/format-utils';

beforeEach(() => {
  const values: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
      removeItem: (key: string) => {
        delete values[key];
      },
    },
  });
  vi.stubGlobal('localStorage', window.localStorage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('locale-aware format utilities', () => {
  it('delegates duration seconds to locale formatting', () => {
    expect(formatDurationSeconds(5.5, 'en')).toBe('5.5s');
    expect(formatDurationSeconds(65, 'ko')).toBe('1분 5초');
  });

  it('formats locale-aware file sizes, including zero and large values', () => {
    expect(formatFileSizeLocale(0, 'en')).toBe('0 B');
    expect(formatFileSizeLocale(500, 'ko')).toContain('바이트');
    expect(formatFileSizeLocale(1536, 'en')).toBe('1.5 KB');
    expect(formatFileSizeLocale(1024 ** 4, 'en')).toBe('1,024 GB');
    expect(formatBytes(1536, 'ko')).toBe('1.5 KB');
  });

  it('formats localized durations across millisecond, second, and minute ranges', () => {
    expect(formatDurationLocale(500, 'en')).toBe('500ms');
    expect(formatDurationLocale(1500, 'en')).toBe('1.5s');
    expect(formatDurationLocale(90_000, 'ko')).toBe('1분 30초');
    expect(formatDurationLocale(1500, 'fr' as never)).toBe('1.5s');
  });

  it('selects an exact locale before a base-language match', () => {
    vi.stubGlobal('navigator', { languages: ['ko-KR', 'en'], language: 'en' });
    expect(detectUserLocale(['en', 'ko'])).toBe('ko');

    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    expect(detectUserLocale(['en', 'ko'])).toBe('en');
  });

  it('falls back when browser languages are empty or unsupported', () => {
    vi.stubGlobal('navigator', { languages: [], language: '' });
    expect(detectUserLocale(['en', 'ko'], 'ko')).toBe('ko');

    vi.stubGlobal('navigator', { languages: ['xx'], language: 'xx' });
    expect(detectUserLocale(['en', 'ko'], 'ko')).toBe('ko');
  });

  it('reads a valid stored locale before checking browser preferences', () => {
    localStorage.setItem('test-locale', 'ko');
    expect(detectInitialLocale('test-locale')).toBe('ko');
    localStorage.removeItem('test-locale');
  });

  it('ignores invalid or unavailable local storage', () => {
    localStorage.setItem('test-locale', 'xx');
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    expect(detectInitialLocale('test-locale')).toBe('en');

    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(detectInitialLocale('test-locale')).toBe('en');
    expect(getItem).toHaveBeenCalled();
  });

  it('updates document language and direction attributes', () => {
    updateDocumentLang('ko', 'rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ko');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });
});
