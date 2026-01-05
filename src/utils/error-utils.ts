/**
 * Error handling utilities
 *
 * Provides type-safe error message extraction and formatting
 * to replace the repeated pattern: error instanceof Error ? error.message : String(error)
 */

/**
 * Type guard to check if an error has a message property
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
 * Extract error message from unknown error type
 *
 * @param error - Unknown error value
 * @returns Error message string
 *
 * @example
 * ```typescript
 * try {
 *   throw new Error('Something went wrong');
 * } catch (error) {
 *   const message = getErrorMessage(error);
 *   console.error(message); // "Something went wrong"
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  // Handle Error objects that might not have standard structure
  if (error instanceof Error) {
    return error.message;
  }

  // Last resort: convert to string
  return String(error);
}

/**
 * Format error with optional context
 *
 * @param error - Unknown error value
 * @param context - Optional context string to prepend
 * @returns Formatted error message
 *
 * @example
 * ```typescript
 * try {
 *   await convertVideo(file);
 * } catch (error) {
 *   const formatted = formatError(error, 'Video conversion failed');
 *   console.error(formatted); // "Video conversion failed: [error message]"
 * }
 * ```
 */
export function formatError(error: unknown, context?: string): string {
  const message = getErrorMessage(error);

  if (context) {
    return `${context}: ${message}`;
  }

  return message;
}

/**
 * Extract error stack trace if available
 *
 * @param error - Unknown error value
 * @returns Stack trace string or undefined
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'stack' in error &&
    typeof (error as { stack: unknown }).stack === 'string'
  ) {
    return (error as { stack: string }).stack;
  }

  return undefined;
}

/**
 * Create a detailed error object with message and stack
 *
 * @param error - Unknown error value
 * @returns Object with message and optional stack
 *
 * @example
 * ```typescript
 * catch (error) {
 *   const details = getErrorDetails(error);
 *   logger.error('conversion', details.message, { stack: details.stack });
 * }
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
