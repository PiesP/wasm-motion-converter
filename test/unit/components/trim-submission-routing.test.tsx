// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { conversionSettings, setConversionSettings } from '@stores/conversion-settings-store';
import {
  setAppState,
  setErrorMessage,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
} from '@stores/conversion-store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  convert: vi.fn().mockResolvedValue(undefined),
  retry: vi.fn(),
  memoryCritical: false,
}));

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
  networkState: () => ({ online: true }),
  useNetworkState: vi.fn(),
}));

vi.mock('@hooks/use-conversion-handlers', () => ({
  useConversionHandlers: () => ({
    handleCancelAnalysis: vi.fn(),
    handleCancelConversion: vi.fn(),
    handleConvert: mocks.convert,
    handleDismissError: vi.fn(),
    handleFileSelected: vi.fn(),
    handleReset: vi.fn(),
    handleRetry: mocks.retry,
  }),
}));

vi.mock('@utils/memory-monitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@utils/memory-monitor')>()),
  isMemoryCritical: () => mocks.memoryCritical,
}));

function editStart(value: string) {
  const input = document.querySelector<HTMLInputElement>('#trim-start-input')!;
  input.focus();
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  input.blur();
  return input;
}

async function renderReadyApp() {
  const { default: App } = await import('@/App');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dispose = render(() => App({}), container);
  await vi.waitFor(() => expect(container.querySelector('#trim-start-input')).not.toBeNull());
  return { container, dispose };
}

describe('trim submission routes', () => {
  beforeEach(() => {
    mocks.convert.mockReset().mockResolvedValue(undefined);
    mocks.retry.mockReset();
    mocks.memoryCritical = false;
    setConversionSettings({
      format: 'gif',
      quality: 'medium',
      scale: 0.75,
      trimStart: 2,
      trimEnd: 8,
      smartFrameSkip: 'off',
    });
    setInputFile(new File(['video'], 'trim.mp4', { type: 'video/mp4' }));
    setVideoPreviewUrl('blob:trim-test');
    setVideoMetadata({
      width: 160,
      height: 90,
      duration: 10,
      codec: 'avc1',
      framerate: 30,
      bitrate: 1_000_000,
    });
    setAppState('idle');
    setErrorMessage(null);
  });

  afterEach(() => {
    setAppState('idle');
    setErrorMessage(null);
    setInputFile(null);
    setVideoMetadata(null);
    setVideoPreviewUrl(null);
    document.body.innerHTML = '';
  });

  it('guards Retry, then permits it after the draft is corrected', async () => {
    setAppState('error');
    setErrorMessage('Controlled conversion error');
    const { container, dispose } = await renderReadyApp();
    const start = editStart('9.0');
    container.querySelector<HTMLButtonElement>('[data-testid="error-retry-button"]')!.click();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(start);
    expect(start.value).toBe('9.0');

    editStart('3.0');
    container.querySelector<HTMLButtonElement>('[data-testid="error-retry-button"]')!.click();
    expect(mocks.retry).toHaveBeenCalledOnce();
    dispose();
  });

  it('guards memory reduction before changing settings or starting conversion', async () => {
    mocks.memoryCritical = true;
    const { container, dispose } = await renderReadyApp();
    container.querySelector<HTMLButtonElement>('[data-testid="convert-button"]')!.click();
    expect(container.querySelector('[data-testid="memory-warning"]')).not.toBeNull();

    const start = editStart('9.0');
    container.querySelector<HTMLButtonElement>('[data-testid="memory-warning-reduce"]')!.click();
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(start);

    editStart('3.0');
    container.querySelector<HTMLButtonElement>('[data-testid="memory-warning-reduce"]')!.click();
    expect(mocks.convert).toHaveBeenCalledOnce();
    dispose();
  });

  it('allows untouched full-range conversion when metadata rounds up in the display', async () => {
    setConversionSettings({ ...conversionSettings(), trimStart: 0, trimEnd: 0 });
    setVideoMetadata({
      width: 160,
      height: 90,
      duration: 9.96,
      codec: 'avc1',
      framerate: 30,
      bitrate: 1_000_000,
    });
    const { container, dispose } = await renderReadyApp();
    expect(container.querySelector<HTMLInputElement>('#trim-end-input')?.value).toBe('0:10.0');
    container.querySelector<HTMLButtonElement>('[data-testid="convert-button"]')!.click();
    expect(mocks.convert).toHaveBeenCalledOnce();
    expect(conversionSettings().trimEnd).toBe(0);
    dispose();
  });
});
