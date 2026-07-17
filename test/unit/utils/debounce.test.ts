// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from '@utils/debounce';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays function invocation', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('resets timer on each call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    vi.advanceTimersByTime(50);

    debounced('b');
    vi.advanceTimersByTime(50);

    debounced('c');
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('supports cancel()', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(200);

    expect(fn).not.toHaveBeenCalled();
  });

  it('supports flush()', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    debounced.flush();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');

    // After flush, timer should be cleared
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush with no pending call is a no-op', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes multiple arguments', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced(1, 'two', true);
    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledWith(1, 'two', true);
  });

  it('handles zero wait', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 0);

    debounced('instant');
    vi.advanceTimersToNextTimer();

    expect(fn).toHaveBeenCalledWith('instant');
  });
});
