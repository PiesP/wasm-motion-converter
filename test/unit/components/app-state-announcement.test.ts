// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { AppState } from '@t/app-types';
import type { TFunction } from '@t/i18n-types';
import { setAppState } from '@stores/conversion-store';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    isRTL: () => false,
    locale: () => 'en',
    localeInfo: () => ({ code: 'en', name: 'English', englishName: 'English', dir: 'ltr' }),
    setLocale: vi.fn(),
    settingLocale: () => 'en',
    supportedLocales: [],
    t: (key: string) => `translated:${key}`,
  }),
}));

vi.mock('@hooks/use-network-state', () => ({
  useNetworkState: vi.fn(),
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

describe('App state announcement', () => {
  afterEach(() => {
    setAppState('idle');
    document.body.innerHTML = '';
  });

  it('renders translated state text in the polite live region', async () => {
    setAppState('analyzing');
    const { default: App } = await import('@/App');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(() => App({}), container);

    await vi.waitFor(() => {
      const liveRegion = document.getElementById('app-state');
      expect(liveRegion?.getAttribute('role')).toBe('status');
      expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
      expect(liveRegion?.textContent).toBe('translated:progress.analyzing');
      expect(liveRegion?.textContent).not.toBe('analyzing');
    });

    dispose();
  });

  it('maps every app state to an existing localized status label', async () => {
    const appModule = await import('@/App');
    const getAppStateAnnouncement = (
      appModule as unknown as {
        getAppStateAnnouncement?: (state: AppState, t: TFunction) => string;
      }
    ).getAppStateAnnouncement;
    const t = ((key: string) => `translated:${key}`) as TFunction;

    expect(getAppStateAnnouncement).toBeTypeOf('function');
    expect(
      (['idle', 'analyzing', 'converting', 'cancelling', 'done', 'error'] as const).map(
        (state) => getAppStateAnnouncement?.(state, t)
      )
    ).toEqual([
      'translated:settings.selectVideo',
      'translated:progress.analyzing',
      'translated:progress.converting',
      'translated:progress.cancelling',
      'translated:result.convertedAnimation',
      'translated:error.conversionFailed',
    ]);
  });
});
