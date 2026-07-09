// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Error Handling Utilities Module
 *
 * Provides type-safe utilities for error message extraction, formatting,
 * cancellation detection, and analysis.
 * Replaces the common pattern: `error instanceof Error ? error.message : String(error)`
 * with composable, well-tested functions that handle edge cases.
 */

/**
 * Type guard to check if an error object has a message property.
 *
 * Safely narrows an unknown type to an object with a string `message` property.
 *
 * @param error - Unknown value to check
 * @returns `true` if error has a string message property, `false` otherwise
 */
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Extract error message from unknown error type.
 *
 * Handles Error objects, objects with a `message` property, and string errors.
 *
 * @param error - Unknown error value
 * @returns Error message string (falls back to String(error) for unexpected types)
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Type guard: check whether an error was triggered by a user cancellation.
 *
 * Checks for AbortError name, AbortSignal abort causes, and cancellation
 * keywords in the message. Covers DOMException, regular Error, and any
 * error-like object with the AbortError name.
 */
export function isCancellationError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  ) {
    return true;
  }

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

  return message.includes('cancelled') || message.includes('canceled');
}
