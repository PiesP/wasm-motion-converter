// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionProgress, ProgressCallback } from '@t/conversion-types';

/**
 * Throttled progress wrapper — prevents UI re-render spam by enforcing a
 * minimum interval between onProgress calls. Without throttling, the encode
 * progress callbacks fire on every frame (30+/sec), causing excessive SolidJS
 * signal writes and re-renders during conversion.
 *
 * Extracted as a standalone utility so it can be reused by any long-running
 * async operation that needs to throttle progress updates.
 */
export function createThrottledProgress(
  onProgress: ProgressCallback,
  minIntervalMs = 100
): { callback: ProgressCallback; cleanup: () => void } {
  let lastCallTime = 0;
  let pendingCall: (() => void) | null = null;
  let scheduled = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = () => {
    if (disposed) return;
    scheduled = false;
    timerId = null;
    if (pendingCall) {
      pendingCall();
      pendingCall = null;
    }
  };

  const cleanup = () => {
    disposed = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    scheduled = false;
    pendingCall = null;
  };

  const callback = (update: ConversionProgress) => {
    if (disposed) return;
    const now = performance.now();
    const elapsed = now - lastCallTime;

    if (elapsed >= minIntervalMs) {
      lastCallTime = now;
      onProgress(update);
    } else {
      // Schedule a trailing call so the final state is not lost
      pendingCall = () => {
        lastCallTime = performance.now();
        onProgress(update);
      };
      if (!scheduled) {
        scheduled = true;
        timerId = setTimeout(flush, minIntervalMs - elapsed);
      }
    }
  };

  return { callback, cleanup };
}
