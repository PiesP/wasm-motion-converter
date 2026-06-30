// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Error Handling Utilities Module
 *
 * Provides type-safe utilities for error message extraction, formatting, and analysis.
 * Replaces the common pattern: `error instanceof Error ? error.message : String(error)`
 * with composable, well-tested functions that handle edge cases.
 *
 * Key utilities:
 * - `getErrorMessage()`: Extract message from any error type
 */

/**
 * Type guard to check if an error object has a message property.
 *
 * Safely narrows an unknown type to an object with a string `message` property.
 * Used by other error utilities to extract messages from non-standard error objects.
 *
 * @param error - Unknown value to check
 * @returns `true` if error has a string message property, `false` otherwise
 *
 * @example
 * ```ts
 * const error = { message: 'Custom error' };
 * if (isErrorWithMessage(error)) {
 *   logger.debug('general', 'Error message', { message: error.message });
 * }
 * ```
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
 *
 * @example
 * ```ts
 * getErrorMessage(new Error('Something went wrong')); // 'Something went wrong'
 * getErrorMessage({ message: 'Custom error' });       // 'Custom error'
 * getErrorMessage('string error');                     // 'string error'
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }

  // String errors (thrown as strings)
  if (typeof error === 'string') {
    return error;
  }

  // Native Error instances (Error, TypeError, ReferenceError, etc.)
  // Some Error subclasses might not pass isErrorWithMessage check
  if (error instanceof Error) {
    return error.message;
  }

  // Fallback: convert any other value to string representation
  return String(error);
}
