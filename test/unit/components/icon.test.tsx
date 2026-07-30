// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import Icon from '@components/ui/Icon';
import { render } from 'solid-js/web';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    t: (key: string) => key,
  }),
}));

describe('Icon design contract', () => {
  it('applies the shared geometry and hides decorative icons by default', () => {
    const container = document.createElement('div');
    document.body.append(container);
    render(() => <Icon name="info" />, container);

    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(icon?.getAttribute('stroke-width')).toBe('1.75');
    expect(icon?.getAttribute('stroke-linecap')).toBe('round');
    expect(icon?.getAttribute('stroke-linejoin')).toBe('round');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.hasAttribute('aria-label')).toBe(false);
  });

  it.each([false, 'false'] as const)('exposes an accessible name for aria-hidden=%s', (ariaHidden) => {
    const container = document.createElement('div');
    document.body.append(container);
    render(() => <Icon name="info" aria-hidden={ariaHidden} />, container);

    const icon = container.querySelector('svg');
    expect(icon?.hasAttribute('aria-hidden')).toBe(false);
    expect(icon?.getAttribute('aria-label')).toBe('Info');
  });
});
