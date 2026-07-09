// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * DOM focus helpers and scheduler utilities for common UI patterns.
 */

export type TaskPriority = 'user-blocking' | 'user-visible' | 'background';

/**
 * Feature-detected support for scheduler.postTask().
 * Cached since it doesn't change during a page session.
 */
const hasSchedulerPostTask =
  typeof globalThis.scheduler !== 'undefined' &&
  typeof globalThis.scheduler.postTask === 'function';

/**
 * Schedule a task with a given priority using the Prioritized Task Scheduling API.
 *
 * Falls back to `setTimeout(0)` for browsers without `scheduler.postTask()` (Safari).
 *
 * @param fn - The task function (can be async).
 * @param options - Options including priority.
 * @returns A promise that resolves with the task's return value.
 *
 * @example
 * ```ts
 * // user-blocking: tasks that block user interaction (decode, demux)
 * await scheduleTask(() => decodeFrames(...), { priority: 'user-blocking' });
 *
 * // user-visible: tasks visible to user but not blocking (encode)
 * await scheduleTask(() => encodeWebp(...), { priority: 'user-visible' });
 *
 * // background: non-time-critical tasks (analytics, logging)
 * scheduleTask(() => logger.performance('done', report), { priority: 'background' });
 * ```
 */
export function scheduleTask<T>(fn: () => T, options?: { priority?: TaskPriority }): Promise<T> {
  if (hasSchedulerPostTask) {
    return scheduler.postTask(fn, { priority: options?.priority ?? 'user-visible' });
  }
  // Safari fallback: setTimeout(0) schedules at the next timer tick,
  // which the browser treats as user-visible priority automatically.
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
}

/**
 * Focus a DOM element matching a selector on the next microtask.
 *
 * Useful after state changes that conditionally render elements,
 * since the element may not be in the DOM yet when the call is made.
 *
 * @param selector - CSS selector for the element to focus
 */
export function focusElement(selector: string): void {
  queueMicrotask(() => {
    document.querySelector<HTMLElement>(selector)?.focus();
  });
}

/** Focus the retry button after an error — used by both file-selection and conversion error paths. */
export function focusRetryButton(): void {
  focusElement('[data-testid="error-retry-button"]');
}

/**
 * Returns document.startViewTransition bound to document, or undefined if the
 * View Transition API is not supported. Callers pass this to transitionToState()
 * so the store layer doesn't need to reference document directly.
 */
export function getStartViewTransition():
  | ((callback: () => void) => void)
  | undefined {
  if ('startViewTransition' in document) {
    return document.startViewTransition.bind(document);
  }
  return undefined;
}
