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
  if (error instanceof DOMException && error.name === 'AbortError') {
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

  // Only match explicit cancellation messages — avoid generic 'abort' which
  // could match unrelated errors like 'abort decode'
  return message.includes('cancelled') || message.includes('canceled');
}
