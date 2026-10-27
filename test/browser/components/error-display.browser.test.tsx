// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

import ErrorDisplay from '@components/ErrorDisplay';

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

it('does not advertise retry or a new file for terminal WASM initialization', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const dispose = render(
    () => (
      <ErrorDisplay
        message="WebP initialization failed (factory)"
        reloadRequired
        onRetry={() => {
          throw new Error('unexpected retry');
        }}
        onSelectNewFile={() => {
          throw new Error('unexpected new file');
        }}
      />
    ),
    container
  );
  expect(container.querySelector('button')).toBeNull();
  dispose();
});
