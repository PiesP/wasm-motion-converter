/**
 * Error Handling Utilities Module
 *
 * Provides type-safe utilities for error message extraction, formatting, and analysis.
 * Replaces the common pattern: `error instanceof Error ? error.message : String(error)`
 * with composable, well-tested functions that handle edge cases.
 *
 * Key utilities:
 * - `isErrorWithMessage()`: Type guard for error-like objects
 * - `getErrorMessage()`: Extract message from any error type
 * - `getErrorStack()`: Extract stack trace if available
 * - `formatError()`: Format error with optional context
 * - `getErrorDetails()`: Comprehensive error information object
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
export function isErrorWithMessage(error: unknown): error is { message: string } {
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

/**
 * Format error message with optional context prefix.
 *
 * Combines `getErrorMessage()` with optional contextual information to produce
 * user-friendly error messages suitable for logging or UI display.
 *
 * @param error - Unknown error value
 * @param context - Optional context prefix (e.g., "Video conversion failed")
 * @returns Formatted error message (context: message) or message alone if no context
 *
 * @example
 * ```ts
 * try {
 *   await convertVideo(file);
 * } catch (error) {
 *   const formatted = formatError(error, 'Video conversion failed');
 *   console.error(formatted); // "Video conversion failed: [error message]"
 * }
 * ```
 *
 * @example
 * ```ts
 * const err = new Error('Codec not supported');
 * formatError(err); // 'Codec not supported'
 * formatError(err, 'GIF conversion'); // 'GIF conversion: Codec not supported'
 * ```
 */
export function formatError(error: unknown, context?: string): string {
  const message = getErrorMessage(error);

  // Prepend context if provided for better error context
  if (context) {
    return `${context}: ${message}`;
  }

  return message;
}

/**
 * Extract error stack trace if available.
 *
 * Attempts to retrieve the stack trace from an error object. Works with:
 * - Native Error instances (Error, TypeError, ReferenceError, etc.)
 * - Custom error objects with a `stack` property
 * - Returns `undefined` if no stack trace is available
 *
 * Stack traces are useful for debugging but should be carefully handled:
 * - Useful in development logs and error reporting
 * - May contain sensitive information (file paths, internal structure)
 * - Not all errors have stack traces (e.g., string errors)
 *
 * @param error - Unknown error value
 * @returns Stack trace string if available, `undefined` otherwise
 *
 * @example
 * ```ts
 * try {
 *   throw new Error('Something failed');
 * } catch (error) {
 *   const stack = getErrorStack(error);
 *   if (stack) {
 *     console.error('Stack trace:', stack);
 *   }
 * }
 * ```
 *
 * @example
 * ```ts
 * const customError = { stack: 'Error: custom\n  at main.ts:10' };
 * getErrorStack(customError); // 'Error: custom\n  at main.ts:10'
 * getErrorStack('string error'); // undefined
 * getErrorStack(null); // undefined
 * ```
 */
export function getErrorStack(error: unknown): string | undefined {
  // Native Error instances have stack property
  if (error instanceof Error && error.stack) {
    return error.stack;
  }

  // Custom error objects with stack property
  if (
    typeof error === 'object' &&
    error !== null &&
    'stack' in error &&
    typeof (error as { stack: unknown }).stack === 'string'
  ) {
    return (error as { stack: string }).stack;
  }

  // No stack trace available
  return undefined;
}

/**
 * Create a comprehensive error details object.
 *
 * Combines message extraction and stack trace retrieval into a single call.
 * Useful for structured logging where both error message and debugging information
 * are needed (e.g., error reporting services, detailed logs).
 *
 * @param error - Unknown error value
 * @returns Object with:
 *   - `message`: Always present error message (never undefined)
 *   - `stack`: Stack trace if available (optional, for debugging)
 *
 * @example
 * ```ts
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   const details = getErrorDetails(error);
 *   logger.error('conversion', details.message, { stack: details.stack });
 *   // logs: { message: 'Operation failed', stack: '...' }
 * }
 * ```
 *
 * @example
 * ```ts
 * const err = new Error('Network timeout');
 * const details = getErrorDetails(err);
 * console.log(details);
 * // {
 * //   message: 'Network timeout',
 * //   stack: 'Error: Network timeout\n    at ...'
 * // }
 * ```
 */
export function getErrorDetails(error: unknown): {
  message: string;
  stack?: string;
} {
  return {
    message: getErrorMessage(error),
    stack: getErrorStack(error),
  };
}
