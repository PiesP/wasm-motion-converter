// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * DOM focus helpers for common UI patterns.
 */

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
