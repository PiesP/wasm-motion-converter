// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { createThrottledProgress } from '@utils/throttled-progress';
import type { ConversionProgress } from '@t/conversion-types';

function makeProgress(overrides: Partial<ConversionProgress> = {}): ConversionProgress {
  return {
    phase: 'encoding',
    progress: 50,
    fps: 30,
    etaSeconds: 10,
    memoryMB: 256,
    ...overrides,
  };
}

describe('createThrottledProgress', () => {
  beforeEach(() => {
    // Fake both timers and performance.now so that:
    // - setTimeout is controlled via vi.advanceTimersByTime()
    // - performance.now() returns faked time that advances with vi.advanceTimersByTime()
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── First call fires immediately ───────────────────────────

  it('fires the callback immediately on the first call', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress, 100);

    // Advance time so lastCallTime(0) - now >= 100
    vi.advanceTimersByTime(100);
    callback(makeProgress({ progress: 10 }));

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ progress: 10 }));

    cleanup();
  });

  // ── Second call within interval is deferred ────────────────

  it('defers a second call that arrives within minIntervalMs', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress, 100);

    vi.advanceTimersByTime(100);
    callback(makeProgress({ progress: 10 })); // fires, lastCallTime=100

    // Only 50ms elapsed
    callback(makeProgress({ progress: 20 })); // deferred

    // First call should have fired immediately
    expect(onProgress).toHaveBeenCalledTimes(1);

    // Advance time enough for the deferred flush (setTimeout(flush, 100))
    vi.advanceTimersByTime(100);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 20 })
    );

    cleanup();
  });

  // ── Trailing call delivers the last value ──────────────────

  it('only delivers the most recent value when multiple calls arrive in rapid succession', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress, 100);

    vi.advanceTimersByTime(100);
    callback(makeProgress({ progress: 10 })); // fires

    // Multiple calls in rapid succession
    vi.advanceTimersByTime(30); // total elapsed from start: 130ms
    callback(makeProgress({ progress: 30 })); // deferred (overwritten)

    vi.advanceTimersByTime(30); // total: 160ms
    callback(makeProgress({ progress: 50 })); // overwrites pending

    // Only first call fired
    expect(onProgress).toHaveBeenCalledTimes(1);

    // Flush the deferred timer (setTimeout(flush, 100-60=40))
    vi.advanceTimersByTime(40); // total: 200ms

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 50 })
    );

    cleanup();
  });

  // ── Call after interval fires immediately ──────────────────

  it('fires immediately when elapsed time exceeds minIntervalMs', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress, 100);

    vi.advanceTimersByTime(100);
    callback(makeProgress({ progress: 10 })); // fires, lastCallTime=100

    vi.advanceTimersByTime(150); // total: 250ms, elapsed 150ms > 100ms
    callback(makeProgress({ progress: 20 })); // fires immediately

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 20 })
    );

    cleanup();
  });

  // ── Cleanup prevents leaks ─────────────────────────────────

  it('cleanup clears the pending timeout', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress, 100);

    vi.advanceTimersByTime(100);
    callback(makeProgress({ progress: 10 })); // fires

    // Deferred call
    vi.advanceTimersByTime(50); // total: 150ms
    callback(makeProgress({ progress: 20 })); // deferred

    cleanup();

    // Advance time to where the flush would have fired
    vi.advanceTimersByTime(50);

    // Should not have fired after cleanup
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  // ── Disposed prevents further calls ────────────────────────

  it('callback does nothing after cleanup is called', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress, 100);

    vi.advanceTimersByTime(100);
    callback(makeProgress({ progress: 10 })); // fires

    cleanup();

    callback(makeProgress({ progress: 30 })); // disposed, no-op

    // Only the pre-cleanup call should have fired
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  // ── Default minIntervalMs is 100 ───────────────────────────

  it('uses default minIntervalMs of 100 when not provided', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress);

    vi.advanceTimersByTime(100);
    callback(makeProgress({ progress: 10 })); // fires

    callback(makeProgress({ progress: 20 })); // deferred

    expect(onProgress).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(onProgress).toHaveBeenCalledTimes(2);

    cleanup();
  });

  // ── Custom minIntervalMs works ─────────────────────────────

  it('respects a custom minIntervalMs value', () => {
    const onProgress = vi.fn();
    const { callback, cleanup } = createThrottledProgress(onProgress, 500);

    vi.advanceTimersByTime(500);
    callback(makeProgress({ progress: 10 })); // fires, lastCallTime=500

    // 400ms is within 500ms interval
    vi.advanceTimersByTime(400); // total: 900ms
    callback(makeProgress({ progress: 20 })); // deferred

    expect(onProgress).toHaveBeenCalledTimes(1);

    // Advance enough to trigger deferred flush (500 - 400 = 100ms)
    vi.advanceTimersByTime(100); // total: 1000ms
    expect(onProgress).toHaveBeenCalledTimes(2);

    // Now elapsed well beyond 500ms
    vi.advanceTimersByTime(500); // total: 1500ms
    callback(makeProgress({ progress: 30 }));
    expect(onProgress).toHaveBeenCalledTimes(3);

    cleanup();
  });
});
