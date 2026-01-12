import { logger } from './logger';

/**
 * Wraps a promise with a timeout
 *
 * Executes a promise and rejects if it doesn't complete within the specified timeout.
 * Ensures cleanup of timeout handlers and executes optional callback before rejection.
 *
 * Strategy:
 * - Uses Promise.race() to compete the operation promise against a timeout promise
 * - Cleanup is guaranteed via finally block
 * - Optional callback allows for side effects (logging, state updates) before timeout
 * - Maintains type safety with generics
 *
 * @template T - The resolved value type of the promise
 * @param promise - The promise to wrap with timeout protection
 * @param timeoutMs - Timeout duration in milliseconds (must be positive)
 * @param errorMessage - Custom error message to reject with on timeout
 * @param onTimeout - Optional callback executed before timeout rejection (for cleanup/side effects)
 * @returns Promise that resolves with the original promise value or rejects on timeout
 * @throws Error with provided errorMessage if timeout is reached before promise settles
 *
 * @example
 * // Basic usage with fetch
 * try {
 *   const data = await withTimeout(
 *     fetch('/api/data').then(r => r.json()),
 *     5000,
 *     'API request timed out'
 *   );
 * } catch (error) {
 *   console.error(error.message);
 * }
 *
 * @example
 * // With cleanup callback
 * const timeout = await withTimeout(
 *   operation,
 *   30000,
 *   'Operation exceeded 30 seconds',
 *   () => {
 *     logger.warn('general', 'Operation timeout triggered');
 *     // Cancel ongoing operations, cleanup resources
 *   }
 * );
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
  onTimeout?: () => void
): Promise<T> {
  // Validate timeout value
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeoutMs: ${timeoutMs}. Must be a positive number.`);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;

      // Execute cleanup callback before rejection
      try {
        if (onTimeout) {
          onTimeout();
        }
      } catch (error) {
        // Log callback errors but don't suppress the timeout rejection
        logger.warn('general', 'Error in timeout callback', {
          error: error instanceof Error ? error.message : String(error),
          timeoutMs,
        });
      }

      logger.warn('general', 'Promise timeout reached', {
        timeoutMs,
        message: errorMessage,
      });

      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    // Prevent potential unhandled rejections from the original promise if it
    // settles after a timeout.
    if (didTimeout) {
      void promise.catch(() => undefined);
    }

    // Ensure timeout is always cleaned up
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
