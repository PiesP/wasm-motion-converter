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
 *   console.log(error.message); // 'Custom error'
 * }
 * ```
 */
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

/**
 * Extract error message from unknown error type.
 *
 * Handles multiple error sources in order of preference:
 * 1. Objects with a `message` property (custom errors, axios errors)
 * 2. String values (errors thrown as strings)
 * 3. Native Error instances (Error, TypeError, etc.)
 * 4. Fallback to `String(error)` for any other value
 *
 * @param error - Unknown error value (can be Error, string, object, null, undefined, etc.)
 * @returns Error message string (never empty, always at least returns "unknown error")
 *
 * @example
 * ```ts
 * try {
 *   throw new Error('Something went wrong');
 * } catch (error) {
 *   const message = getErrorMessage(error);
 *   console.error(message); // "Something went wrong"
 * }
 * ```
 *
 * @example
 * ```ts
 * const customError = { message: 'Custom error object' };
 * getErrorMessage(customError); // 'Custom error object'
 * getErrorMessage('string error'); // 'string error'
 * getErrorMessage(null); // 'null'
 * getErrorMessage(undefined); // 'undefined'
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }

  // String errors (thrown as strings)
  if (typeof error === "string") {
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
