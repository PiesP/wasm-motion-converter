// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  focusElementUnlessUserIsEditing,
  focusPrimaryErrorAction,
  scheduleTask,
} from '@utils/dom-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

describe('dom utilities', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

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

  it('focuses the retry action on the next microtask', async () => {
    const element = document.createElement('button');
    element.dataset.testid = 'error-retry-button';
    const focus = vi.spyOn(element, 'focus');
    document.body.append(element);

    focusPrimaryErrorAction();
    expect(focus).not.toHaveBeenCalled();
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

  it('resolves the current action after a queued target is replaced', async () => {
    const removedAction = document.createElement('button');
    removedAction.dataset.testid = 'error-retry-button';
    document.body.append(removedAction);

    focusPrimaryErrorAction();
    removedAction.remove();
    const currentAction = document.createElement('button');
    currentAction.dataset.testid = 'error-select-different-fallback-button';
    document.body.append(currentAction);
    await Promise.resolve();

    expect(document.activeElement).toBe(currentAction);
  });

  it('skips an error action disabled by its fieldset and uses an available reload', async () => {
    const fieldset = document.createElement('fieldset');
    fieldset.disabled = true;
    const retry = document.createElement('button');
    retry.dataset.testid = 'error-retry-button';
    fieldset.append(retry);
    const reload = document.createElement('button');
    reload.dataset.testid = 'app-recovery-reload';
    document.body.append(fieldset, reload);

    focusPrimaryErrorAction();
    await Promise.resolve();

    expect(document.activeElement).toBe(reload);
    expect(fieldset.disabled).toBe(true);
  });

  it.each(['disabled', 'removed'] as const)(
    'preserves focus when the only action becomes %s before the microtask',
    async (state) => {
      const previousAction = document.createElement('button');
      const reload = document.createElement('button');
      reload.dataset.testid = 'app-recovery-reload';
      document.body.append(previousAction, reload);
      previousAction.focus();

      focusPrimaryErrorAction();
      if (state === 'disabled') reload.disabled = true;
      else reload.remove();
      await Promise.resolve();

      expect(document.activeElement).toBe(previousAction);
    }
  );

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

it('focuses explicit reload when terminal initialization has no retry action', async () => {
  const button = document.createElement('button');
  button.dataset.testid = 'app-recovery-reload';
  document.body.append(button);
  focusPrimaryErrorAction();
  await Promise.resolve();
  expect(document.activeElement).toBe(button);
  button.remove();
});
