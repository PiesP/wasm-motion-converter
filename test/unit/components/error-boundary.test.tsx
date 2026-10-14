// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import AppErrorFallback from '@components/AppErrorFallback';
import type { ConversionResult } from '@t/conversion-types';
import type { TFunction } from '@t/i18n-types';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

const t = ((key: string) => `translated:${key}`) as TFunction;
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const base = {
  busy: false,
  cancelling: false,
  results: [] as ConversionResult[],
  onCancel: () => {},
  onClearResults: () => {},
};

afterEach(() => {
  document.body.innerHTML = '';
  if (originalCreateObjectURL)
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL)
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('AppErrorFallback', () => {
  it('renders the actual fallback content and String(error) representation', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(
      () => (
        <AppErrorFallback {...base} error={new Error('Render crashed!')} reset={() => {}} t={t} />
      ),
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

    render(() => <AppErrorFallback {...base} error="failure" reset={reset} t={t} />, container);
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'translated:app.error.retry'
    );
    retry?.click();

    expect(reset).toHaveBeenCalledOnce();
    expect(container.querySelector('pre')?.textContent).toContain('failure');
  });

  it('does not offer boundary reset as a missing-module repair', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const reset = vi.fn();
    render(
      () => (
        <AppErrorFallback
          {...base}
          error={
            new TypeError('Failed to fetch dynamically imported module: /assets/codec.ABCDef12.js')
          }
          reset={reset}
          t={t}
        />
      ),
      container
    );
    expect(container.textContent).not.toContain('translated:app.error.retry');
    expect(container.querySelector('[data-testid="recovery-reload"]')).not.toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });

  it('keeps wrong-MIME module failures on the protected reload path', () => {
    const container = document.createElement('div');
    document.body.append(container);
    render(
      () => (
        <AppErrorFallback
          {...base}
          error={
            new TypeError('Failed to load a module script: non-JavaScript MIME type text/html')
          }
          reset={() => {}}
          t={t}
        />
      ),
      container
    );
    expect(container.textContent).not.toContain('translated:app.error.retry');
    expect(container.querySelector('[data-testid="recovery-reload"]')).not.toBeNull();
  });

  it('keeps cancellation and retained Blob download usable after a feature failure', () => {
    const blob = new Blob(['retained output'], { type: 'image/gif' });
    const result: ConversionResult = {
      id: 'one',
      outputBlob: blob,
      originalName: '../clip.mp4',
      originalSize: 14,
      outputWidth: 1,
      outputHeight: 1,
      createdAt: 1,
      settings: {
        format: 'gif',
        quality: 'low',
        scale: 0.5,
        trimStart: 0,
        trimEnd: 0,
        smartFrameSkip: 'off',
      },
    };
    const createUrl = vi.fn(() => 'blob:retained');
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
    const [busy, setBusy] = createSignal(true);
    const [results, setResults] = createSignal([result]);
    const cancel = vi.fn();
    const clear = vi.fn(() => setResults([]));
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = render(
      () => (
        <AppErrorFallback
          {...base}
          error={new Error('Feature render failed')}
          reset={() => {}}
          t={t}
          busy={busy()}
          results={results()}
          onCancel={cancel}
          onClearResults={clear}
        />
      ),
      container
    );
    expect(
      container.querySelector('[data-testid="recovery-result-download"]')?.getAttribute('href')
    ).toBe('blob:retained');
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(createUrl).toHaveBeenCalledWith(blob);
    expect(
      container.querySelector('[data-testid="recovery-result-download"]')?.getAttribute('download')
    ).toBe('__clip.gif');
    const reload = container.querySelector<HTMLButtonElement>('[data-testid="recovery-reload"]')!;
    const clearButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="recovery-clear-results"]'
    )!;
    expect(reload.disabled).toBe(true);
    clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clear).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[data-testid="recovery-cancel"]')?.click();
    expect(cancel).toHaveBeenCalledOnce();
    setBusy(false);
    expect(clearButton.disabled).toBe(false);
    clearButton.click();
    expect(clear).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith('blob:retained');
    expect(reload.disabled).toBe(false);
    dispose();
  });
});
