// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusElement,
  focusElementUnlessUserIsEditing,
  focusPrimaryErrorAction,
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
    focusPrimaryErrorAction();
    await Promise.resolve();
    expect(focus).toHaveBeenCalled();
  });

  it('focuses the select-different action when an error cannot be retried', async () => {
    const element = document.createElement('button');
    element.dataset.testid = 'error-select-different-fallback-button';
    const focus = vi.spyOn(element, 'focus');
    document.body.append(element);

    focusPrimaryErrorAction();
    await Promise.resolve();

    expect(focus).toHaveBeenCalled();
  });

  it('preserves an input the user is editing when a result action appears', async () => {
    const input = document.createElement('input');
    const resultAction = document.createElement('a');
    resultAction.href = '#result';
    resultAction.dataset.testid = 'download-result-button';
    const focusResult = vi.spyOn(resultAction, 'focus');
    document.body.append(input, resultAction);
    input.focus();

    focusElementUnlessUserIsEditing('[data-testid="download-result-button"]');
    await Promise.resolve();

    expect(document.activeElement).toBe(input);
    expect(focusResult).not.toHaveBeenCalled();
  });

  it('focuses a result action when no editable control owns focus', async () => {
    const resultAction = document.createElement('a');
    resultAction.href = '#result';
    resultAction.dataset.testid = 'download-result-button';
    const focusResult = vi.spyOn(resultAction, 'focus');
    document.body.append(resultAction);

    focusElementUnlessUserIsEditing('[data-testid="download-result-button"]');
    await Promise.resolve();

    expect(focusResult).toHaveBeenCalled();
  });
});
