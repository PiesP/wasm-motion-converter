// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vite-plus/test';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    isRTL: () => false,
    locale: () => 'en',
    localeInfo: () => ({ code: 'en', name: 'English', englishName: 'English', dir: 'ltr' }),
    setLocale: vi.fn(),
    settingLocale: () => 'en',
    supportedLocales: [],
    t: (key: string) => key,
  }),
}));
vi.mock('@hooks/use-network-state', () => ({
  useNetworkState: vi.fn(),
  networkState: () => ({ online: true }),
}));
vi.mock('@hooks/use-conversion-handlers', () => ({
  useConversionHandlers: () => ({
    handleCancelAnalysis: vi.fn(),
    handleCancelConversion: vi.fn(),
    handleConvert: vi.fn(),
    handleDismissError: vi.fn(),
    handleFileSelected: vi.fn(),
    handleReset: vi.fn(),
    handleRetry: vi.fn(),
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.replaceChildren();
});

it('keeps a future settings record byte-for-byte through initial debounce, edits, and unmount flush', async () => {
  vi.useFakeTimers();
  const futureRecord = JSON.stringify({
    __schemaVersion: 2,
    format: 'gif',
    quality: 'high',
    scale: 1,
    trimStart: 0,
    trimEnd: 0,
    smartFrameSkip: 'off',
    futureEncoderOption: { mode: 'new', enabled: true },
  });
  localStorage.setItem('conversion-settings', futureRecord);
  const { default: App } = await import('@/App');
  const { conversionSettings, setConversionSettings } =
    await import('@stores/conversion-settings-store');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dispose = render(() => App({}), container);
  expect(container.querySelector('[data-testid="settings-persistence-notice"]')?.textContent).toBe(
    'settings.persistenceFuture'
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(localStorage.getItem('conversion-settings')).toBe(futureRecord);
  setConversionSettings({ ...conversionSettings(), quality: 'low' });
  await vi.advanceTimersByTimeAsync(500);
  expect(localStorage.getItem('conversion-settings')).toBe(futureRecord);
  setConversionSettings({ ...conversionSettings(), scale: 0.5 });
  dispose();
  expect(localStorage.getItem('conversion-settings')).toBe(futureRecord);
  expect(vi.getTimerCount()).toBe(0);
});
