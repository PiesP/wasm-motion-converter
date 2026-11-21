// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

import ErrorDisplay from '@components/ErrorDisplay';
import StatusAlerts from '@components/StatusAlerts';
import type { TFunction } from '@t/i18n-types';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ErrorDisplay focus', () => {
  it('focuses select-different when the codec error cannot be retried', async () => {
    const container = document.createElement('div');
    document.body.append(container);

    render(
      () => (
        <ErrorDisplay
          message="unsupported"
          errorType="codec"
          onRetry={() => {}}
          onSelectNewFile={() => {}}
        />
      ),
      container
    );
    await Promise.resolve();

    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="error-select-different-fallback-button"]')
    );
  });

  it('presents and focuses same-file Retry for typed owned WebP recovery', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const onRetry = vi.fn();
    const onSelectNewFile = vi.fn();
    const dispose = render(
      () => (
        <StatusAlerts
          t={((key: string) => key) as TFunction}
          environmentSupported
          errorMessage="Owned VP8 WASM request failed (HTTP 503)"
          errorContext={{
            type: 'format',
            code: 'ENCODER_ERROR',
            originalError: 'Owned VP8 WASM request failed (HTTP 503)',
            phase: 'owned_vp8_initialization',
            recovery: 'retry',
            timestamp: 0,
          }}
          canRetry
          onRetry={onRetry}
          onSelectNewFile={onSelectNewFile}
          onDismissError={() => {}}
        />
      ),
      container
    );
    try {
      await Promise.resolve();
      const retry = container.querySelector<HTMLButtonElement>(
        '[data-testid="error-retry-button"]'
      );
      expect(retry).not.toBeNull();
      expect(document.activeElement).toBe(retry);
      expect(container.textContent).not.toContain('error.format');
      expect(container.textContent).toContain('HTTP 503');
      retry?.click();
      expect(onRetry).toHaveBeenCalledOnce();
      expect(onSelectNewFile).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('keeps a generic format error on the different-file action', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = render(
      () => (
        <ErrorDisplay
          message="Unsupported file"
          errorType="format"
          canRetry
          onRetry={() => {}}
          onSelectNewFile={() => {}}
        />
      ),
      container
    );
    try {
      expect(container.querySelector('[data-testid="error-retry-button"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="error-select-different-fallback-button"]')
      ).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('offers a different file and focuses it when no current file can be retried', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const onRetry = vi.fn();
    const onSelectNewFile = vi.fn();
    render(
      () => (
        <ErrorDisplay
          message="unsupported input"
          canRetry={false}
          recovery="retry"
          onRetry={onRetry}
          onSelectNewFile={onSelectNewFile}
        />
      ),
      container
    );
    await Promise.resolve();
    expect(container.querySelector('[data-testid="error-retry-button"]')).toBeNull();
    const select = container.querySelector<HTMLButtonElement>(
      '[data-testid="error-select-different-fallback-button"]'
    )!;
    expect(document.activeElement).toBe(select);
    select.click();
    expect(onSelectNewFile).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
