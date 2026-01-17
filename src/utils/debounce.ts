/**
 * Debounce Utility Module
 *
 * Provides a debounced function wrapper that delays function invocation until
 * after a specified delay has elapsed since the last call. Useful for performance
 * optimization when handling frequent events (scroll, resize, input).
 */

/**
 * Creates a debounced function that delays invoking the provided function
 * until after the specified delay has elapsed since the last time the debounced
 * function was invoked.
 *
 * Each call to the debounced function resets the delay timer. The original function
 * is only executed after the delay has passed without any new invocations.
 *
 * @template T - The type of the function to debounce
 * @param func - The function to debounce
 * @param wait - The number of milliseconds to delay (e.g., 300, 500, 1000)
 * @returns A debounced version of the function that returns void
 *
 * @example
 * ```ts
 * // Debounce search input (wait 300ms for user to stop typing)
 * const debouncedSearch = debounce((query: string) => {
 *   performSearch(query);
 * }, 300);
 *
 * inputElement.addEventListener('input', (e) => {
 *   debouncedSearch((e.target as HTMLInputElement).value);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Debounce window resize handler
 * const debouncedResize = debounce(() => {
 *   updateLayout();
 * }, 200);
 *
 * window.addEventListener('resize', debouncedResize);
 * ```
 *
 * @note The debounced function discards return values from the original function.
 *       Only use debounce for fire-and-forget operations or side effects.
 */
type DebouncedFunction<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel: () => void;
  flush: () => void;
};

export function debounce<Args extends unknown[], Return>(
  func: (...args: Args) => Return,
  wait: number
): DebouncedFunction<Args> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;

  const cancel = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    lastArgs = null;
  };

  const flush = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!lastArgs) {
      return;
    }

    const args = lastArgs;
    lastArgs = null;
    func(...args);
  };

  const debounced = (...args: Args): void => {
    lastArgs = args;

    // Clear existing timer if function called again before delay elapsed
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    // Schedule function invocation after delay
    timeoutId = setTimeout(() => {
      timeoutId = null;
      flush();
    }, wait);
  };

  debounced.cancel = cancel;
  debounced.flush = flush;

  return debounced;
}
