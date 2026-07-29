// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import * as TrimSelectorModule from '@components/TrimSelector';
import type { TFunction } from '@t/i18n-types';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

const translateTrimSummary = ((key: string, params?: Record<string, string | number>) => {
  if (key === 'trim.summary') {
    return `${params?.duration} ث (${params?.percent}) · نحو ${params?.frames} إطارًا`;
  }
  return key;
}) as TFunction;

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    locale: () => 'ar',
    t: translateTrimSummary,
  }),
}));

const TrimSelector = TrimSelectorModule.default;

const expectedArabicSummary = (): string => {
  const duration = new Intl.NumberFormat('ar', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(75);
  const percent = new Intl.NumberFormat('ar', {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(0.75);
  const frames = new Intl.NumberFormat('ar').format(1500);
  return `${duration} ث (${percent}) · نحو ${frames} إطارًا`;
};

describe('TrimSelector localized summary', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders Intl-formatted duration, percentage, and frame units', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => (
        <TrimSelector
          duration={100}
          trimStart={25}
          trimEnd={0}
          estimatedFps={20}
          onChange={() => {}}
        />
      ),
      container
    );

    expect(container.querySelector('[data-testid="trim-summary"]')?.textContent).toBe(
      expectedArabicSummary()
    );
  });

  it('exposes the pure formatter used by the component', () => {
    const formatTrimSummary = (
      TrimSelectorModule as unknown as {
        formatTrimSummary?: (
          durationSeconds: number,
          totalDurationSeconds: number,
          frameCount: number,
          locale: string,
          t: TFunction
        ) => string;
      }
    ).formatTrimSummary;

    expect(formatTrimSummary).toBeTypeOf('function');
    expect(formatTrimSummary?.(75, 100, 1500, 'ar', translateTrimSummary)).toBe(
      expectedArabicSummary()
    );
  });

  it('renders precise time fields and dependent slider constraints', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => (
        <TrimSelector
          duration={10}
          trimStart={2}
          trimEnd={8}
          estimatedFps={20}
          onChange={() => {}}
        />
      ),
      container
    );

    const startHandle = container.querySelector('[data-testid="trim-start-handle"]');
    const endHandle = container.querySelector('[data-testid="trim-end-handle"]');
    const timeline = container.querySelector<HTMLInputElement>(
      '[data-testid="trim-timeline"] input[type="range"]'
    );

    expect(container.querySelector<HTMLInputElement>('#trim-start-input')?.value).toBe('0:02.0');
    expect(container.querySelector<HTMLInputElement>('#trim-end-input')?.value).toBe('0:08.0');
    expect(startHandle?.getAttribute('aria-valuemax')).toBe('7.9');
    expect(endHandle?.getAttribute('aria-valuemin')).toBe('2.1');
    expect(timeline?.max).toBe('10');
  });

  it('uses hours in precise time fields for long videos', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => (
        <TrimSelector duration={3661.2} trimStart={0} trimEnd={0} onChange={() => {}} />
      ),
      container
    );

    expect(container.querySelector<HTMLInputElement>('#trim-end-input')?.value).toBe('1:01:01.2');
  });

  it('supports standard slider keys and seeks to the adjusted boundary', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onChange = vi.fn();
    const onSeek = vi.fn();
    render(
      () => (
        <TrimSelector
          duration={10}
          trimStart={2}
          trimEnd={8}
          onChange={onChange}
          onSeek={onSeek}
        />
      ),
      container
    );

    container
      .querySelector('[data-testid="trim-start-handle"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));

    expect(onChange).toHaveBeenCalledWith(0, 8);
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it('reports invalid text input without changing the selected range', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onChange = vi.fn();
    render(
      () => <TrimSelector duration={10} trimStart={2} trimEnd={8} onChange={onChange} />,
      container
    );

    const input = container.querySelector<HTMLInputElement>('#trim-start-input')!;
    input.focus();
    input.value = '9.0';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.blur();

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('#trim-start-error')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps common presets visible and delegates selection preview', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onChange = vi.fn();
    const onPreviewSelection = vi.fn();
    render(
      () => (
        <TrimSelector
          duration={40}
          trimStart={0}
          trimEnd={0}
          onChange={onChange}
          onPreviewSelection={onPreviewSelection}
        />
      ),
      container
    );

    expect(container.querySelectorAll('[data-testid^="trim-preset-"]')).toHaveLength(3);
    expect(
      container.querySelectorAll<HTMLSelectElement>('[data-testid="trim-more-presets"] option')
    ).toHaveLength(7);

    container.querySelector<HTMLButtonElement>('[data-testid="trim-preview-button"]')?.click();
    expect(onPreviewSelection).toHaveBeenCalledOnce();
  });
});
