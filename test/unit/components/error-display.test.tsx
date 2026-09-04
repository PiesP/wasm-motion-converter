// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
