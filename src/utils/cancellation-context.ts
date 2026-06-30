// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Cancellation Context Utility
 *
 * Centralised cancellation primitives for conversion operations.
 */

/**
 * Type guard: check whether an error was triggered by a user cancellation.
 */
export function isCancellationError(error: unknown): boolean {
  // Primary check: name === 'AbortError' (covers DOMException, regular Error,
  // and any error-like object with the AbortError name)
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  ) {
    return true;
  }

  // Check for AbortSignal abort (e.g., signal.aborted passed as error cause)
  if (
    typeof error === 'object' &&
    error !== null &&
    'cause' in error &&
    (error as { cause: unknown }).cause instanceof DOMException &&
    (error as { cause: DOMException }).cause.name === 'AbortError'
  ) {
    return true;
  }

  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message).toLowerCase()
      : String(error).toLowerCase();

  // Fallback: match user-cancellation phrases only
  return message.includes('cancelled') || message.includes('canceled');
}
