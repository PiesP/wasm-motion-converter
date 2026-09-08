// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { AppState } from '@t/app-types';
import type { TFunction } from '@t/i18n-types';
import {
  setAppState,
  setConversionProgress,
  setConversionStatusMessage,
} from '@stores/conversion-store';
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
  networkState: () => ({ online: true, effectiveType: 'unknown', saveData: false }),
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
    setConversionProgress(0);
    setConversionStatusMessage('');
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
    expect(document.getElementById('app-state')).toBeNull();
  });

  it('owns one live region across unmount and remount', async () => {
    const { default: App } = await import('@/App');
    const firstContainer = document.createElement('div');
    document.body.appendChild(firstContainer);
    const disposeFirst = render(() => App({}), firstContainer);

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#app-state')).toHaveLength(1);
    });
    const firstLiveRegion = document.getElementById('app-state');

    disposeFirst();
    expect(firstLiveRegion?.isConnected).toBe(false);

    const secondContainer = document.createElement('div');
    document.body.appendChild(secondContainer);
    const disposeSecond = render(() => App({}), secondContainer);

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#app-state')).toHaveLength(1);
    });
    expect(document.getElementById('app-state')).not.toBe(firstLiveRegion);

    setAppState('done');
    await vi.waitFor(() => {
      expect(document.getElementById('app-state')?.textContent).toBe(
        'translated:result.convertedAnimation'
      );
    });
    expect(firstLiveRegion?.textContent).not.toBe('translated:result.convertedAnimation');

    disposeSecond();
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

  it('keeps the same progress card and value while cancellation settles', async () => {
    setConversionProgress(47);
    setConversionStatusMessage('Encoding frame 47');
    setAppState('converting');
    const { default: App } = await import('@/App');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(() => App({}), container);

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dropzone"] [data-progress="47"]')).not.toBeNull();
    });
    const progressCard = container.querySelector('[data-testid="dropzone"]');
    const progressBar = container.querySelector('[data-testid="dropzone"] [role="progressbar"]');
    const settingsCancelButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="stop-conversion-button"]'
    );
    const dropzoneCancelButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="dropzone-cancel-button"]'
    );
    expect(settingsCancelButton).not.toBeNull();
    expect(dropzoneCancelButton).not.toBeNull();

    setAppState('cancelling');

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dropzone"]')).toBe(progressCard);
      expect(container.querySelector('[data-testid="dropzone"] [role="progressbar"]')).toBe(
        progressBar
      );
      expect(container.querySelector('[data-testid="dropzone"] [data-progress="47"]')).not.toBeNull();
      expect(progressCard?.textContent).toContain('translated:progress.cancelling');
      expect(container.querySelector('[data-testid="conversion-progress"]')).toBeNull();
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
      expect(container.querySelector('[data-progress="0"]')).toBeNull();
      expect(container.querySelector('[data-testid="stop-conversion-button"]')).toBe(
        settingsCancelButton
      );
      expect(settingsCancelButton?.disabled).toBe(true);
      expect(settingsCancelButton?.getAttribute('aria-label')).toBe(
        'translated:progress.cancelling'
      );
      expect(settingsCancelButton?.textContent).toContain('translated:progress.cancelling');
      const currentDropzoneCancelButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="dropzone-cancel-button"]'
      );
      expect(currentDropzoneCancelButton?.disabled).toBe(true);
      expect(currentDropzoneCancelButton?.getAttribute('aria-label')).toBe(
        'translated:progress.cancelling'
      );
      expect(progressCard?.getAttribute('aria-busy')).toBe('true');
    });

    dispose();
  });
});
