// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusElement,
  focusRetryButton,
  getStartViewTransition,
  scheduleTask,
} from '@utils/dom-utils';

describe('dom utilities', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs scheduled work on the fallback timer and propagates results', async () => {
    const task = vi.fn(() => 42);
    const result = scheduleTask(task, { priority: 'background' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(42);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('rejects when scheduled work throws', async () => {
    const result = scheduleTask(() => {
      throw new Error('scheduled failure');
    });
    const assertion = expect(result).rejects.toThrow('scheduled failure');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('focuses a selector on the next microtask', async () => {
    const element = document.createElement('button');
    element.dataset.testid = 'error-retry-button';
    const focus = vi.spyOn(element, 'focus');
    document.body.append(element);

    focusElement('[data-testid="error-retry-button"]');
    await Promise.resolve();
    expect(focus).toHaveBeenCalled();

    focus.mockClear();
    focusRetryButton();
    await Promise.resolve();
    expect(focus).toHaveBeenCalled();
  });

  it('returns undefined when view transitions are unsupported', () => {
    expect(getStartViewTransition()).toBeUndefined();
  });
});
