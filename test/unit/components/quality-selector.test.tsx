// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import QualitySelector from '@components/QualitySelector';
import type { TFunction } from '@t/i18n-types';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

const t = ((key: string, params?: Record<string, string | number>) =>
  params?.fps === undefined ? key : `${key}:${params.fps}`) as TFunction;

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({ locale: () => 'en', t }),
}));

describe('QualitySelector format-aware frame-rate descriptions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows GIF target FPS for every quality preset', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => <QualitySelector format="gif" value="medium" onChange={() => {}} />,
      container
    );

    expect(container.textContent).toContain('quality.lowDesc:8');
    expect(container.textContent).toContain('quality.mediumDesc:12');
    expect(container.textContent).toContain('quality.highDesc:20');
  });

  it('shows WebP target FPS for every quality preset', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => <QualitySelector format="webp" value="medium" onChange={() => {}} />,
      container
    );

    expect(container.textContent).toContain('quality.lowDesc:12');
    expect(container.textContent).toContain('quality.mediumDesc:18');
    expect(container.textContent).toContain('quality.highDesc:30');
  });
});
