// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger
vi.mock('@utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const THEME_STORAGE_KEY = 'theme';

// Mock localStorage since jsdom doesn't provide it in worker threads
const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { mockStorage[key] = value; }),
  removeItem: vi.fn((key: string) => { delete mockStorage[key]; }),
  clear: vi.fn(() => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }),
};

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
  configurable: true,
});

describe('theme-store', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('toggleTheme switches from light to dark', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { theme, toggleTheme } = await import('@stores/theme-store');

    expect(theme()).toBe('light');

    toggleTheme();
    expect(theme()).toBe('dark');
  });

  it('toggleTheme switches from dark to light', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { theme, toggleTheme } = await import('@stores/theme-store');

    expect(theme()).toBe('dark');

    toggleTheme();
    expect(theme()).toBe('light');
  });

  it('persists theme to localStorage on toggle', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { toggleTheme } = await import('@stores/theme-store');

    toggleTheme();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    toggleTheme();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('defaults to light when no stored preference', async () => {
    // matchMedia already mocked in setup.ts to return false
    const { theme } = await import('@stores/theme-store');
    expect(theme()).toBe('light');
  });

  it('defaults to dark when system prefers dark', async () => {
    // matchMedia is mocked in setup.ts to return { matches: false }
    // We need to override it for this test
    const originalMatchMedia = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList);

    vi.resetModules();
    const { theme } = await import('@stores/theme-store');
    expect(theme()).toBe('dark');

    window.matchMedia = originalMatchMedia;
  });
});
