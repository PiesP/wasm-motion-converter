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
});
