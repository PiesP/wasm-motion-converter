// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

const helperModule = vi.hoisted(() => {
  let resolveImport: (() => void) | undefined;
  const pendingImport = new Promise<void>((resolve) => {
    resolveImport = resolve;
  });

  return {
    attach: vi.fn(),
    pendingImport,
    resolveImport: () => resolveImport?.(),
  };
});

vi.mock('@/test-helpers', async () => {
  await helperModule.pendingImport;
  return { attachTestHelpers: helperModule.attach };
});

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

describe('App test helper lifecycle', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('does not attach helpers after the owning App is disposed', async () => {
    const { default: App } = await import('@/App');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(() => App({}), container);

    dispose();
    helperModule.resolveImport();
    await helperModule.pendingImport;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(helperModule.attach).not.toHaveBeenCalled();
  });
});
