// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionProgress, ProgressCallback } from '@t/conversion-types';

import { PROGRESS_THROTTLE_MS } from './constants';

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
  minIntervalMs = PROGRESS_THROTTLE_MS
): { callback: ProgressCallback; flush: () => void; cleanup: () => void } {
  let lastCallTime = 0;
  let pendingCall: (() => void) | null = null;
  let scheduled = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let highestProgress = 0;

  const flush = () => {
    if (disposed) return;
    if (timerId !== null) {
      clearTimeout(timerId);
    }
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
    highestProgress = Math.max(highestProgress, Math.min(100, Math.max(0, update.progress)));
    const current = { ...update, progress: highestProgress };
    const now = performance.now();
    const elapsed = now - lastCallTime;

    if (elapsed >= minIntervalMs) {
      pendingCall = null;
      if (timerId !== null) clearTimeout(timerId);
      timerId = null;
      scheduled = false;
      lastCallTime = now;
      onProgress(current);
    } else {
      // Schedule a trailing call so the final state is not lost
      pendingCall = () => {
        lastCallTime = performance.now();
        onProgress(current);
      };
      if (!scheduled) {
        scheduled = true;
        timerId = setTimeout(flush, minIntervalMs - elapsed);
      }
    }
  };

  return { callback, flush, cleanup };
}
