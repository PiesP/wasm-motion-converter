// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import AppErrorFallback from '@components/AppErrorFallback';
import type { TFunction } from '@t/i18n-types';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

const t = ((key: string) => `translated:${key}`) as TFunction;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AppErrorFallback', () => {
  it('renders the actual fallback content and String(error) representation', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(
      () => <AppErrorFallback error={new Error('Render crashed!')} reset={() => {}} t={t} />,
      container
    );

    expect(container.querySelector('h2')?.textContent).toBe('translated:app.error.title');
    expect(container.querySelector('pre')?.textContent).toContain('Error: Render crashed!');
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('wires the retry button to the ErrorBoundary reset callback', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const reset = vi.fn();

    render(() => <AppErrorFallback error="failure" reset={reset} t={t} />, container);
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'translated:app.error.retry'
    );
    retry?.click();

    expect(reset).toHaveBeenCalledOnce();
    expect(container.querySelector('pre')?.textContent).toContain('failure');
  });
});
